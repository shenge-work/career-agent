/**
 * Worker 侧协议常量（零依赖，可独立打包到 Cloudflare Workers）。
 *
 * 刻意不与主项目 src/server/sync/transport.ts 共享文件：Worker 目录可以整包拷出去部署，
 * 不能反向依赖本地安装包。两端常量由 test/cloudflare-sync.e2e.test.ts 的一致性断言兜底，
 * 改动时必须同步修改两处。
 *
 * 云端是「哑管道」：这里没有任何解密逻辑，也不理解 SyncEvent 的业务结构，
 * 只知道 seq / vaultId / objectKey / 密文封包的形状。
 */

export const SYNC_PROTOCOL_VERSION = 1;
export const SEQ_WIDTH = 20;
export const INITIAL_SEQ = '0'.repeat(SEQ_WIDTH);

export const VAULT_ID_RE = /^[0-9a-f]{32}$/;
export const OBJECT_KEY_RE = /^[0-9a-f]{64}$/;
/** 授权头：authKey 的 64 位 hex；云端只存 sha256(authKey)。 */
export const AUTH_KEY_RE = /^[0-9a-f]{64}$/;
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const SEQ_RE = new RegExp(`^\\d{${SEQ_WIDTH}}$`);

/** 单批与单条上限：避免一个请求吃满 D1 / Worker 内存。 */
export const MAX_BATCH = 200;
export const MAX_ENVELOPE_BYTES = 512 * 1024;
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
export const DEFAULT_PULL_LIMIT = 200;
export const MAX_PULL_LIMIT = 500;
/** 本地附件上限 20MB，加密后留 5MB 余量。 */
export const MAX_BLOB_BYTES = 25 * 1024 * 1024;

export function formatSeq(value: bigint): string {
  if (value < 0n) throw new Error('seq 不能为负数');
  const s = value.toString().padStart(SEQ_WIDTH, '0');
  if (s.length > SEQ_WIDTH) throw new Error('seq 溢出');
  return s;
}

export function parseSeq(value: string): bigint {
  if (!SEQ_RE.test(value || '')) throw new Error(`非法 seq: ${value}`);
  return BigInt(value);
}

export function nextSeq(value: string): string {
  return formatSeq(parseSeq(value) + 1n);
}

/** 批内第 offset 条（offset 从 1 开始）应分配的 seq。 */
export function seqAt(base: string, offset: number): string {
  return formatSeq(parseSeq(base) + BigInt(offset));
}

export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headSeq?: string
  ) {
    super(message);
    this.name = 'SyncHttpError';
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function errorBody(err: SyncHttpError): Record<string, unknown> {
  const body: Record<string, unknown> = {
    error: err.message,
    code: err.code,
    v: SYNC_PROTOCOL_VERSION,
  };
  if (err.headSeq) body.headSeq = err.headSeq;
  return body;
}

export function isBase64(value: unknown, maxBytes: number): value is string {
  if (typeof value !== 'string' || !value || value.length > maxBytes) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return value.length % 4 === 0;
}
