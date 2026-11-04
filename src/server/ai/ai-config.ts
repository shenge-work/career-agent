

/**
 * P2b · AI 配置的纯函数层（可单测、无 Nest / DB 依赖）。
 *
 * 与 v1 的差别：配置按账号存 DB，apiKey 只在本层与服务层可见，
 * 任何返回给浏览器的对象都不含明文 Key；未配置时只读回退 v1 ai.config.json。
 */

export interface AiRuntimeConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  models: Record<string, string>;
  temperature: number;
  timeoutMs: number;
  source: 'database';
}

export interface ConfigPatch {
  provider?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  models?: unknown;
  temperature?: unknown;
  timeoutMs?: unknown;
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function hostKey(hostname: string): string {
  const h = hostname.toLowerCase().trim();
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostKey(hostname);
  return LOOPBACK.has(h) || h.endsWith('.localhost') || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** 字面 IP 的私有/保留段判定（DNS 重绑定不做解析，见 validateBaseUrl 注释）。 */
export function isPrivateIpLiteral(hostname: string): boolean {
  const h = hostKey(hostname);
  const m = IPV4.exec(h.replace(/^::ffff:/, ''));
  if (m) {
    const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (a === 127 || a === 0) return false; // 回环 / 0.0.0.0 交给协议规则处理
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) || // 云元数据
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (h.includes(':')) {
    // IPv6 唯一本地地址 / 链路本地地址
    return /^(fc|fd|fe[89ab])/i.test(h) || h.startsWith('fe80');
  }
  return false;
}

/**
 * 上游 baseURL 安全校验：配置由用户填写，若不校验就能把本机服务变成
 * 访问内网 / 云元数据的跳板（SSRF）。
 *  - 只允许 http/https；http 仅限回环（本地 Ollama / 测试桩），
 *    https 允许公网域名，但字面私有 IP 一律拒绝；
 *  - 不接受 userinfo、query、hash、路径穿越；
 *  - 域名解析到内网（DNS rebinding）不在本层处理：本地内测工具，
 *    不做 DNS 预解析与逐请求 IP 复核，正式部署应在出口网关做限制。
 */
export function validateBaseUrl(raw: unknown): ValidationResult {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, reason: 'baseUrl 不能为空' };
  if (s.length > 300) return { ok: false, reason: 'baseUrl 过长' };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, reason: 'baseUrl 不是合法 URL' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, reason: 'baseUrl 只支持 http / https' };
  }
  if (u.username || u.password) return { ok: false, reason: 'baseUrl 不能包含账号密码' };
  if (u.search || u.hash) return { ok: false, reason: 'baseUrl 不能带查询参数或片段' };
  if (u.pathname.includes('..')) return { ok: false, reason: 'baseUrl 路径不能包含 ..' };
  const host = hostKey(u.hostname);
  const loopback = isLoopbackHost(host);
  if (u.protocol === 'http:' && !loopback) {
    return { ok: false, reason: 'http 上游仅限本机回环地址（远程请用 https）' };
  }
  if (isPrivateIpLiteral(host) && !(u.protocol === 'http:' && loopback)) {
    return { ok: false, reason: '上游不能指向内网 / 保留地址' };
  }
  if (host === '0.0.0.0' || host === '::') {
    return { ok: false, reason: '上游地址无效' };
  }
  return { ok: true };
}

function cleanModels(raw: unknown): Record<string, string> | null {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 30) return null;
  for (const [k, v] of entries) {
    if (typeof v !== 'string' || !k.trim() || k.length > 60 || v.length > 120) return null;
    out[k.trim()] = v.trim();
  }
  return out;
}

/**
 * PUT /api/ai/config 的入参归一化。
 * apiKey 留空 = 不修改已有 Key（与 v1 sync.config.json 的语义一致），
 * 首次配置必须填；其余字段全量校验后才允许写库。
 */
