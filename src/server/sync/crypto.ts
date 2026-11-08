import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import {
  SYNC_PROTOCOL_VERSION,
  assertObjectKey,
  type SyncAad,
  type SyncEnvelope,
  type SyncEvent,
  type VaultRef,
} from './transport';

/**
 * 端到端加密（E2EE）：云端永远只见密文。
 *
 * 密钥体系刻意与「登录账号/密码」解耦：启用同步时本地生成一次性恢复码，
 * 另一台设备输入同一恢复码即可加入同一个 vault；改登录密码不影响同步密钥，
 * 也不需要邮箱找回（ROADMAP 里公开注册仍暂不实施）。
 *
 *   scrypt(恢复码, salt) → masterKey
 *     ├─ HKDF info=vault-id  → vaultId（云端只认这个随机 ID）
 *     ├─ HKDF info=auth      → authKey（设备授权；云端只存 sha256）
 *     ├─ HKDF info=enc      → encKey（AES-256-GCM 事件与 blob）
 *     └─ HKDF info=mac      → macKey（HMAC 派生 objectKey）
 *
 * salt 可公开，且**默认由恢复码自身确定性派生**：另一台设备只需抄一串恢复码就能
 * 派生出同一个 vaultId 并加入 vault，不用再抄第二串 salt，也不需要云端账号。
 * 云端另存一份 salt 只是为了让客户端核对「恢复码与 vault 是否匹配」。
 * 显式传 saltBase64 的旧签名保留给离线包 / 历史测试，行为完全不变。
 * 恢复码与派生出的 key 绝不落库、绝不出本机。
 */

const INFO = {
  salt: 'career-agent/v1/salt',
  vaultId: 'career-agent/v1/vault-id',
  auth: 'career-agent/v1/auth',
  enc: 'career-agent/v1/enc',
  mac: 'career-agent/v1/mac',
  blob: 'career-agent/v1/blob:',
} as const;

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SHA256_RE = /^[0-9a-f]{64}$/;

export interface VaultKeys extends VaultRef {
  /** base64，可公开；默认由恢复码确定性派生，云端另存一份供加入时核对。 */
  salt: string;
  authKey: Buffer;
  encKey: Buffer;
  macKey: Buffer;
}

/** 32 字节随机 → 8 组 8 位 hex，便于手抄到另一台设备。 */
export function generateRecoveryCode(): string {
  const hex = randomBytes(32).toString('hex');
  return (hex.match(/.{8}/g) || []).join('-');
}

/** 容错：忽略连字符/空格/大小写，只保留 hex。 */
export function normalizeRecoveryCode(input: string): string {
  const hex = String(input || '')
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '');
  if (hex.length !== 64) throw new Error('恢复码必须是 64 位十六进制（8 组 × 8 位）');
  return hex;
}

function hkdf(master: Buffer, salt: Buffer, info: string, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', master, salt, Buffer.from(info, 'utf8'), length));
}

/**
 * 由恢复码确定性派生公开 salt（16 字节）。
 * 用整个恢复码做输入，salt 不会等于密钥前缀；公开它不降低 scrypt 强度。
 * 这是「只抄一串恢复码即可跨设备加入」的关键。
 */
export function recoveryCodeSalt(recoveryCode: string): Buffer {
  const code = normalizeRecoveryCode(recoveryCode);
  return createHash('sha256').update(INFO.salt).update('\0').update(code, 'utf8').digest().subarray(0, 16);
}

/** 一次性成本约几十毫秒；只在启用同步 / 另一台设备加入时调用。 */
export function deriveVaultKeys(recoveryCode: string, saltBase64?: string): VaultKeys {
  const code = normalizeRecoveryCode(recoveryCode);
  const salt = saltBase64 ? Buffer.from(saltBase64, 'base64') : recoveryCodeSalt(code);
  if (salt.length !== 16) throw new Error('salt 必须是 16 字节');
  const master = scryptSync(code, salt, 32, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return {
    vaultId: hkdf(master, salt, INFO.vaultId, 16).toString('hex'),
    salt: salt.toString('base64'),
    authKey: hkdf(master, salt, INFO.auth, 32),
    encKey: hkdf(master, salt, INFO.enc, 32),
    macKey: hkdf(master, salt, INFO.mac, 32),
  };
}

/** 云端只存这个哈希；设备注册时在 TLS 内提交 authKey 由云端比对。 */
export function authVerifier(keys: VaultKeys): string {
  return createHash('sha256').update(keys.authKey).digest('hex');
}

export function verifyAuthKey(keys: VaultKeys, provided: Buffer): boolean {
  return provided.length === keys.authKey.length && timingSafeEqual(provided, keys.authKey);
}

/**
 * 云端 object key：HMAC(userKey, sha256(明文))。
 * 同一用户重复上传同一文件仍得到同一 key（去重保留），
 * 但云端无法由 key 反推明文，也无法跨 vault 关联同一份文件。
 */
export function blobObjectKey(keys: VaultKeys, sha256: string): string {
  if (!SHA256_RE.test(sha256 || '')) throw new Error('非法 sha256');
  return createHmac('sha256', keys.macKey).update(INFO.blob + sha256).digest('hex');
}

function seal(keys: VaultKeys, aadText: string, plain: Buffer): { nonce: string; ciphertext: string } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keys.encKey, nonce);
  cipher.setAAD(Buffer.from(aadText, 'utf8'));
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { nonce: nonce.toString('base64'), ciphertext: body.toString('base64') };
}

