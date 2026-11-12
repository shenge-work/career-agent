/**
 * P0-4 · 统一 HTTP 客户端（纯函数层，无 Nest / DB 依赖）。
 *
 * 所有上游调用（test / complete / openChat）共用这一个出口：
 *   · 超时：stream=false 用总超时（timeoutMs）；stream=true 用「首字节超时 + 空闲超时」。
 *   · 重试：429 / 5xx / 超时按 Retry-After 或指数退避（500ms→1s→2s），默认重试 2 次；
 *           只重试 retryable=true 的错误（400/401/403/404 不重试）。
 *   · 响应体强制字节上限，防止异常/恶意上游把单次请求内存拉满。
 */
import { AiProxyError, makeAiError, mapUpstreamError, parseRetryAfterMs, type AiError } from './ai-errors';
import { MAX_UPSTREAM_RESPONSE_BYTES, modelsUrl, upstreamUrl, type AiRuntimeConfig } from './ai-config';

const DEFAULT_MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

export interface AiHttpOptions {
  /** 首字节/总超时（流式 = 首字节，非流式 = 总超时）。缺省用 cfg.timeoutMs。 */
  connectTimeoutMs?: number;
  /** 流式空闲超时：超过该时长没有新 chunk 就中断。仅 stream=true 生效。 */
  idleTimeoutMs?: number;
  /** 最大重试次数（不含首次），默认 2。 */
  maxRetries?: number;
}

/** 非流式补全结果：正文 + HTTP 状态（成功即 status 200~299）。 */
export interface AiCompleteResult {
  text: string;
  status: number;
  ok: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(e: unknown): boolean {
  return (e as any)?.name === 'AbortError';
}

/** 读取响应体并强制字节上限；超限立即中断并抛 BODY_TOO_LARGE（不可重试）。 */
export async function readBodyCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_UPSTREAM_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new AiProxyError(502, '上游响应体过大，已中断', 'BODY_TOO_LARGE', false);
    }
    chunks.push(value);
  }
  const total = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return total.toString('utf8');
}

/**
 * 给流式 body 加空闲超时看门狗：每收到一个 chunk 重置计时，
 * 超过 idleMs 没有新 chunk 就把流报错并取消上游，避免半开连接挂死。
 */
function applyIdleTimeout(body: ReadableStream<Uint8Array>, idleMs: number): ReadableStream<Uint8Array> {
  if (!idleMs || idleMs <= 0) return body;
  const source = body.getReader();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (timedOut) return;
      clear();
      timer = setTimeout(() => {
        timedOut = true;
        clear();
        source.cancel().catch(() => {});
        controller.error(new AiProxyError(504, '流式响应空闲超时，已中断', 'STREAM_ABORTED', false));
      }, idleMs);
      try {
        const { done, value } = await source.read();
        clear();
        if (timedOut) return;
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (e) {
        clear();
        if (!timedOut) controller.error(e);
      }
    },
    async cancel(reason) {
      clear();
      return source.cancel(reason).catch(() => {});
    },
  });
}

