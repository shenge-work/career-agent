import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createCloudBaseHandler,
  type CloudBaseHandler,
} from '../cloud/sync-cloudbase/src/app';
import {
  CloudBaseSyncStore,
  type TcbCollectionLike,
  type TcbDatabaseLike,
  type TcbQueryLike,
  type TcbStorageLike,
  type TcbTransactionLike,
} from '../cloud/sync-cloudbase/src/cloudbase-store';
import {
  DEFAULT_ORIGIN,
  pathToV1,
  toCloudBaseHttpEvent,
  toCloudBaseHttpResponse,
  toWebRequest,
  type CloudBaseHttpEvent,
} from '../cloud/sync-cloudbase/src/gateway';
import {
  CloudBaseTransport,
  cloudBaseConfigFromEnv,
} from '../src/server/sync/cloudbase-transport';
import { CloudflareTransport } from '../src/server/sync/cloudflare-transport';
import { MemorySyncStore } from '../cloud/sync-worker/src/store';
import { handleSyncRequest } from '../cloud/sync-worker/src/handler';
import {
  authVerifier,
  blobObjectKey,
  deriveVaultKeys,
  generateRecoveryCode,
  openBlob,
  openEvent,
  sealBlob,
  sealEvent,
  type VaultKeys,
} from '../src/server/sync/crypto';
import { OfflinePackTransport } from '../src/server/sync/offline-pack';
import {
  formatSeq,
  INITIAL_SEQ,
  SeqConflictError,
  SYNC_PROTOCOL_VERSION,
  type SyncEvent,
} from '../src/server/sync/transport';

/**
 * 腾讯云 CloudBase 通道端到端：零账号、零网络。
 *
 * 生产 CloudBaseSyncStore + 内存版云数据库/云存储替身 → 真实 createCloudBaseHandler
 * → 网关事件转换 → 注入 CloudBaseTransport，跑真实 E2EE 推拉与 blob 往返。
 * 同时验证网关事件形状与 Cloudflare / 离线包两种通道的协议契约一致。
 */

const BASE = 'https://sync.example.test';
const PREFIX = '/sync-api';
const CODE = generateRecoveryCode();
const keys: VaultKeys = deriveVaultKeys(CODE);
const SHA = 'b'.repeat(64);

type Row = Record<string, unknown>;

/** 内存版 CloudBase 云数据库：实现 runTransaction 的快照隔离 / 失败回滚与 gt 查询。 */
class MemoryTcbDatabase implements TcbDatabaseLike {
  readonly collections = new Map<string, Map<string, Row>>();
  transactionCalls = 0;
  /** 模拟写冲突：下一次事务直接抛错，验证 Store 按 CAS 失败处理且不落半批。 */
  failNextTransaction = false;

  private coll(name: string): Map<string, Row> {
    let map = this.collections.get(name);
    if (!map) {
      map = new Map();
      this.collections.set(name, map);
    }
    return map;
  }

  rows(name: string): Row[] {
    return Array.from(this.coll(name).values()).map((row) => ({ ...row }));
  }

  private snapshot(): Map<string, Map<string, Row>> {
    return new Map(
      Array.from(this.collections, ([name, rows]) => [
        name,
        new Map(Array.from(rows, ([id, row]) => [id, { ...row }])),
      ])
    );
  }

  private restore(snapshot: Map<string, Map<string, Row>>): void {
    this.collections.clear();
    for (const [name, rows] of snapshot) this.collections.set(name, new Map(rows));
  }

  private doc(name: string, id: string) {
    const rows = this.coll(name);
    return {
      get: async () => ({ data: rows.has(id) ? { ...rows.get(id)! } : null }),
      set: async (data: Row) => {
        rows.set(id, { ...data });
      },
      update: async (data: Row) => {
        rows.set(id, { ...(rows.get(id) || {}), ...data });
      },
    };
  }

