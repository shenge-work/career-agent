import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import {
  authVerifier,
  blobObjectKey,
  deriveVaultKeys,
  generateRecoveryCode,
  normalizeRecoveryCode,
  openBlob,
  openEvent,
  sealBlob,
  sealEvent,
  verifyAuthKey,
} from '../src/server/sync/crypto';
import { OfflinePackTransport } from '../src/server/sync/offline-pack';
import {
  assertObjectKey,
  formatSeq,
  INITIAL_SEQ,
  nextSeq,
  OBJECT_KEY_RE,
  parseSeq,
  SeqConflictError,
  type SyncEvent,
} from '../src/server/sync/transport';

const CODE = generateRecoveryCode();
const SALT = Buffer.alloc(16, 7).toString('base64');
const keys = deriveVaultKeys(CODE, SALT);
const SHA = 'a'.repeat(64);

const tmpDirs: string[] = [];
async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ca-pack-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (tmpDirs.length) await rm(tmpDirs.pop()!, { recursive: true, force: true });
});

function sampleEvent(overrides: Partial<SyncEvent> = {}): SyncEvent {
  return {
    localCursor: '00000170000000000.000000',
    entity: 'resumes',
    entityId: 'res_abc',
    op: 'upsert',
    rowHlc: '00000170000000001.000002',
    deviceId: 'device-A',
    row: { id: 'res_abc', user_id: 'u-1', title: 'AI 工程师简历', hlc: '00000170000000001.000002' },
    blobKeys: [],
    ...overrides,
  };
}

function envelope(event = sampleEvent(), index = 0) {
  return sealEvent(keys, event, { deviceId: 'device-A', batchId: 'batch-1', index });
}

describe('同步序号', () => {
  it('定长十进制，字典序等于数值序', () => {
    expect(formatSeq(0)).toBe(INITIAL_SEQ);
    expect(formatSeq(0)).toHaveLength(20);
    expect(nextSeq(formatSeq(9)) > formatSeq(9)).toBe(true);
    expect(formatSeq(10) > formatSeq(9)).toBe(true);
    expect(nextSeq(formatSeq(0))).toBe('00000000000000000001');
    expect(parseSeq(nextSeq(formatSeq(999)))).toBe(1000n);
  });

  it('拒绝负数、溢出与非数字', () => {
    expect(() => formatSeq(-1)).toThrow();
    expect(() => formatSeq(BigInt('1' + '0'.repeat(20)))).toThrow();
    expect(() => parseSeq('../etc/passwd')).toThrow();
  });
});

