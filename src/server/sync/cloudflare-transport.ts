import { Readable } from 'node:stream';
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
 * Cloudflare Workers + D1 + R2 的客户端适配器（SyncTransport 的云端实现）。
 *
 * 与 OfflinePackTransport 平级：SyncEngine 只认接口，换云厂商不动业务代码。
 * 这里也**不做任何加解密**——封包由 crypto.ts 产出、由 SyncEngine 解开，
 * 本类只负责授权、seq 分配结果回写、断点续传游标与密文字节搬运。
 *
 * 部署端见 cloud/sync-worker/；本地无云账号时用 MemorySyncStore + 注入 fetch
 * 即可跑完整协议（test/cloudflare-sync.e2e.test.ts）。
 */

/** 本地附件上限 20MB，加密后留余量；与 Worker protocol.ts 的 MAX_BLOB_BYTES 一致。 */
export const MAX_SYNC_BLOB_BYTES = 25 * 1024 * 1024;

export interface CloudflareTransportOptions {
  /** https://<域名>；本地测试允许 http 回环。禁止 userinfo。 */
  baseUrl: string;
  keys: VaultKeys;
  deviceId: string;
  /** 测试注入；生产用 Node 22 内置 fetch。 */
  fetchImpl?: typeof fetch;
}

export interface JoinVaultOptions {
  baseUrl: string;
  /** 另一台设备只抄这一串恢复码即可加入；salt 由恢复码确定性派生。 */
  recoveryCode: string;
  deviceId: string;
  fetchImpl?: typeof fetch;
}

export interface VaultInfo {
  vaultId: string;
  salt: string;
  headSeq: string;
  createdAt: string;
  v: number;
}

/** 与 Worker 保持一致的入站校验（服务端还会再校一次，别只信客户端）。 */
function normalizeBaseUrl(input: string): string {
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

export class CloudflareTransport implements SyncTransport {
  readonly kind = 'cloudflare';

  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  private constructor(private readonly opts: CloudflareTransportOptions) {
    this.base = normalizeBaseUrl(opts.baseUrl);
    this.fetchImpl = opts.fetchImpl || globalThis.fetch.bind(globalThis);
  }

  get vaultId(): string {
    return this.opts.keys.vaultId;
  }

  get deviceId(): string {
    return this.opts.deviceId;
  }

  /** 第一台设备：创建 vault。同 vaultId 已存在时服务端拒绝，绝不允许重置授权哈希。 */
  static async createVault(opts: CloudflareTransportOptions): Promise<CloudflareTransport> {
    const transport = new CloudflareTransport(opts);
    await transport.call('POST', '/v1/vaults', {
      auth: false, // 创建时只提交哈希，不把 authKey 发到云端
      json: {
        vaultId: transport.vaultId,
        authHash: authVerifier(opts.keys),
        salt: opts.keys.salt,
        deviceId: opts.deviceId,
      },
    });
    return transport;
  }

  /** 另一台设备：仅凭恢复码加入，并核对云端 salt 与本地派生是否一致。 */
  static async joinVault(opts: JoinVaultOptions): Promise<CloudflareTransport> {
    const keys = deriveVaultKeys(opts.recoveryCode);
    const transport = new CloudflareTransport({
      baseUrl: opts.baseUrl,
      keys,
      deviceId: opts.deviceId,
      fetchImpl: opts.fetchImpl,
    });
    const info = await transport.vaultInfo();
    if (info.v !== SYNC_PROTOCOL_VERSION) {
      throw new Error(`云端协议版本 ${info.v} 与本地 ${SYNC_PROTOCOL_VERSION} 不一致`);
    }
    if (info.salt !== keys.salt) {
      throw new Error('云端 salt 与恢复码派生结果不一致：可能加入了错误的 vault');
    }
    await transport.registerDevice();
    return transport;
  }

  /** 同一设备重启后已知密钥，直接附着并校验授权。 */
  static async attach(opts: CloudflareTransportOptions): Promise<CloudflareTransport> {
    const transport = new CloudflareTransport(opts);
    await transport.head();
    return transport;
  }

  private url(path: string): string {
    return `${this.base}${path}`;
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
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.auth !== false) {
      // authKey 只在 TLS 请求头里出现；云端保存的只是 sha256(authKey)
      headers['x-ca-auth'] = this.opts.keys.authKey.toString('hex');
      headers['x-ca-device'] = this.opts.deviceId;
    }
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
      // 非 JSON 错误（网关 / 521 等）按状态码兜底
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
    const res = await this.fetchImpl(this.url('/v1/health'));
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
      headers: { 'x-ca-auth': this.opts.keys.authKey.toString('hex'), 'x-ca-device': this.opts.deviceId },
    });
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    throw new Error(`探测云端 blob 失败：HTTP ${res.status}`);
  }
}