  private query(name: string, condition: Row): TcbQueryLike {
    const matches = Array.from(this.coll(name).entries())
      .map(([id, row]) => ({ _id: id, ...row }))
      .filter((row) =>
        Object.entries(condition).every(([field, expected]) => {
          if (expected && typeof expected === 'object' && '__gt' in (expected as Row)) {
            return String(row[field]) > String((expected as Row).__gt);
          }
          return row[field] === expected;
        })
      );
    let sortField = '';
    let direction: 'asc' | 'desc' = 'asc';
    let max = 1000;
    const query: TcbQueryLike = {
      orderBy(field, dir) {
        sortField = field;
        direction = dir;
        return query;
      },
      limit(n) {
        max = n;
        return query;
      },
      async get() {
        let list = matches;
        if (sortField) {
          list = [...matches].sort((a, b) => {
            const cmp = String(a[sortField]) < String(b[sortField]) ? -1 : 1;
            return direction === 'asc' ? cmp : -cmp;
          });
        }
        return { data: list.slice(0, max).map((row) => ({ ...row })) };
      },
    };
    return query;
  }

  collection(name: string): TcbCollectionLike {
    return {
      doc: (id) => this.doc(name, id),
      where: (condition) => this.query(name, condition),
    };
  }

  async runTransaction<T>(fn: (tx: TcbTransactionLike) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    if (this.failNextTransaction) {
      this.failNextTransaction = false;
      throw new Error('simulated transaction write conflict');
    }
    const snapshot = this.snapshot();
    try {
      return await fn({
        collection: (name) => ({
          doc: (id) => this.doc(name, id),
          where: () => {
            throw new Error('事务内不支持 where');
          },
        }),
      });
    } catch (err) {
      this.restore(snapshot);
      throw err;
    }
  }

  gt(value: string): unknown {
    return { __gt: value };
  }
}

class MemoryTcbStorage implements TcbStorageLike {
  readonly files = new Map<string, Uint8Array>();
  uploadCount = 0;

  async uploadFile(opts: { cloudPath: string; fileContent: Uint8Array }) {
    this.uploadCount += 1;
    this.files.set(opts.cloudPath, new Uint8Array(opts.fileContent));
    return { fileID: `file:${opts.cloudPath}` };
  }

  async downloadFile(opts: { fileID: string }) {
    const cloudPath = opts.fileID.replace(/^file:/, '');
    const bytes = this.files.get(cloudPath);
    if (!bytes) throw new Error('云存储文件不存在');
    return { fileContent: new Uint8Array(bytes) };
  }
}

interface Setup {
  db: MemoryTcbDatabase;
  storage: MemoryTcbStorage;
  store: CloudBaseSyncStore;
  handler: CloudBaseHandler;
  fetchImpl: typeof fetch;
  transport: CloudBaseTransport;
}

/** 把标准 Request 伪装成网关事件，再把网关响应还原成 Response，走完整入口。 */
function fetchFromHandler(handler: CloudBaseHandler): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const event = await toCloudBaseHttpEvent(new Request(url, init));
    const result = await handler(event);
    const body = result.isBase64Encoded
      ? Buffer.from(result.body, 'base64')
      : result.body;
    return new Response(body, { status: result.statusCode, headers: result.headers });
  }) as typeof fetch;
}

async function setup(opts: { pathPrefix?: string; vaultKeys?: VaultKeys } = {}): Promise<Setup> {
  const db = new MemoryTcbDatabase();
  const storage = new MemoryTcbStorage();
  const store = new CloudBaseSyncStore(db, storage);
  const handler = createCloudBaseHandler({ store });
  const fetchImpl = fetchFromHandler(handler);
  const transport = await CloudBaseTransport.createVault({
    baseUrl: BASE,
    pathPrefix: opts.pathPrefix,
    keys: opts.vaultKeys || keys,
    deviceId: 'device-A',
    fetchImpl,
  });
  return { db, storage, store, handler, fetchImpl, transport };
}

function sampleEvent(overrides: Partial<SyncEvent> = {}): SyncEvent {
  return {
    localCursor: '00000170000000000.000000',
    entity: 'resumes',
    entityId: 'res_abc',
    op: 'upsert',
    rowHlc: '00000170000000001.000002',
    deviceId: 'device-A',
    row: { id: 'res_abc', title: '深圳 · AI 工程师简历', hlc: '00000170000000001.000002' },
    blobKeys: [],
    ...overrides,
  };
}

