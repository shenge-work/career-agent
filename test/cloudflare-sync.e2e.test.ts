import { afterEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleSyncRequest } from '../cloud/sync-worker/src/handler';
import { MemorySyncStore } from '../cloud/sync-worker/src/store';
import * as worker from '../cloud/sync-worker/src/protocol';
import { CloudflareTransport, MAX_SYNC_BLOB_BYTES } from '../src/server/sync/cloudflare-transport';
import {
  authVerifier,
  blobObjectKey,
  deriveVaultKeys,
  generateRecoveryCode,
  openBlob,
  openEvent,
  recoveryCodeSalt,
  sealBlob,
  sealEvent,
  type VaultKeys,
} from '../src/server/sync/crypto';
import { OfflinePackTransport } from '../src/server/sync/offline-pack';
import {
  formatSeq,
  INITIAL_SEQ,
  nextSeq,
  parseSeq,
  SeqConflictError,
  SYNC_PROTOCOL_VERSION,
  type SyncEvent,
} from '../src/server/sync/transport';

/**
 * 端到端：真实 CloudflareTransport → Worker handler（MemoryStore 冒充 D1+R2）→ 真实加解密。
 * 不需要 Cloudflare 账号、不需要网络；注入的 fetch 直接把 Request 交给 Worker 处理器。
 */

const BASE = 'https://sync.example.test';
const CODE = generateRecoveryCode();
const keys = deriveVaultKeys(CODE); // 新路径：salt 由恢复码确定性派生
const SHA = 'a'.repeat(64);

const tmpDirs: string[] = [];
async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ca-cloud-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (tmpDirs.length) await rm(tmpDirs.pop()!, { recursive: true, force: true });
});

function fetchFor(store: MemorySyncStore): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handleSyncRequest(new Request(url, init), { store });
  }) as typeof fetch;
}

async function setup(deviceId = 'device-A', vaultKeys: VaultKeys = keys) {
  const store = new MemorySyncStore();
  const fetchImpl = fetchFor(store);
  const transport = await CloudflareTransport.createVault({
    baseUrl: BASE,
    keys: vaultKeys,
    deviceId,
    fetchImpl,
  });
  return { store, fetchImpl, transport };
}

function sampleEvent(overrides: Partial<SyncEvent> = {}): SyncEvent {
  return {
    localCursor: '00000170000000000.000000',
    entity: 'resumes',
    entityId: 'res_abc',
    op: 'upsert',
    rowHlc: '00000170000000001.000002',
    deviceId: 'device-A',
    row: { id: 'res_abc', title: 'AI 工程师简历', hlc: '00000170000000001.000002' },
    blobKeys: [],
    ...overrides,
  };
}

/** 批内 AAD index 必须严格递增（Worker 会校验防重放）。 */
function batch(events: SyncEvent[], vaultKeys: VaultKeys = keys): ReturnType<typeof sealEvent>[] {
  return events.map((event, i) =>
    sealEvent(vaultKeys, event, { deviceId: 'device-A', batchId: 'batch-1', index: i })
  );
}