function open(keys: VaultKeys, aadText: string, nonce: string, ciphertext: string): Buffer {
  const n = Buffer.from(nonce, 'base64');
  const body = Buffer.from(ciphertext, 'base64');
  if (n.length !== NONCE_BYTES || body.length <= TAG_BYTES) throw new Error('密文格式非法');
  const tag = body.subarray(body.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', keys.encKey, n);
  decipher.setAAD(Buffer.from(aadText, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]);
}

export interface SealEventOptions {
  deviceId: string;
  batchId: string;
  index: number;
  createdAt?: string;
}

/** 事件明文 → 可上云的密文封包。seq 留空，由 transport.push 分配。 */
export function sealEvent(keys: VaultKeys, event: SyncEvent, opts: SealEventOptions): SyncEnvelope {
  const aad: SyncAad = {
    v: SYNC_PROTOCOL_VERSION,
    vaultId: keys.vaultId,
    deviceId: opts.deviceId,
    batchId: opts.batchId,
    index: opts.index,
    createdAt: opts.createdAt || new Date().toISOString(),
  };
  const aadText = JSON.stringify(aad);
  const { nonce, ciphertext } = seal(keys, aadText, Buffer.from(JSON.stringify(event), 'utf8'));
  return {
    v: SYNC_PROTOCOL_VERSION,
    vaultId: keys.vaultId,
    deviceId: opts.deviceId,
    seq: '',
    aad: aadText,
    nonce,
    ciphertext,
    bytes: Buffer.byteLength(ciphertext, 'utf8'),
  };
}

/** 密文 → 事件明文。vaultId / deviceId / AAD 任一被改动都会抛错。 */
export function openEvent(
  keys: VaultKeys,
  envelope: SyncEnvelope
): { aad: SyncAad; event: SyncEvent } {
  if (envelope.v !== SYNC_PROTOCOL_VERSION) throw new Error(`不支持的同步协议版本: ${envelope.v}`);
  if (envelope.vaultId !== keys.vaultId) throw new Error('封包 vaultId 与本地密钥不匹配');
  const aad = JSON.parse(envelope.aad) as SyncAad;
  if (
    aad.v !== SYNC_PROTOCOL_VERSION ||
    aad.vaultId !== keys.vaultId ||
    aad.deviceId !== envelope.deviceId
  ) {
    throw new Error('封包 AAD 校验失败：可能被篡改或跨 vault 重放');
  }
  const plain = open(keys, envelope.aad, envelope.nonce, envelope.ciphertext);
  const event = JSON.parse(plain.toString('utf8')) as SyncEvent;
  if (!event || typeof event.entity !== 'string' || typeof event.entityId !== 'string' ||
      (event.op !== 'upsert' && event.op !== 'delete')) {
    throw new Error('事件明文结构非法');
  }
  return { aad, event };
}

/** blob 字节：AAD 绑定 objectKey，防止把 A 的密文挂到 B 的 key 上。 */
export function sealBlob(keys: VaultKeys, sha256: string, plain: Buffer): Buffer {
  const key = assertObjectKey(blobObjectKey(keys, sha256));
  const { nonce, ciphertext } = seal(keys, INFO.blob + key, plain);
  return Buffer.concat([Buffer.from(nonce, 'base64'), Buffer.from(ciphertext, 'base64')]);
}

export function openBlob(keys: VaultKeys, sha256: string, sealed: Buffer): Buffer {
  const key = assertObjectKey(blobObjectKey(keys, sha256));
  if (sealed.length <= NONCE_BYTES + TAG_BYTES) throw new Error('blob 密文格式非法');
  const nonce = sealed.subarray(0, NONCE_BYTES).toString('base64');
  const body = sealed.subarray(NONCE_BYTES).toString('base64');
  return open(keys, INFO.blob + key, nonce, body);
}