function batch(events: SyncEvent[], vaultKeys: VaultKeys = keys) {
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

describe('CloudBase 网关事件适配', () => {
  it('任意函数路径前缀都被剥到 /v1，找不到时原样返回', () => {
    expect(pathToV1('/sync-api/v1/vaults/abc/head')).toBe('/v1/vaults/abc/head');
    expect(pathToV1('/a/b/v1/vaults')).toBe('/v1/vaults');
    expect(pathToV1('/v1/health')).toBe('/v1/health');
    expect(pathToV1('/v1')).toBe('/v1');
    expect(pathToV1('/v123/bad')).toBe('/v123/bad');
    expect(pathToV1('/sync-api/other')).toBe('/sync-api/other');
  });

  it('base64 二进制 body 还原成原始字节，query 与头不丢', async () => {
    const sealed = Buffer.from([0, 1, 2, 250, 255, 128]);
    const event: CloudBaseHttpEvent = {
      httpMethod: 'PUT',
      path: `${PREFIX}/v1/vaults/${keys.vaultId}/blobs/${'c'.repeat(64)}?unused=1`,
      headers: { 'content-type': 'application/octet-stream', 'x-ca-blob-bytes': '6' },
      queryStringParameters: { since: '00000000000000000001' },
      body: sealed.toString('base64'),
      isBase64Encoded: true,
    };
    const request = toWebRequest(event);
    expect(request.method).toBe('PUT');
    expect(new URL(request.url).pathname).toBe(`/v1/vaults/${keys.vaultId}/blobs/${'c'.repeat(64)}`);
    expect(new URL(request.url).searchParams.get('since')).toBe('00000000000000000001');
    expect(request.headers.get('x-ca-blob-bytes')).toBe('6');
    const buf = await request.arrayBuffer();
    expect(Buffer.from(buf).equals(sealed)).toBe(true);
  });

  it('二进制响应回传 base64，JSON 响应回传 UTF-8', async () => {
    const binary = await toCloudBaseHttpResponse(
      new Response(Uint8Array.from([0, 255, 128]), {
        headers: { 'content-type': 'application/octet-stream' },
      })
    );
    expect(binary.isBase64Encoded).toBe(true);
    expect(Buffer.from(binary.body, 'base64').equals(Buffer.from([0, 255, 128]))).toBe(true);

    const json = await toCloudBaseHttpResponse(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    );
    expect(json.isBase64Encoded).toBe(false);
    expect(json.body).toBe('{"ok":true}');
  });

  it('标准 Request 可反向伪装成网关事件（本地联调用）', async () => {
    const request = new Request(`${DEFAULT_ORIGIN}${PREFIX}/v1/vaults/x/events?since=00000000000000000001&limit=2`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ca-auth': 'a'.repeat(64) },
      body: JSON.stringify({ expectedSeq: INITIAL_SEQ }),
    });
    const event = await toCloudBaseHttpEvent(request);
    expect(event.httpMethod).toBe('POST');
    expect(event.path).toBe(`${PREFIX}/v1/vaults/x/events`);
    expect(event.queryStringParameters).toEqual({ since: '00000000000000000001', limit: '2' });
    expect(event.body).toBe('{"expectedSeq":"00000000000000000000"}');
    expect(event.headers?.['x-ca-auth']).toBe('a'.repeat(64));
  });
});