function single(event = sampleEvent(), vaultKeys: VaultKeys = keys) {
  return sealEvent(vaultKeys, event, { deviceId: 'device-A', batchId: 'batch-1', index: 0 });
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('恢复码自包含公开 salt', () => {
  it('同一恢复码派生同一 vault，无需第二串 salt；显式 salt 旧签名不变', () => {
    const again = deriveVaultKeys(CODE);
    expect(again.vaultId).toBe(keys.vaultId);
    expect(again.salt).toBe(keys.salt);
    expect(again.encKey.equals(keys.encKey)).toBe(true);
    expect(deriveVaultKeys(CODE, keys.salt).vaultId).toBe(keys.vaultId);
    expect(deriveVaultKeys(generateRecoveryCode(), keys.salt).vaultId).not.toBe(keys.vaultId);
    expect(recoveryCodeSalt(CODE).length).toBe(16);
    expect(keys.salt).not.toContain(CODE.slice(0, 8)); // 公开 salt 不是恢复码前缀
    // 历史行为：显式给 salt 时仍按该 salt 派生
    const legacySalt = Buffer.alloc(16, 7).toString('base64');
    expect(deriveVaultKeys(CODE, legacySalt).salt).toBe(legacySalt);
  });
});

describe('Worker 与本地协议常量一致', () => {
  it('版本、初始游标、seq 工具、objectKey 白名单两端同构', () => {
    expect(worker.SYNC_PROTOCOL_VERSION).toBe(SYNC_PROTOCOL_VERSION);
    expect(worker.INITIAL_SEQ).toBe(INITIAL_SEQ);
    expect(worker.formatSeq(123n)).toBe(formatSeq(123n));
    expect(worker.nextSeq(formatSeq(9))).toBe(nextSeq(formatSeq(9)));
    expect(worker.parseSeq(formatSeq(999)).toString()).toBe(parseSeq(formatSeq(999)).toString());
    expect(worker.seqAt(INITIAL_SEQ, 3)).toBe(formatSeq(3n));
    expect(worker.OBJECT_KEY_RE.test(blobObjectKey(keys, SHA))).toBe(true);
    expect(worker.MAX_BLOB_BYTES).toBe(MAX_SYNC_BLOB_BYTES);
  });
});

describe('vault 注册与授权', () => {
  it('创建后 head 为初始游标，云端只存 authKey 的哈希与公开 salt', async () => {
    const { store, fetchImpl, transport } = await setup();
    expect((await transport.head()).seq).toBe(INITIAL_SEQ);
    expect(await transport.ping()).toEqual({ ok: true, v: SYNC_PROTOCOL_VERSION });
    const row = store.vaults.get(keys.vaultId)!;
    expect(row.authHash).toBe(authVerifier(keys));
    expect(row.authHash).not.toBe(keys.authKey.toString('hex'));
    expect(row.salt).toBe(keys.salt);
    expect(store.devices.get(keys.vaultId)!.has('device-A')).toBe(true);
    expect((await transport.vaultInfo()).salt).toBe(keys.salt);
    // 未授权的健康检查不需要密钥
    const health = await fetchImpl(`${BASE}/v1/health`);
    expect(health.status).toBe(200);
  });

  it('同 vaultId 重复创建被拒，授权哈希不会被覆盖', async () => {
    const { store, fetchImpl } = await setup();
    const before = store.vaults.get(keys.vaultId)!.authHash;
    const impostor: VaultKeys = { ...keys, authKey: Buffer.alloc(32, 3) };
    await expect(
      CloudflareTransport.createVault({
        baseUrl: BASE,
        keys: impostor,
        deviceId: 'device-evil',
        fetchImpl,
      })
    ).rejects.toThrow(/409|vault_exists/);
    expect(store.vaults.get(keys.vaultId)!.authHash).toBe(before);
  });

  it('同 vaultId 但错误 authKey 一律 401', async () => {
    const { fetchImpl } = await setup();
    const wrong: VaultKeys = { ...keys, authKey: Buffer.alloc(32, 9) };
    await expect(
      CloudflareTransport.attach({ baseUrl: BASE, keys: wrong, deviceId: 'device-evil', fetchImpl })
    ).rejects.toThrow(/401|unauthorized/);
  });

  it('同步地址必须 https（或 http 回环），拒绝 userinfo', async () => {
    const { fetchImpl } = await setup();
    await expect(
      CloudflareTransport.attach({
        baseUrl: 'http://sync.example.test',
        keys,
        deviceId: 'device-A',
        fetchImpl,
      })
    ).rejects.toThrow(/https/);
    await expect(
      CloudflareTransport.attach({
        baseUrl: 'https://user:pass@sync.example.test',
        keys,
        deviceId: 'device-A',
        fetchImpl,
      })
    ).rejects.toThrow(/userinfo/);
  });
});

describe('加密事件推拉', () => {
  it('push → 云端只有密文 → pull 解密还原整行，seq 严格递增', async () => {
    const { store, transport } = await setup();
    const events = [
      sampleEvent(),
      sampleEvent({ entityId: 'res_def', op: 'delete', row: null, rowHlc: null }),
      sampleEvent({ entityId: 'res_ghi', row: { id: 'res_ghi', title: '全栈后端简历' } }),
    ];
    const envelopes = batch(events);
    const pushed = await transport.push(envelopes, INITIAL_SEQ);
    expect(pushed).toEqual({ accepted: 3, nextSeq: formatSeq(3n) });
    expect(envelopes.map((e) => e.seq)).toEqual([formatSeq(1n), formatSeq(2n), formatSeq(3n)]);
    expect((await transport.head()).seq).toBe(formatSeq(3n));

    const stored = store.events.get(keys.vaultId)!;
    expect(stored).toHaveLength(3);
    expect(JSON.stringify(stored)).not.toContain('AI 工程师简历');
    expect(JSON.stringify(stored)).not.toContain('全栈后端简历');
    expect(stored[0].aad).not.toContain('"seq"'); // seq 不进 AAD
    expect(stored[0].ciphertext).toBe(envelopes[0].ciphertext); // 云端原样保存

    const pulled = await transport.pull(INITIAL_SEQ);
    expect(pulled.envelopes).toHaveLength(3);
    expect(pulled.nextSeq).toBe(formatSeq(3n));
    expect(openEvent(keys, pulled.envelopes[0]).event.row?.title).toBe('AI 工程师简历');
    expect(openEvent(keys, pulled.envelopes[1]).event.op).toBe('delete');
    expect(openEvent(keys, pulled.envelopes[2]).event.entityId).toBe('res_ghi');
    expect((await transport.pull(pulled.nextSeq)).envelopes).toHaveLength(0);
  });

  it('CAS 冲突抛 SeqConflictError，不产生脏事件；pull 后用新游标可重试', async () => {
    const { store, transport } = await setup();
    await transport.push([single()], INITIAL_SEQ);
    await expect(transport.push([single(sampleEvent({ entityId: 'late' }))], INITIAL_SEQ)).rejects.toBeInstanceOf(
      SeqConflictError
    );
    expect(store.events.get(keys.vaultId)).toHaveLength(1);
    const head = (await transport.head()).seq;
    const retry = await transport.push([single(sampleEvent({ entityId: 'late' }))], head);
    expect(retry.nextSeq).toBe(formatSeq(2n));
    expect((await transport.pull(formatSeq(1n))).envelopes[0].seq).toBe(formatSeq(2n));
  });

  it('非法封包与非法游标全部被云端拒绝，且不写入事件', async () => {
    const { store, transport } = await setup();
    const badAad = single();
    badAad.aad = badAad.aad.replace(keys.vaultId, 'f'.repeat(32));
    const badDevice = single();
    badDevice.aad = badDevice.aad.replace('device-A', 'device-B');
    const badBytes = single();
    badBytes.bytes += 7;
    const badIndex = batch([sampleEvent(), sampleEvent({ entityId: 'r2' })]);
    badIndex[1].aad = badIndex[1].aad.replace('"index":1', '"index":0');
    const wrongVault = single(sampleEvent(), deriveVaultKeys(generateRecoveryCode()));

    const cases: Array<[unknown[], string]> = [
      [[badAad], INITIAL_SEQ],
      [[badDevice], INITIAL_SEQ],
      [[badBytes], INITIAL_SEQ],
      [badIndex, INITIAL_SEQ],
      [[wrongVault], INITIAL_SEQ],
      [[single()], 'not-a-seq'],
      [new Array(201).fill(single()), INITIAL_SEQ],
    ];
    for (const [envelopes, expectedSeq] of cases) {
      await expect(transport.push(envelopes as any, expectedSeq as string)).rejects.toThrow();
    }
    expect(store.events.get(keys.vaultId)).toHaveLength(0);
  });

  it('分页拉取与断点续传游标逐页推进', async () => {
    const { transport } = await setup();
    const events = Array.from({ length: 5 }, (_, i) => sampleEvent({ entityId: `r${i}` }));
    await transport.push(batch(events), INITIAL_SEQ);
    let cursor = INITIAL_SEQ;
    const seen: string[] = [];
    for (let page = 0; page < 4; page += 1) {
      const result = await transport.pull(cursor, 2);
      seen.push(...result.envelopes.map((e) => e.seq));
      if (!result.envelopes.length) break;
      cursor = result.nextSeq;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5].map((n) => formatSeq(n)));
    expect((await transport.pull(cursor, 2)).envelopes).toHaveLength(0);
  });

  it('云端事件序号被篡改（空洞）时客户端拒绝推进游标', async () => {
    const { store, transport } = await setup();
    await transport.push(batch([sampleEvent(), sampleEvent({ entityId: 'r2' })]), INITIAL_SEQ);
    store.events.get(keys.vaultId)![1].seq = formatSeq(9n);
    await expect(transport.pull(INITIAL_SEQ)).rejects.toThrow(/序号不连续/);
  });
});

