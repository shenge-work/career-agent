import { Readable } from 'node:stream';
import { Agent, fetch as undiciFetch } from 'undici';
import {
  assertObjectKey,
  INITIAL_SEQ,
  nextSeq,
  SeqConflictError,
  SYNC_PROTOCOL_VERSION,
  type SyncEnvelope,
  type SyncPullResult,
  type SyncPushResult,
  type SyncTransport,
} from './transport';
import { authVerifier, deriveVaultKeys, type VaultKeys } from './crypto';

/**
 * 厂商无关的 HTTP 哑云客户端：Cloudflare、腾讯云 CloudBase、自建 NestJS 都走这一个类。
 *
 * 服务端跑的是同一套 /v1 协议（cloud/sync-worker/src/handler.ts），差别只有：
 *   · 访问域名；
 *   · HTTP 访问服务的函数路径前缀（CloudBase 常见 /sync-api，服务端会自动剥离）；
 *   · 网关要求的额外请求头。
 * 因此把协议逻辑抽到这里，各厂商只留一层薄壳（kind + 静态工厂 + 默认值）。
 *
 * 这里**不做任何加解密**：封包由 crypto.ts 产出、由 SyncEngine 解开，
 * 本类只负责授权、seq 分配结果回写、断点续传游标与密文字节搬运。
 */

/** 本地附件上限 20MB，加密后留余量；与 Worker protocol.ts 的 MAX_BLOB_BYTES 一致。 */
export const MAX_SYNC_BLOB_BYTES = 25 * 1024 * 1024;

export interface RemoteTransportOptions {
  /** https://<域名>；本地测试允许 http 回环。禁止 userinfo。 */
  baseUrl: string;
  keys: VaultKeys;
  deviceId: string;
  /** 测试注入；生产用 Node 22 内置 fetch。 */
  fetchImpl?: typeof fetch;
  /** 网关函数路径前缀，如 /sync-api；服务端 pathToV1() 会剥离，无需两边对齐。 */
  pathPrefix?: string;
  /** 网关要求的自定义头；核心 x-ca-* 头会被过滤，不允许覆盖。 */
  extraHeaders?: Record<string, string>;
  /**
   * 临时跳过 TLS 证书校验（仅用于自签名证书的自建服务，且必须是 https）。
   * 作用于本传输实例的 fetch，不影响进程内其他请求；正式域名 + 受信证书时务必关闭。
   */
  insecureTls?: boolean;
}

export interface RemoteJoinOptions {
  baseUrl: string;
  /** 另一台设备只抄这一串恢复码即可加入；salt 由恢复码确定性派生。 */
  recoveryCode: string;
  deviceId: string;
  fetchImpl?: typeof fetch;
  pathPrefix?: string;
  extraHeaders?: Record<string, string>;
  /** 同 RemoteTransportOptions.insecureTls，加入设备时也可能需要。 */
  insecureTls?: boolean;
}

export interface VaultInfo {
  vaultId: string;
  salt: string;
  headSeq: string;
  createdAt: string;
  v: number;
}

/** 这些头由本类签发，禁止网关注入的额外头覆盖，否则授权/长度校验会被绕过。 */
const RESERVED_HEADERS = new Set([
  'accept',
  'content-type',
  'content-length',
  'host',
  'x-ca-auth',
  'x-ca-device',
  'x-ca-blob-bytes',
]);

/** 与 Worker 保持一致的入站校验（服务端还会再校一次，别只信客户端）。 */
export function normalizeBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('同步地址非法');
  }
  if (url.username || url.password) throw new Error('同步地址不允许携带 userinfo');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('同步地址必须使用 https（本地测试可 http 回环）');
  }
  if (url.search || url.hash) throw new Error('同步地址不允许带查询串或 fragment');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function normalizePathPrefix(input?: string): string {
  if (!input) return '';
  const raw = input.trim();
  // 只允许 /a/b 形式的静态路径段：挡住 ..、query、协议串与任意拼接
  if (!/^\/[A-Za-z0-9_-]*(?:\/[A-Za-z0-9_-]+)*$/.test(raw)) {
    throw new Error('同步路径前缀非法');
  }
  return raw.replace(/\/+$/, '');
}

/** 子类静态工厂共用：仅凭恢复码派生密钥并构造实例。 */
export function createJoinInstance<T extends RemoteSyncTransport>(
  ctor: new (opts: RemoteTransportOptions) => T,
  opts: RemoteJoinOptions
): T {
  return new ctor({
    baseUrl: opts.baseUrl,
    keys: deriveVaultKeys(opts.recoveryCode),
    deviceId: opts.deviceId,
    fetchImpl: opts.fetchImpl,
    pathPrefix: opts.pathPrefix,
    extraHeaders: opts.extraHeaders,
    insecureTls: opts.insecureTls,
  });
}

export class RemoteSyncTransport implements SyncTransport {
  /** 显式标注 string，子类才能覆盖成自己的通道名（否则字面量类型会冲突）。 */
  readonly kind: string = 'remote';

