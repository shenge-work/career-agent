import { FEISHU_REGISTER_ENDPOINT } from './sync-config';

/**
 * P2b 第二期 · 飞书开放平台 HTTP 客户端（对应 v1 feishu-sync.js 的底层层）。
 *
 * transport 可注入（SYNC_HTTP）：默认实现走 Node 22 的 global fetch，
 * 测试注入桩即可离线覆盖「凭证校验 / 上报 / 版本 / Device Flow」全链路，
 * 不需要真实飞书凭证，也绝不打外网。
 *
 * 飞书 JSON 语义（与 v1 一致）：HTTP 2xx 且业务码 code === 0 才算成功；
 * Device Flow（RFC 8628）例外 —— authorization_pending / slow_down 以 HTTP 400
 * 返回，因此注册相关的 postForm 对任意状态码都解析响应体，由上层判断。
 */

/** transport 注入令牌：默认走 global fetch；测试 overrideProvider(SYNC_HTTP) 注入桩。 */
export const SYNC_HTTP = 'RESUME_STUDIO_SYNC_HTTP';

export interface FeishuHttpResponse {
  status: number;
  text: string;
  json: Record<string, any> | null;
}

export type FeishuHttp = (url: string, init: { method: string; headers?: Record<string, string>; body?: string | Buffer }) => Promise<FeishuHttpResponse>;

export const defaultFeishuHttp: FeishuHttp = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body as any,
  });
  const text = await res.text();
  let json: Record<string, any> | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
};

const OPEN_BASE = 'https://open.feishu.cn/open-apis';

export function openApiUrl(p: string): string {
  return OPEN_BASE + p;
}

/** 飞书 JSON API：HTTP 2xx + code===0 → data；否则抛带上下文的 Error。 */
export async function fapiJson(
  http: FeishuHttp,
  method: string,
  p: string,
  body: unknown,
  token: string
): Promise<Record<string, any>> {
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (payload) headers['Content-Length'] = String(Buffer.byteLength(payload));
  const res = await http(openApiUrl(p), { method, headers, body: payload || undefined });
  const ok = res.status >= 200 && res.status < 300 && res.json && res.json.code === 0;
  if (!ok) {
    throw new Error(
      `飞书 ${method} ${p} → HTTP ${res.status} ${res.json ? JSON.stringify(res.json).slice(0, 400) : res.text.slice(0, 200)}`
    );
  }
  return res.json!.data || {};
}

/** multipart/form-data 上传（云盘 upload_all）。boundary 固定前缀 + 时间戳，与 v1 一致。 */
export async function fapiMultipart(
  http: FeishuHttp,
  p: string,
  fields: Record<string, string | number>,
  fileBuf: Buffer,
  token: string
): Promise<Record<string, any>> {
  const boundary = '----feishusync' + Date.now();
  const parts: Buffer[] = [];
  for (const k in fields) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${fields[k]}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="resume.json"\r\nContent-Type: application/json\r\n\r\n`));
  parts.push(fileBuf);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  const res = await http(openApiUrl(p), {
    method: 'POST',
    headers: {
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      Authorization: 'Bearer ' + token,
      'Content-Length': String(body.length),
    },
    body,
  });
  const ok = res.status >= 200 && res.status < 300 && res.json && res.json.code === 0;
  if (!ok) {
    throw new Error(
      `飞书 multipart ${p} → HTTP ${res.status} ${res.json ? JSON.stringify(res.json).slice(0, 400) : res.text.slice(0, 200)}`
    );
  }
  return res.json!.data || {};
}

/**
 * 下载文件版本内容（v1 reqRaw 语义）：先打开放平台下载端点，
 * 若返回 {code:0, data:{url}} 则跟随预签名 URL 再取一次；否则响应体即内容。
 */
export async function downloadVersionContent(http: FeishuHttp, p: string, token: string): Promise<string> {
  const res = await http(openApiUrl(p), { method: 'GET', headers: { Authorization: 'Bearer ' + token } });
  if (res.json && res.json.code === 0 && res.json.data && res.json.data.url) {
    const presigned = await http(res.json.data.url, { method: 'GET' });
    return presigned.text;
  }
  return res.text;
}

/* ---------- Device Flow（个人应用注册，accounts.feishu.cn 表单端点） ---------- */

/** RFC 8628 表单 POST：任何状态码都解析返回（pending/slow_down 以 400 返回）。 */
export async function postRegisterForm(
  http: FeishuHttp,
  domain: string,
  params: Record<string, string>
): Promise<FeishuHttpResponse> {
  const body = new URLSearchParams(params).toString();
  return http(`https://${domain}${FEISHU_REGISTER_ENDPOINT}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(Buffer.byteLength(body)),
    },
    body,
  });
}
