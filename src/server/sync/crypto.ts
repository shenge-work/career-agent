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
 * 密钥体系（I1 改造后）：同步空间**绑定账号**。
 *
 *   恢复码 → scrypt(恢复码, salt) → masterKey
 *     ├─ HKDF info=vault-id(+账号因子)  → vaultId（云端只认这个随机 ID）
 *     ├─ HKDF info=auth(+账号因子)      → authKey（设备授权；云端只存 sha256）
 *     ├─ HKDF info=enc(+账号因子)       → encKey（AES-256-GCM 事件与 blob）
 *     └─ HKDF info=mac(+账号因子)       → macKey（HMAC 派生 objectKey）
 *
 * 账号因子 = normalizeAccountKey(email)。它是跨设备稳定的账号标识：每台设备有独立
 * 本地库、user_id 各不相同，只有邮箱在「同一账号的多台设备」上必然一致。
 * 云端只看到由 HKDF/HMAC 派生出的不透明 hex，没有恢复码就无法反推账号或邮箱，
 * 因此「云端零身份」的哑云语义不变。
 *
 * 两种派生并存：
 *   · v1（不传账号因子）——旧公式，字节级不变。存量 sync_state 里保存的密钥、
 *     以及离线增量包 / 历史测试全部沿用，保证升级零丢失；
 *   · v2（传账号因子）  ——新启用同步时使用。不同账号即使填完全相同的恢复码，
 *     也会派生出不同的 vaultId 与不同的加密密钥，云端数据互不干扰。
 *
 * accountScope = HMAC(encKey, 'scope\0'+账号因子)，随封包 AAD（不透明 hex）与
 * 事件明文一起走，用于「旧 vault 认领」与「拒绝跨账号事件回灌」两道校验。
 *
 * salt 可公开，且**默认由恢复码自身确定性派生**：另一台设备只需抄一串恢复码就能
 * 派生出同一套密钥并加入同一账号的同步空间。云端另存一份 salt 供客户端核对。
 * 恢复码与派生出的 key 绝不落库、绝不出本机。
 */

const INFO = {
  salt: 'career-agent/v1/salt',
  vaultId: 'career-agent/v1/vault-id',
  auth: 'career-agent/v1/auth',
  enc: 'career-agent/v1/enc',
  mac: 'career-agent/v1/mac',
  blob: 'career-agent/v1/blob:',
  scope: 'career-agent/v1/account-scope',
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
  /** 账号隔离指纹：HMAC(encKey, scope + 账号因子) 的不透明 hex，云端无法反推身份。 */
  accountScope?: string;
  /** 1 = 旧公式（存量兼容）；2 = 账号绑定派生。 */
  keyVersion?: 1 | 2;
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

/**
 * 账号因子的规范化：邮箱 trim + 小写。
 * 刻意不用本地 user.id —— 每台设备的本地库独立，同一个账号在不同设备上 user.id 不同，
 * 用它做派生会让「同账号跨设备同步」直接断链。
 */
export function normalizeAccountKey(input: string): string {
  const key = String(input || '').trim().toLowerCase();
  if (!key) throw new Error('账号因子不能为空');
  return key;
}

/**
 * 给任意一套密钥附加「账号隔离指纹」。指纹只依赖 encKey 与账号因子，
 * 不依赖恢复码，因此 run() 从 sync_state.keysJson 恢复密钥后也能重算（存量兼容的关键）。
 */
export function withAccountScope(keys: VaultKeys, accountKey: string): VaultKeys {
  const scope = createHmac('sha256', keys.encKey)
    .update(INFO.scope)
    .update('\0')
    .update(normalizeAccountKey(accountKey), 'utf8')
    .digest('hex')
    .slice(0, 32);
  return { ...keys, accountScope: scope };
}

function hkdf(master: Buffer, salt: Buffer, info: string, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', master, salt, Buffer.from(info, 'utf8'), length));
}

/**
 * 由恢复码确定性派生公开 salt（16 字节）。
 * 用整个恢复码做输入，salt 不会等于密钥前缀；公开它不降低 scrypt 强度。
 */
export function recoveryCodeSalt(recoveryCode: string): Buffer {
  const code = normalizeRecoveryCode(recoveryCode);
  return createHash('sha256').update(INFO.salt).update('\0').update(code, 'utf8').digest().subarray(0, 16);
}

/**
 * 一次性成本约几十毫秒；只在启用同步 / 另一台设备加入时调用。
 *
 * 第 3 个参数 accountKey 是 I1 新增的账号因子：
 *   · 不传 → 与旧版完全一致的派生结果（v1），存量 vault 与离线包零影响；
 *   · 传入 → HKDF info 追加账号因子（v2），不同账号同恢复码也得到不同 vaultId/密钥。
 */
export function deriveVaultKeys(
  recoveryCode: string,
  saltBase64?: string,
  accountKey?: string
): VaultKeys {
  const code = normalizeRecoveryCode(recoveryCode);
  const salt = saltBase64 ? Buffer.from(saltBase64, 'base64') : recoveryCodeSalt(code);
  if (salt.length !== 16) throw new Error('salt 必须是 16 字节');
  const master = scryptSync(code, salt, 32, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  // 账号因子只出现在 HKDF 的 info 里，v1 时 info 保持原样（字节级兼容）。
  const scopeSuffix = accountKey ? '\0' + normalizeAccountKey(accountKey) : '';
  const info = (base: string) => (accountKey ? base + scopeSuffix : base);
  return {
    vaultId: hkdf(master, salt, info(INFO.vaultId), 16).toString('hex'),
    salt: salt.toString('base64'),
    authKey: hkdf(master, salt, info(INFO.auth), 32),
    encKey: hkdf(master, salt, info(INFO.enc), 32),
    macKey: hkdf(master, salt, info(INFO.mac), 32),
    keyVersion: accountKey ? 2 : 1,
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
 * 云端 object key：HMAC(macKey, sha256(明文))。
 * 同一账号重复上传同一文件仍得到同一 key（去重保留），
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
    // 不透明 hex，云端可见但无法反推账号；用于旧 vault 认领与跨账号重放拦截。
    ...(keys.accountScope ? { accountScope: keys.accountScope } : {}),
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

/** 密文 → 事件明文。vaultId / deviceId / AAD / 账号指纹任一被改动都会抛错。 */
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
  // 存量升级前的事件没有 accountScope，允许通过（同 vault 的历史数据）。
  // 但只要双方都带指纹且不一致，就一定是跨账号重放，拒绝解封。
  if (keys.accountScope && aad.accountScope && aad.accountScope !== keys.accountScope) {
    throw new Error('封包账号隔离指纹不匹配：拒绝跨账号重放');
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
