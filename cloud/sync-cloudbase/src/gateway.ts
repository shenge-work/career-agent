/**
 * 腾讯云 CloudBase「HTTP 访问服务」事件 ↔ Web 标准 Request / Response 的适配层。
 *
 * 云函数收到的不是标准 Request，而是 API 网关事件（httpMethod / path / body /
 * queryStringParameters / isBase64Encoded），返回值也要是 {statusCode, headers, body}。
 * 这里做纯转换，业务逻辑一律复用 cloud/sync-worker/src/handler.ts 的
 * handleSyncRequest()——因此 Cloudflare 与腾讯云跑的是**同一套 /v1 协议**。
 *
 * 另一个细节：HTTP 访问服务会把函数路径（例如 /sync-api）带在 path 前面，
 * 而 handler 只认 /v1 开头。pathToV1() 负责剥掉任意前缀，客户端的
 * pathPrefix 因此可以自由配置，不需要服务端再配一份。
 */

export interface CloudBaseHttpEvent {
  httpMethod?: string;
  method?: string;
  path?: string;
  url?: string;
  headers?: Record<string, string>;
  queryStringParameters?: Record<string, string | string[] | undefined> | null;
  body?: string | Record<string, unknown> | null;
  isBase64Encoded?: boolean;
}

export interface CloudBaseHttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
}

/** handler 不读 host，这里只用来把相对路径补成合法 URL。 */
export const DEFAULT_ORIGIN = 'https://sync.invalid';

/** 从任意网关路径里截出 /v1 段；找不到时原样返回（handler 会规规矩矩给 404）。 */
export function pathToV1(rawPath: string): string {
  const clean = rawPath || '/';
  const match = /(^|\/)v1(?=\/|$)/.exec(clean);
  if (!match) return clean;
  const sliced = clean.slice(match.index);
  return sliced.startsWith('/') ? sliced : `/${sliced}`;
}

export function toWebRequest(event: CloudBaseHttpEvent, origin = DEFAULT_ORIGIN): Request {
  const method = String(event.httpMethod || event.method || 'GET').toUpperCase();
  const raw = String(event.path || event.url || '/');
  const qIndex = raw.indexOf('?');
  const rawPath = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const url = new URL(`${origin}${pathToV1(rawPath)}`);

  if (qIndex >= 0) {
    new URLSearchParams(raw.slice(qIndex + 1)).forEach((value, key) => {
      url.searchParams.append(key, value);
    });
  }
  for (const [key, value] of Object.entries(event.queryStringParameters || {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, String(item)));
    else url.searchParams.append(key, String(value));
  }

  let body: BodyInit | undefined;
  if (method !== 'GET' && method !== 'HEAD' && event.body !== undefined && event.body !== null) {
    if (event.isBase64Encoded) {
      // 二进制 body（加密 blob）必须还原成原始字节，不能按 UTF-8 文本解析
      const bytes = Uint8Array.from(Buffer.from(String(event.body), 'base64'));
      body = bytes as unknown as BodyInit;
    } else {
      body = typeof event.body === 'string' ? event.body : JSON.stringify(event.body);
    }
  }

  return new Request(url.toString(), {
    method,
    headers: event.headers || {},
    body,
  });
}

/** 二进制响应必须 base64 回传并置 isBase64Encoded，否则网关会破坏密文字节。 */
export async function toCloudBaseHttpResponse(response: Response): Promise<CloudBaseHttpResponse> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = headers['content-type'] || '';
  const binary = /application\/octet-stream|application\/pdf|application\/zip|image\//i.test(contentType);
  return {
    statusCode: response.status,
    headers,
    body: binary ? bytes.toString('base64') : bytes.toString('utf8'),
    isBase64Encoded: binary,
  };
}

/**
 * 反向转换：给本地联调 / 测试用，把标准 Request 伪装成网关事件，
 * 从而完整走一遍「客户端 → 云函数入口 → handler → 网关响应」。
 */
export async function toCloudBaseHttpEvent(request: Request): Promise<CloudBaseHttpEvent> {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const queryStringParameters: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    queryStringParameters[key] = value;
  });

  const method = request.method.toUpperCase();
  let body: string | undefined;
  let isBase64Encoded = false;
  if (method !== 'GET' && method !== 'HEAD') {
    const bytes = Buffer.from(await request.arrayBuffer());
    if (/application\/octet-stream/i.test(request.headers.get('content-type') || '')) {
      body = bytes.toString('base64');
      isBase64Encoded = true;
    } else {
      body = bytes.toString('utf8');
    }
  }

  return {
    httpMethod: request.method,
    path: url.pathname,
    headers,
    queryStringParameters,
    body,
    isBase64Encoded,
  };
}