describe('另一台设备加入', () => {
  it('只凭恢复码即可加入：salt 核对、设备注册、双向推拉', async () => {
    const { store, fetchImpl, transport: deviceA } = await setup();
    await deviceA.push([single(sampleEvent({ row: { id: 'res_abc', title: '来自 A' } }))], INITIAL_SEQ);

    const deviceB = await CloudflareTransport.joinVault({
      baseUrl: BASE,
      recoveryCode: CODE,
      deviceId: 'device-B',
      fetchImpl,
    });
    expect(deviceB.vaultId).toBe(keys.vaultId);
    expect(store.devices.get(keys.vaultId)!.has('device-B')).toBe(true);
    const pulled = await deviceB.pull(INITIAL_SEQ);
    expect(openEvent(keys, pulled.envelopes[0]).event.row?.title).toBe('来自 A');

    const fromB = sealEvent(keys, sampleEvent({ entityId: 'from-B' }), {
      deviceId: 'device-B',
      batchId: 'batch-B',
      index: 0,
    });
    const pushed = await deviceB.push([fromB], (await deviceB.head()).seq);
    expect(pushed.nextSeq).toBe(formatSeq(2n));
    const backOnA = await deviceA.pull(formatSeq(1n));
    expect(openEvent(keys, backOnA.envelopes[0]).event.entityId).toBe('from-B');
  });

  it('恢复码错误 → 友好提示；云端 salt 被替换 → 拒绝加入', async () => {
    const { store, fetchImpl } = await setup();
    await expect(
      CloudflareTransport.joinVault({
        baseUrl: BASE,
        recoveryCode: generateRecoveryCode(),
        deviceId: 'device-X',
        fetchImpl,
      })
    ).rejects.toThrow(/vault 不存在/);

    store.vaults.get(keys.vaultId)!.salt = Buffer.alloc(16, 1).toString('base64');
    await expect(
      CloudflareTransport.joinVault({
        baseUrl: BASE,
        recoveryCode: CODE,
        deviceId: 'device-X',
        fetchImpl,
      })
    ).rejects.toThrow(/salt/);
  });
});