  protected readonly base: string;
  protected readonly prefix: string;
  protected readonly fetchImpl: typeof fetch;
  private readonly extraHeaders: Record<string, string>;

  constructor(protected readonly opts: RemoteTransportOptions) {
    this.base = normalizeBaseUrl(opts.baseUrl);
    this.prefix = normalizePathPrefix(opts.pathPrefix);
    let fetchImpl = opts.fetchImpl || globalThis.fetch.bind(globalThis);
    if (opts.insecureTls) {
      // 自签名证书：仅对本传输的 fetch 关闭证书校验，不影响进程内其他请求。
      const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });
      const base = fetchImpl;
      fetchImpl = ((input: any, init?: any) =>
        undiciFetch(input, { ...init, dispatcher: insecureAgent })) as unknown as typeof fetch;
    }
    this.fetchImpl = fetchImpl;
    this.extraHeaders = {};
    for (const [key, value] of Object.entries(opts.extraHeaders || {})) {
      if (RESERVED_HEADERS.has(key.toLowerCase())) continue;
      this.extraHeaders[key] = value;
    }
  }

  get vaultId(): string {
    return this.opts.keys.vaultId;
  }

  get deviceId(): string {
    return this.opts.deviceId;
  }

  /** 第一台设备：创建 vault。同 vaultId 已存在时服务端拒绝，绝不允许重置授权哈希。 */
  protected async bootstrapCreate(): Promise<void> {
    await this.call('POST', '/v1/vaults', {
      auth: false, // 创建时只提交哈希，不把 authKey 发到云端
      json: {
        vaultId: this.vaultId,
        authHash: authVerifier(this.opts.keys),
        salt: this.opts.keys.salt,
        deviceId: this.opts.deviceId,
      },
    });
  }

  /** 另一台设备：仅凭恢复码加入，并核对云端 salt 与本地派生是否一致。 */
  protected async bootstrapJoin(): Promise<void> {
    const info = await this.vaultInfo();
    if (info.v !== SYNC_PROTOCOL_VERSION) {
      throw new Error(`云端协议版本 ${info.v} 与本地 ${SYNC_PROTOCOL_VERSION} 不一致`);
    }
    if (info.salt !== this.opts.keys.salt) {
      throw new Error('云端 salt 与恢复码派生结果不一致：可能加入了错误的 vault');
    }
    await this.registerDevice();
  }

  /** 同一设备重启后已知密钥，直接附着并校验授权。 */
  protected async bootstrapAttach(): Promise<void> {
    await this.head();
  }

  /**
   * 启用同步的统一入口：vault 不存在则创建（第一台设备），已存在则核对 salt
   * 并注册设备（另一台设备加入）。返回实际发生的模式，供 UI 提示。
   */
  async setupVault(): Promise<'created' | 'joined'> {
    try {
      await this.bootstrapCreate();
      await this.registerDevice();
      return 'created';
    } catch (err) {
      // 协议错误码 vault_exists：同一恢复码派生同一 vaultId，改走加入路径
      if (!String((err as Error)?.message || '').includes('vault_exists')) throw err;
    }
    await this.bootstrapJoin();
    return 'joined';
  }

  private url(path: string): string {
    return `${this.base}${this.prefix}${path}`;
  }

  private authHeaders(): Record<string, string> {
    return {
      ...this.extraHeaders,
      // authKey 只在 TLS 请求头里出现；云端保存的只是 sha256(authKey)
      'x-ca-auth': this.opts.keys.authKey.toString('hex'),
      'x-ca-device': this.opts.deviceId,
    };
  }

  private async call(
    method: string,
    path: string,
    opts: {
      json?: unknown;
      raw?: Uint8Array;
      auth?: boolean;
      expectedSeq?: string;
    } = {}
  ): Promise<Response> {
    const headers: Record<string, string> = { ...this.extraHeaders, accept: 'application/json' };
    if (opts.auth !== false) Object.assign(headers, this.authHeaders());
    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    if (opts.raw) {
      headers['content-type'] = 'application/octet-stream';
      headers['x-ca-blob-bytes'] = String(opts.raw.length);
      body = opts.raw as unknown as BodyInit;
    }
    const res = await this.fetchImpl(this.url(path), { method, headers, body });
    if (res.ok) return res;

    let payload: { error?: string; code?: string; headSeq?: string } = {};
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      // 非 JSON 错误（网关 / 502 等）按状态码兜底
    }
    if (res.status === 409 && payload.code === 'seq_conflict' && opts.expectedSeq) {
      throw new SeqConflictError(opts.expectedSeq, payload.headSeq || '');
    }
    if (res.status === 404 && payload.code === 'vault_not_found') {
      throw new Error('vault 不存在：恢复码可能不对，或第一台设备尚未创建同步');
    }
    throw new Error(
      `同步服务 ${res.status}${payload.code ? ` ${payload.code}` : ''}: ${payload.error || res.statusText}`
    );
  }

  /** 部署自检：不需要授权。 */
  async ping(): Promise<{ ok: boolean; v: number }> {
    const res = await this.fetchImpl(this.url('/v1/health'), { headers: this.extraHeaders });
    if (!res.ok) throw new Error(`同步服务不可达：HTTP ${res.status}`);
    return (await res.json()) as { ok: boolean; v: number };
  }

  async vaultInfo(): Promise<VaultInfo> {
    const res = await this.call('GET', `/v1/vaults/${this.vaultId}`);
    return (await res.json()) as VaultInfo;
  }

  async registerDevice(): Promise<void> {
    await this.call('POST', `/v1/vaults/${this.vaultId}/devices`, {
      json: { deviceId: this.opts.deviceId },
    });
  }

  async head(): Promise<{ seq: string }> {
    const res = await this.call('GET', `/v1/vaults/${this.vaultId}/head`);
    const payload = (await res.json()) as { seq: string };
    if (!/^\d{20}$/.test(payload.seq || '')) throw new Error('云端返回的 head seq 非法');
    return { seq: payload.seq };
  }

  async push(envelopes: SyncEnvelope[], expectedSeq: string): Promise<SyncPushResult> {
    if (!/^\d{20}$/.test(expectedSeq || '')) throw new Error('expectedSeq 必须是 20 位定长数字');
    for (const envelope of envelopes) {
      if (envelope.vaultId !== this.vaultId) throw new Error('封包 vaultId 与本地密钥不匹配');
      if (envelope.v !== SYNC_PROTOCOL_VERSION) throw new Error('封包协议版本不匹配');
    }
    const res = await this.call('POST', `/v1/vaults/${this.vaultId}/events`, {
      json: { expectedSeq, envelopes },
      expectedSeq,
    });
    const result = (await res.json()) as SyncPushResult;
    if (result.accepted !== envelopes.length || !/^\d{20}$/.test(result.nextSeq || '')) {
      throw new Error('云端 push 返回值与本地批次不一致');
    }
    // 与 OfflinePackTransport.push 行为一致：把服务端分配的 seq 回写到封包对象
    let cursor = expectedSeq;
    for (const envelope of envelopes) {
      cursor = nextSeq(cursor);
      envelope.seq = cursor;
    }
    if (envelopes.length && result.nextSeq !== cursor) {
      throw new Error('云端 nextSeq 与本地推算不一致：拒绝推进游标');
    }
    return result;
  }

  async pull(sinceSeq: string, limit = 200): Promise<SyncPullResult> {
    const since = sinceSeq || INITIAL_SEQ;
    if (!/^\d{20}$/.test(since)) throw new Error('sinceSeq 必须是 20 位定长数字');
    const res = await this.call(
      'GET',
      `/v1/vaults/${this.vaultId}/events?since=${encodeURIComponent(since)}&limit=${Math.min(Math.max(1, limit), 500)}`
    );
    const result = (await res.json()) as SyncPullResult;
    if (!Array.isArray(result.envelopes)) throw new Error('云端 pull 返回格式非法');
    // seq 完整性靠「严格递增且与 nextSeq 吻合」校验——它刻意不进 AAD（服务端分配 seq 后不能改写密文）
    let cursor = since;
    for (const envelope of result.envelopes) {
      const expected = nextSeq(cursor);
      if (envelope.seq !== expected || envelope.vaultId !== this.vaultId) {
        throw new Error(`云端事件序号不连续：期望 ${expected}，收到 ${envelope.seq}`);
      }
      cursor = envelope.seq;
    }
    if (result.envelopes.length && result.nextSeq !== cursor) {
      throw new Error('云端 pull 的 nextSeq 与最后一条事件不一致');
    }
    return result;
  }

  async putBlob(objectKey: string, stream: Readable, bytes: number): Promise<void> {
    assertObjectKey(objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array | string));
    const sealed = Buffer.concat(chunks);
    if (sealed.length !== bytes) throw new Error('blob 字节数与声明不一致');
    if (!sealed.length || sealed.length > MAX_SYNC_BLOB_BYTES) throw new Error('blob 为空或超过 25MB');
    await this.call('PUT', `/v1/vaults/${this.vaultId}/blobs/${objectKey}`, { raw: sealed });
  }

  async getBlob(objectKey: string): Promise<Readable> {
    assertObjectKey(objectKey);
    const res = await this.call('GET', `/v1/vaults/${this.vaultId}/blobs/${objectKey}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    return Readable.from([bytes]);
  }

  async hasBlob(objectKey: string): Promise<boolean> {
    assertObjectKey(objectKey);
    const res = await this.fetchImpl(this.url(`/v1/vaults/${this.vaultId}/blobs/${objectKey}`), {
      method: 'HEAD',
      headers: this.authHeaders(),
    });
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    throw new Error(`探测云端 blob 失败：HTTP ${res.status}`);
  }

  async deleteBlob(objectKey: string): Promise<void> {
    assertObjectKey(objectKey);
    const res = await this.call('DELETE', `/v1/vaults/${this.vaultId}/blobs/${objectKey}`);
    // 204 成功 / 404 已不存在都视作完成（幂等）
    if (res.status !== 204 && res.status !== 404) {
      throw new Error(`删除云端 blob 失败：HTTP ${res.status}`);
    }
  }
}