describe('CloudBaseSyncStore 事务语义', () => {
  it('建 vault 幂等且绝不覆盖 authHash；head 初始为空游标', async () => {
    const db = new MemoryTcbDatabase();
    const store = new CloudBaseSyncStore(db, new MemoryTcbStorage());
    const created = await store.createVault({
      vaultId: keys.vaultId,
      authHash: authVerifier(keys),
      salt: keys.salt,
      createdAt: '2026-11-09T00:00:00.000Z',
    });
    expect(created.created).toBe(true);
    expect(await store.headSeq(keys.vaultId)).toBe(INITIAL_SEQ);

    const again = await store.createVault({
      vaultId: keys.vaultId,
      authHash: 'f'.repeat(64),
      salt: 'tampered',
      createdAt: '2026-11-09T01:00:00.000Z',
    });
    expect(again.created).toBe(false);
    expect((await store.getVault(keys.vaultId))!.authHash).toBe(authVerifier(keys));
    expect((await store.getVault(keys.vaultId))!.salt).toBe(keys.salt);
  });

  it('CAS 落后游标整批拒绝；事务写冲突时事件与 head 都不留下脏数据', async () => {
    const { db, store } = await setup();
    const first = await store.appendEvents(keys.vaultId, INITIAL_SEQ, [
      { seq: formatSeq(1n), deviceId: 'device-A', aad: '{}', nonce: 'x', ciphertext: 'y', bytes: 1 },
    ]);
    expect(first.ok).toBe(true);
    expect(await store.headSeq(keys.vaultId)).toBe(formatSeq(1n));

    const stale = await store.appendEvents(keys.vaultId, INITIAL_SEQ, [
      { seq: formatSeq(2n), deviceId: 'device-A', aad: '{}', nonce: 'x', ciphertext: 'z', bytes: 1 },
    ]);
    expect(stale.ok).toBe(false);
    expect(stale.actual).toBe(formatSeq(1n));

    db.failNextTransaction = true;
    const conflict = await store.appendEvents(keys.vaultId, formatSeq(1n), [
      { seq: formatSeq(2n), deviceId: 'device-A', aad: '{}', nonce: 'x', ciphertext: 'z', bytes: 1 },
      { seq: formatSeq(3n), deviceId: 'device-A', aad: '{}', nonce: 'x', ciphertext: 'z', bytes: 1 },
    ]);
    expect(conflict.ok).toBe(false);
    expect(await store.headSeq(keys.vaultId)).toBe(formatSeq(1n));
    expect(db.rows('ca_events')).toHaveLength(1);

    const retry = await store.appendEvents(keys.vaultId, formatSeq(1n), [
      { seq: formatSeq(2n), deviceId: 'device-A', aad: '{}', nonce: 'x', ciphertext: 'z', bytes: 1 },
    ]);
    expect(retry.nextSeq).toBe(formatSeq(2n));
    const list = await store.listEvents(keys.vaultId, formatSeq(1n), 10);
    expect(list.map((r) => r.seq)).toEqual([formatSeq(2n)]);
  });

  it('blob 重传幂等：只上传一次，跨 vault 隔离', async () => {
    const { storage, store } = await setup();
    const objectKey = blobObjectKey(keys, SHA);
    const sealed = sealBlob(keys, SHA, Buffer.from('附件密文'));
    await store.putBlob(keys.vaultId, objectKey, sealed);
    await store.putBlob(keys.vaultId, objectKey, sealed);
    expect(storage.uploadCount).toBe(1);
    expect(await store.hasBlob(keys.vaultId, objectKey)).toBe(true);
    expect(Buffer.from((await store.getBlob(keys.vaultId, objectKey))!).equals(sealed)).toBe(true);
    expect(await store.hasBlob('f'.repeat(32), objectKey)).toBe(false);
    await expect(store.getBlob(keys.vaultId, '../evil')).rejects.toThrow(/非法 objectKey/);
  });
});