describe('加密 blob 通道', () => {
  it('上传 / 探测 / 下载往返字节一致，重传幂等，非法 key 与跨 vault 均拒绝', async () => {
    const { store, fetchImpl, transport } = await setup();
    const objectKey = blobObjectKey(keys, SHA);
    const sealed = sealBlob(keys, SHA, Buffer.from('career-agent 加密附件'));
    expect(await transport.hasBlob(objectKey)).toBe(false);

    await transport.putBlob(objectKey, Readable.from([sealed]), sealed.length);
    expect(await transport.hasBlob(objectKey)).toBe(true);
    const downloaded = await collect(await transport.getBlob(objectKey));
    expect(downloaded.equals(sealed)).toBe(true);
    expect(openBlob(keys, SHA, downloaded).toString('utf8')).toBe('career-agent 加密附件');

    await transport.putBlob(objectKey, Readable.from([sealed]), sealed.length);
    expect(store.blobWrites).toBe(1);

    await expect(transport.hasBlob('../evil')).rejects.toThrow();
    await expect(
      transport.putBlob(objectKey, Readable.from([sealed]), sealed.length + 1)
    ).rejects.toThrow(/字节数与声明不一致/);

    const otherKeys = deriveVaultKeys(generateRecoveryCode());
    await CloudflareTransport.createVault({
      baseUrl: BASE,
      keys: otherKeys,
      deviceId: 'device-C',
      fetchImpl,
    });
    const deviceC = await CloudflareTransport.attach({
      baseUrl: BASE,
      keys: otherKeys,
      deviceId: 'device-C',
      fetchImpl,
    });
    expect(await deviceC.hasBlob(objectKey)).toBe(false);
    await expect(deviceC.getBlob(objectKey)).rejects.toThrow(/blob_not_found/);
  });
});

describe('云端与离线增量包契约一致', () => {
  it('同一批事件走两种 transport：seq / accepted / 拉取结果同构', async () => {
    const { transport } = await setup();
    const pack = await OfflinePackTransport.create(await tmpDir(), keys.vaultId);
    const events = [sampleEvent({ entityId: 'r1' }), sampleEvent({ entityId: 'r2' })];
    const forPack = batch(events);
    const forCloud = batch(events);

    const p = await pack.push(forPack, INITIAL_SEQ);
    const c = await transport.push(forCloud, INITIAL_SEQ);
    expect(c.accepted).toBe(p.accepted);
    expect(c.nextSeq).toBe(p.nextSeq);
    expect(forCloud.map((e) => e.seq)).toEqual(forPack.map((e) => e.seq));

    const pulledPack = await pack.pull(INITIAL_SEQ);
    const pulledCloud = await transport.pull(INITIAL_SEQ);
    expect(pulledCloud.nextSeq).toBe(pulledPack.nextSeq);
    expect(pulledCloud.envelopes.map((e) => e.seq)).toEqual(pulledPack.envelopes.map((e) => e.seq));
    expect(openEvent(keys, pulledCloud.envelopes[1]).event.entityId).toBe('r2');
  });
});