describe('恢复码与密钥派生', () => {
  it('格式容错且归一化幂等', () => {
    expect(normalizeRecoveryCode(CODE)).toBe(CODE.replace(/-/g, ''));
    const messy = CODE.toUpperCase().replace(/-/g, ' ');
    expect(normalizeRecoveryCode(messy)).toBe(normalizeRecoveryCode(CODE));
    expect(() => normalizeRecoveryCode('short')).toThrow();
  });

  it('同一恢复码 + salt 派生同一 vault，salt 或码变化即隔离', () => {
    const again = deriveVaultKeys(normalizeRecoveryCode(CODE), SALT);
    expect(again.vaultId).toBe(keys.vaultId);
    expect(again.encKey.equals(keys.encKey)).toBe(true);
    expect(deriveVaultKeys(CODE, Buffer.alloc(16, 8).toString('base64')).vaultId).not.toBe(keys.vaultId);
    expect(deriveVaultKeys(generateRecoveryCode(), SALT).vaultId).not.toBe(keys.vaultId);
    expect(keys.vaultId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('云端只拿哈希，验证不泄露派生密钥', () => {
    expect(authVerifier(keys)).toMatch(/^[0-9a-f]{64}$/);
    expect(authVerifier(keys)).toBe(authVerifier(deriveVaultKeys(CODE, SALT)));
    expect(verifyAuthKey(keys, keys.authKey)).toBe(true);
    expect(verifyAuthKey(keys, Buffer.alloc(32))).toBe(false);
  });

  it('object key 由 HMAC 派生：同用户去重、跨用户不可关联', () => {
    const k1 = blobObjectKey(keys, SHA);
    expect(k1).toMatch(OBJECT_KEY_RE);
    expect(assertObjectKey(k1)).toBe(k1);
    expect(blobObjectKey(keys, SHA)).toBe(k1);
    expect(blobObjectKey(deriveVaultKeys(generateRecoveryCode(), SALT), SHA)).not.toBe(k1);
    expect(() => blobObjectKey(keys, '../../etc')).toThrow();
  });
});

describe('事件封包 E2EE', () => {
  it('往返还原完整业务行，AAD 不含云端 seq', () => {
    const env = envelope();
    expect(env.seq).toBe('');
    expect(env.aad).not.toContain('"seq"');
    expect(JSON.parse(env.aad).vaultId).toBe(keys.vaultId);
    const { event, aad } = openEvent(keys, env);
    expect(event.entity).toBe('resumes');
    expect(event.row?.title).toBe('AI 工程师简历');
    expect(aad.index).toBe(0);
    expect(env.ciphertext).not.toContain('AI 工程师');
  });

  it('篡改密文 / AAD / vaultId / deviceId / nonce 全部拒绝', () => {
    const base = envelope();
    const tamper = (patch: Record<string, unknown>) => ({ ...base, ...patch });
    const brokenCipher = Buffer.from(base.ciphertext, 'base64');
    brokenCipher[5] ^= 0xff;
    const cases = [
      tamper({ ciphertext: brokenCipher.toString('base64') }),
      tamper({ aad: base.aad.replace(keys.vaultId, 'f'.repeat(32)) }),
      tamper({ vaultId: 'f'.repeat(32) }),
      tamper({ deviceId: 'device-evil' }),
      tamper({ nonce: Buffer.alloc(12).toString('base64') }),
      tamper({ v: 2 }),
    ];
    for (const bad of cases) expect(() => openEvent(keys, bad as any)).toThrow();
  });

  it('另一台设备用错恢复码打不开', () => {
    const wrong = deriveVaultKeys(generateRecoveryCode(), SALT);
    expect(() => openEvent(wrong, envelope())).toThrow();
  });

  it('delete 事件与空 row 也能正确还原', () => {
    const env = envelope(sampleEvent({ op: 'delete', row: null, rowHlc: null }), 3);
    expect(openEvent(keys, env).event.op).toBe('delete');
    expect(openEvent(keys, env).event.row).toBeNull();
  });
});

describe('blob 密文', () => {
  it('往返一致，AAD 绑定 objectKey', () => {
    const plain = Buffer.from('career-agent blob payload');
    const sealed = sealBlob(keys, SHA, plain);
    expect(sealed.includes(plain)).toBe(false);
    expect(openBlob(keys, SHA, sealed).equals(plain)).toBe(true);
    expect(() => openBlob(keys, 'b'.repeat(64), sealed)).toThrow();
    const broken = Buffer.from(sealed);
    broken[20] ^= 0xff;
    expect(() => openBlob(keys, SHA, broken)).toThrow();
  });
});

describe('离线增量包 transport', () => {
  it('create / push / pull 游标严格递增，且服务端可分配 seq', async () => {
    const pack = await OfflinePackTransport.create(await tmpDir(), keys.vaultId);
    expect((await pack.head()).seq).toBe(INITIAL_SEQ);

    const batch = [envelope(sampleEvent(), 0), envelope(sampleEvent({ entityId: 'res_def' }), 1)];
    const pushed = await pack.push(batch, INITIAL_SEQ);
    expect(pushed).toEqual({ accepted: 2, nextSeq: '00000000000000000002' });
    expect(batch.map((e) => e.seq)).toEqual([
      '00000000000000000001',
      '00000000000000000002',
    ]);

    const pulled = await pack.pull(INITIAL_SEQ);
    expect(pulled.envelopes).toHaveLength(2);
    expect(pulled.nextSeq).toBe('00000000000000000002');
    expect(pulled.envelopes.every((e, i) => i === 0 || pulled.envelopes[i - 1].seq < e.seq)).toBe(true);
    // seq 由 transport 补上后，密文依然可解（AAD 不含 seq 的收益）
    expect(openEvent(keys, pulled.envelopes[1]).event.entityId).toBe('res_def');
    expect((await pack.pull(pulled.nextSeq)).envelopes).toHaveLength(0);
    expect((await pack.info()).events).toBe(2);
  });

  it('CAS 冲突：落后游标必须拒绝，不产生脏事件', async () => {
    const pack = await OfflinePackTransport.create(await tmpDir(), keys.vaultId);
    await pack.push([envelope()], INITIAL_SEQ);
    await expect(pack.push([envelope()], INITIAL_SEQ)).rejects.toBeInstanceOf(SeqConflictError);
    expect((await pack.info()).events).toBe(1);
    const ok = await pack.push([envelope()], '00000000000000000001');
    expect(ok.nextSeq).toBe('00000000000000000002');
  });

  it('另一台设备 open 同一个包后能续拉增量', async () => {
    const dir = await tmpDir();
    const a = await OfflinePackTransport.create(dir, keys.vaultId);
    await a.push([envelope()], INITIAL_SEQ);
    const b = await OfflinePackTransport.open(dir);
    expect(b.vaultId).toBe(keys.vaultId);
    expect((await b.pull('00000000000000000001')).envelopes).toHaveLength(0);
    await b.push([envelope(sampleEvent({ entityId: 'from-B' }))], (await b.head()).seq);
    const a2 = await OfflinePackTransport.open(dir);
    const pulled = await a2.pull('00000000000000000001');
    expect(pulled.envelopes).toHaveLength(1);
    expect(openEvent(keys, pulled.envelopes[0]).event.entityId).toBe('from-B');
  });

  it('blob 流式读写、幂等重传、路径穿越拒绝', async () => {
    const pack = await OfflinePackTransport.create(await tmpDir(), keys.vaultId);
    const key = assertObjectKey(blobObjectKey(keys, SHA));
    const sealed = sealBlob(keys, SHA, Buffer.from('hello cloud'));
    expect(await pack.hasBlob(key)).toBe(false);

    await pack.putBlob(key, Readable.from([sealed]), sealed.length);
    expect(await pack.hasBlob(key)).toBe(true);
    const chunks: Buffer[] = [];
    for await (const c of await pack.getBlob(key)) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).equals(sealed)).toBe(true);

    // 同 key 重传（中断重试）不新增文件
    await pack.putBlob(key, Readable.from([sealed]), sealed.length);
    expect((await pack.info()).blobs).toBe(1);

    await expect(pack.putBlob('../evil', Readable.from([sealed]), sealed.length)).rejects.toThrow();
    await expect(pack.getBlob('../evil')).rejects.toThrow();
  });

  it('跨 vault 的包不能混用', async () => {
    const pack = await OfflinePackTransport.create(await tmpDir(), keys.vaultId);
    const wrong = deriveVaultKeys(generateRecoveryCode(), SALT);
    await expect(pack.push([sealEvent(wrong, sampleEvent(), {
      deviceId: 'device-A', batchId: 'b', index: 0,
    })], INITIAL_SEQ)).rejects.toThrow();
  });
});