describe('CloudBaseTransport 端到端（含函数路径前缀）', () => {
  it('health / vault 注册 / 授权：云端只有 authKey 哈希与公开 salt', async () => {
    const { db, transport } = await setup({ pathPrefix: PREFIX });
    expect(transport.kind).toBe('cloudbase');
    expect(await transport.ping()).toEqual({ ok: true, v: SYNC_PROTOCOL_VERSION });
    expect((await transport.head()).seq).toBe(INITIAL_SEQ);
    const row = db.rows('ca_vaults')[0];
    expect(row.authHash).toBe(authVerifier(keys));
    expect(row.authHash).not.toBe(keys.authKey.toString('hex'));
    expect(row.salt).toBe(keys.salt);
    expect(db.rows('ca_devices').some((r) => r.deviceId === 'device-A')).toBe(true);
  });

  it('push → 云数据库只有密文 → pull 解密还原中文整行，seq 严格递增', async () => {
    const { db, transport } = await setup({ pathPrefix: PREFIX });
    const events = [
      sampleEvent(),
      sampleEvent({ entityId: 'res_def', op: 'delete', row: null, rowHlc: null }),
      sampleEvent({ entityId: 'res_ghi', row: { id: 'res_ghi', title: '全栈后端简历' } }),
    ];
    const pushed = await transport.push(batch(events), INITIAL_SEQ);
    expect(pushed).toEqual({ accepted: 3, nextSeq: formatSeq(3n) });
    expect((await transport.head()).seq).toBe(formatSeq(3n));

    const stored = db.rows('ca_events');
    expect(stored).toHaveLength(3);
    expect(JSON.stringify(stored)).not.toContain('深圳');
    expect(JSON.stringify(stored)).not.toContain('全栈后端简历');
    expect(String(stored[0].aad)).not.toContain('"seq"');

    const pulled = await transport.pull(INITIAL_SEQ);
    expect(pulled.nextSeq).toBe(formatSeq(3n));
    expect(openEvent(keys, pulled.envelopes[0]).event.row?.title).toBe('深圳 · AI 工程师简历');
    expect(openEvent(keys, pulled.envelopes[1]).event.op).toBe('delete');
    expect((await transport.pull(pulled.nextSeq)).envelopes).toHaveLength(0);
  });

  it('CAS 冲突抛 SeqConflictError 且不产生半批事件', async () => {
    const { db, transport } = await setup();
    await transport.push([single()], INITIAL_SEQ);
    await expect(
      transport.push([single(sampleEvent({ entityId: 'late' }))], INITIAL_SEQ)
    ).rejects.toBeInstanceOf(SeqConflictError);
    expect(db.rows('ca_events')).toHaveLength(1);
    const retry = await transport.push(
      [single(sampleEvent({ entityId: 'late' }))],
      (await transport.head()).seq
    );
    expect(retry.nextSeq).toBe(formatSeq(2n));
  });

  it('分页拉取按 seq 严格递增推进断点续传游标', async () => {
    const { transport } = await setup();
    await transport.push(
      batch(Array.from({ length: 5 }, (_, i) => sampleEvent({ entityId: `r${i}` }))),
      INITIAL_SEQ
    );
    let cursor = INITIAL_SEQ;
    const seen: string[] = [];
    for (let page = 0; page < 4; page += 1) {
      const result = await transport.pull(cursor, 2);
      seen.push(...result.envelopes.map((e) => e.seq));
      if (!result.envelopes.length) break;
      cursor = result.nextSeq;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5].map((n) => formatSeq(n)));
  });

  it('只凭恢复码加入：salt 核对、设备注册、A → B → A 双向推拉', async () => {
    const { fetchImpl, transport: deviceA } = await setup({ pathPrefix: PREFIX });
    await deviceA.push(
      [single(sampleEvent({ row: { id: 'res_abc', title: '来自 A' } }))],
      INITIAL_SEQ
    );

    const deviceB = await CloudBaseTransport.joinVault({
      baseUrl: BASE,
      pathPrefix: PREFIX,
      recoveryCode: CODE,
      deviceId: 'device-B',
      fetchImpl,
    });
    expect(deviceB.vaultId).toBe(keys.vaultId);
    const pulled = await deviceB.pull(INITIAL_SEQ);
    expect(openEvent(keys, pulled.envelopes[0]).event.row?.title).toBe('来自 A');

    const fromB = sealEvent(keys, sampleEvent({ entityId: 'from-B' }), {
      deviceId: 'device-B',
      batchId: 'batch-B',
      index: 0,
    });
    const pushed = await deviceB.push([fromB], (await deviceB.head()).seq);
    expect(pushed.nextSeq).toBe(formatSeq(2n));
    expect(openEvent(keys, (await deviceA.pull(formatSeq(1n))).envelopes[0]).event.entityId).toBe(
      'from-B'
    );
  });

  it('错误 authKey 401；恢复码错误提示 vault 不存在', async () => {
    const { fetchImpl } = await setup();
    const wrong: VaultKeys = { ...keys, authKey: Buffer.alloc(32, 9) };
    await expect(
      CloudBaseTransport.attach({
        baseUrl: BASE,
        keys: wrong,
        deviceId: 'device-evil',
        fetchImpl,
      })
    ).rejects.toThrow(/401|unauthorized/);
    await expect(
      CloudBaseTransport.joinVault({
        baseUrl: BASE,
        recoveryCode: generateRecoveryCode(),
        deviceId: 'device-X',
        fetchImpl,
      })
    ).rejects.toThrow(/vault 不存在/);
  });

  it('加密 blob 上传 / 探测 / 下载往返字节一致，跨 vault 隔离', async () => {
    const { storage, fetchImpl, transport } = await setup({ pathPrefix: PREFIX });
    const objectKey = blobObjectKey(keys, SHA);
    const sealed = sealBlob(keys, SHA, Buffer.from('career-agent 加密附件 · 腾讯云'));
    expect(await transport.hasBlob(objectKey)).toBe(false);
    await transport.putBlob(objectKey, Readable.from([sealed]), sealed.length);
    expect(await transport.hasBlob(objectKey)).toBe(true);
    const downloaded = await collect(await transport.getBlob(objectKey));
    expect(downloaded.equals(sealed)).toBe(true);
    expect(openBlob(keys, SHA, downloaded).toString('utf8')).toBe('career-agent 加密附件 · 腾讯云');
    await transport.putBlob(objectKey, Readable.from([sealed]), sealed.length);
    expect(storage.uploadCount).toBe(1);

    const otherKeys = deriveVaultKeys(generateRecoveryCode());
    await CloudBaseTransport.createVault({
      baseUrl: BASE,
      pathPrefix: PREFIX,
      keys: otherKeys,
      deviceId: 'device-C',
      fetchImpl,
    });
    const deviceC = await CloudBaseTransport.attach({
      baseUrl: BASE,
      pathPrefix: PREFIX,
      keys: otherKeys,
      deviceId: 'device-C',
      fetchImpl,
    });
    expect(await deviceC.hasBlob(objectKey)).toBe(false);
    await expect(deviceC.getBlob(objectKey)).rejects.toThrow(/blob_not_found/);
  });
});