export class AiHttpClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  /** 非流式补全：总超时 + 重试 + 字节上限，返回完整正文。 */
  async complete(cfg: AiRuntimeConfig, payload: Record<string, unknown>, opts: AiHttpOptions = {}): Promise<AiCompleteResult> {
    const timeoutMs = opts.connectTimeoutMs ?? cfg.timeoutMs;
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    let lastErr: AiError | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await this.fetchAndRead(cfg, payload, timeoutMs);
        if (res.res.ok) {
          return { text: res.text, status: res.res.status, ok: true };
        }
        lastErr = mapUpstreamError(res.res.status, res.text, parseRetryAfterMs(res.res.headers.get('retry-after')));
        if (!lastErr.retryable || attempt === maxRetries) throw AiProxyError.from(lastErr);
      } catch (e) {
        if (e instanceof AiProxyError) {
          lastErr = e;
          if (!e.retryable || attempt === maxRetries) throw e;
        } else if (isAbortError(e)) {
          lastErr = makeAiError('TIMEOUT', `上游超时（${timeoutMs / 1000}s）`, { status: 504, retryable: true });
          if (attempt === maxRetries) throw AiProxyError.from(lastErr);
        } else {
          lastErr = makeAiError('UPSTREAM_ERROR', '上游请求失败：' + ((e as any)?.message || String(e)), {
            status: 502,
            retryable: true,
          });
          if (attempt === maxRetries) throw AiProxyError.from(lastErr);
        }
      }
      await sleep(backoffMs(attempt, lastErr?.retryAfterMs));
    }
    throw AiProxyError.from(lastErr ?? makeAiError('UPSTREAM_ERROR', '上游请求失败', { status: 502, retryable: true }));
  }

  /**
   * 流式调用：首字节超时 + 空闲超时，2xx 直接把带看门狗的 Response 返回；
   * 非 2xx 按非流式读 body 并走同样的重试策略（此时还没开始吐流，可安全重试）。
   */
  async openStream(cfg: AiRuntimeConfig, payload: Record<string, unknown>, opts: AiHttpOptions = {}): Promise<Response> {
    const connectMs = opts.connectTimeoutMs ?? cfg.timeoutMs;
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    let lastErr: AiError | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await this.fetchOnce(cfg, payload, connectMs);
        if (res.ok && res.body) {
          const body = applyIdleTimeout(res.body, opts.idleTimeoutMs ?? 0);
          return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
        }
        const text = await readBodyCapped(res).catch(() => '');
        lastErr = mapUpstreamError(res.status, text, parseRetryAfterMs(res.headers.get('retry-after')));
        if (!lastErr.retryable || attempt === maxRetries) throw AiProxyError.from(lastErr);
      } catch (e) {
        if (e instanceof AiProxyError) {
          lastErr = e;
          if (!e.retryable || attempt === maxRetries) throw e;
        } else if (isAbortError(e)) {
          lastErr = makeAiError('TIMEOUT', `上游超时（${connectMs / 1000}s）`, { status: 504, retryable: true });
          if (attempt === maxRetries) throw AiProxyError.from(lastErr);
        } else {
          lastErr = makeAiError('UPSTREAM_ERROR', '上游请求失败：' + ((e as any)?.message || String(e)), {
            status: 502,
            retryable: true,
          });
          if (attempt === maxRetries) throw AiProxyError.from(lastErr);
        }
      }
      await sleep(backoffMs(attempt, lastErr?.retryAfterMs));
    }
    throw AiProxyError.from(lastErr ?? makeAiError('UPSTREAM_ERROR', '上游请求失败', { status: 502, retryable: true }));
  }

  /**
   * 拉取上游模型列表（GET {baseUrl}/models），复用同一套超时/重试/字节上限与错误映射。
   * 返回原始正文，由 service 层解析（不同兼容层结构略有差异）。
   */
  async listModels(cfg: AiRuntimeConfig, opts: AiHttpOptions = {}): Promise<AiCompleteResult> {
    const timeoutMs = opts.connectTimeoutMs ?? cfg.timeoutMs;
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    let lastErr: AiError | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await this.fetchGet(modelsUrl(cfg), cfg.apiKey, timeoutMs);
        const text = await readBodyCapped(res);
        if (res.ok) return { text, status: res.status, ok: true };
        lastErr = mapUpstreamError(res.status, text, parseRetryAfterMs(res.headers.get('retry-after')));
        if (!lastErr.retryable || attempt === maxRetries) throw AiProxyError.from(lastErr);
      } catch (e) {
        if (e instanceof AiProxyError) {
          lastErr = e;
          if (!e.retryable || attempt === maxRetries) throw e;
        } else if (isAbortError(e)) {
          lastErr = makeAiError('TIMEOUT', `上游超时（${timeoutMs / 1000}s）`, { status: 504, retryable: true });
          if (attempt === maxRetries) throw AiProxyError.from(lastErr);
        } else {
          lastErr = makeAiError('UPSTREAM_ERROR', '上游请求失败：' + ((e as any)?.message || String(e)), {
            status: 502,
            retryable: true,
          });
          if (attempt === maxRetries) throw AiProxyError.from(lastErr);
        }
      }
      await sleep(backoffMs(attempt, lastErr?.retryAfterMs));
    }
    throw AiProxyError.from(lastErr ?? makeAiError('UPSTREAM_ERROR', '上游请求失败', { status: 502, retryable: true }));
  }

  /** 一次 fetch + 完整读 body，共用同一个 AbortController 做总超时（覆盖读体阶段）。 */
  private async fetchAndRead(
    cfg: AiRuntimeConfig,
    payload: Record<string, unknown>,
    timeoutMs: number
  ): Promise<{ res: Response; text: string }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(upstreamUrl(cfg), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + cfg.apiKey,
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const text = await readBodyCapped(res);
      return { res, text };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 一次 fetch（仅到首字节/头），超时只覆盖连接与响应头阶段。 */
  private async fetchOnce(cfg: AiRuntimeConfig, payload: Record<string, unknown>, timeoutMs: number): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await this.fetchImpl(upstreamUrl(cfg), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + cfg.apiKey,
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** 一次 GET（用于 /models），超时覆盖连接与读体阶段（读体在调用方 readBodyCapped 完成前超时仍生效）。 */
  private async fetchGet(url: string, apiKey: string, timeoutMs: number): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + apiKey },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 指数退避：500ms→1s→2s；有 Retry-After 时优先尊重它（封顶 30s）。 */
function backoffMs(attempt: number, retryAfterMs?: number): number {
  if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
    return Math.min(retryAfterMs, 30_000);
  }
  return Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
}