export function normalizeConfig(
  patch: ConfigPatch,
  existing?: AiRuntimeConfig | null
): { ok: true; value: Omit<AiRuntimeConfig, 'source'> } | { ok: false; error: string } {
  const urlCheck = validateBaseUrl(patch.baseUrl);
  if (!urlCheck.ok) return { ok: false, error: urlCheck.reason! };

  const keyRaw = patch.apiKey === undefined ? '' : String(patch.apiKey).trim();
  const apiKey = keyRaw || existing?.apiKey || '';
  if (!apiKey) return { ok: false, error: '首次配置必须填写 apiKey（留空表示不修改已有 Key）' };
  if (apiKey.length > 500) return { ok: false, error: 'apiKey 过长' };

  const models = cleanModels(patch.models);
  if (!models) return { ok: false, error: 'models 必须是「名称 → 模型 ID」的字符串对象' };

  const provider = String(patch.provider ?? '').trim() || 'openai-compatible';
  if (provider.length > 60) return { ok: false, error: 'provider 过长' };

  const temperature = patch.temperature === undefined ? 0.4 : Number(patch.temperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    return { ok: false, error: 'temperature 必须是 0~2 的数字' };
  }
  const timeoutMs = patch.timeoutMs === undefined ? 60000 : Number(patch.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) {
    return { ok: false, error: 'timeoutMs 必须是 1000~300000 的整数' };
  }

  return {
    ok: true,
    value: {
      provider,
      baseUrl: String(patch.baseUrl).trim().replace(/\/+$/, ''),
      apiKey,
      models,
      temperature,
      timeoutMs,
    },
  };
}

/** 永不返回 apiKey 明文；给浏览器读的只有 hasApiKey 标记。 */
export function publicConfig(cfg: AiRuntimeConfig | null) {
  if (!cfg) {
    return {
      configured: false,
      hasApiKey: false,
      provider: '',
      baseUrl: '',
      model: '',
      models: {} as Record<string, string>,
      temperature: 0.4,
      timeoutMs: 60000,
      source: 'none',
    };
  }
  const model = cfg.models.fast || cfg.models.strong || Object.values(cfg.models)[0] || '';
  return {
    configured: true,
    hasApiKey: !!cfg.apiKey,
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    model,
    models: cfg.models,
    temperature: cfg.temperature,
    timeoutMs: cfg.timeoutMs,
    source: cfg.source,
  };
}

export function upstreamUrl(cfg: AiRuntimeConfig): string {
  return cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
}

/** /chat/completions 请求体：只放行必要字段，避免把任意入参转发给上游。 */
export function buildChatPayload(
  cfg: AiRuntimeConfig,
  body: { model?: unknown; messages?: unknown; temperature?: unknown; max_tokens?: unknown; response_format?: unknown },
  stream: boolean
): { ok: true; payload: Record<string, unknown>; model: string } | { ok: false; error: string } {
  const model = String(body.model || cfg.models.fast || cfg.models.strong || '').trim();
  if (!model) return { ok: false, error: '未指定模型：请在 AI 配置里填写 models.fast，或请求里带 model' };
  if (model.length > 120) return { ok: false, error: 'model 过长' };
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 100) {
    return { ok: false, error: 'messages 必须是 1~100 条消息' };
  }
  const messages = body.messages.map((m: any) => ({
    role: String(m?.role || 'user'),
    content: String(m?.content ?? ''),
  }));
  const total = messages.reduce((n, m) => n + m.content.length, 0);
  if (total > 2 * 1024 * 1024) return { ok: false, error: 'messages 内容过大' };
  const payload: Record<string, unknown> = {
    model,
    messages,
    temperature: typeof body.temperature === 'number' ? body.temperature : cfg.temperature,
    stream,
  };
  if (body.response_format && typeof body.response_format === 'object') {
    payload.response_format = body.response_format;
  }
  if (body.max_tokens !== undefined) {
    const n = Number(body.max_tokens);
    if (Number.isInteger(n) && n > 0 && n <= 128000) payload.max_tokens = n;
  }
  return { ok: true, payload, model };
}