describe('通道契约与配置', () => {
  it('同一批事件走 CloudBase / Cloudflare / 离线包：seq 与拉取结果同构', async () => {
    const { transport } = await setup();
    const cloudStore = new MemorySyncStore();
    const cloudFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return handleSyncRequest(new Request(url, init), { store: cloudStore });
    }) as typeof fetch;
    const cf = await CloudflareTransport.createVault({
      baseUrl: BASE,
      keys,
      deviceId: 'device-A',
      fetchImpl: cloudFetch,
    });
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'ca-cb-'));
    try {
      const pack = await OfflinePackTransport.create(tmp, keys.vaultId);
      const events = [sampleEvent({ entityId: 'r1' }), sampleEvent({ entityId: 'r2' })];
      const cbResult = await transport.push(batch(events), INITIAL_SEQ);
      const cfResult = await cf.push(batch(events), INITIAL_SEQ);
      const packResult = await pack.push(batch(events), INITIAL_SEQ);
      expect(cbResult).toEqual(cfResult);
      expect(cbResult).toEqual(packResult);
      const pulled = await transport.pull(INITIAL_SEQ);
      expect(pulled.envelopes.map((e) => e.seq)).toEqual(
        (await cf.pull(INITIAL_SEQ)).envelopes.map((e) => e.seq)
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('环境变量只含端点信息，缺地址或非法前缀一律拒绝', () => {
    expect(
      cloudBaseConfigFromEnv({
        TCB_SYNC_BASE_URL: 'https://env.ap-shanghai.app.tcloudbase.com',
        TCB_SYNC_PATH_PREFIX: '/sync-api',
      })
    ).toEqual({
      baseUrl: 'https://env.ap-shanghai.app.tcloudbase.com',
      pathPrefix: '/sync-api',
      extraHeaders: undefined,
    });
    expect(() => cloudBaseConfigFromEnv({})).toThrow(/TCB_SYNC_BASE_URL/);
    expect(() =>
      cloudBaseConfigFromEnv({ TCB_SYNC_BASE_URL: BASE, TCB_SYNC_PATH_PREFIX: '/../evil' })
    ).toThrow(/路径前缀非法/);
    expect(() =>
      cloudBaseConfigFromEnv({ TCB_SYNC_BASE_URL: BASE, TCB_SYNC_EXTRA_HEADERS: 'not-json' })
    ).toThrow(/合法 JSON/);
    expect(() =>
      cloudBaseConfigFromEnv({ TCB_SYNC_BASE_URL: BASE, TCB_SYNC_EXTRA_HEADERS: '{"x":1}' })
    ).toThrow(/字符串/);
  });
});
