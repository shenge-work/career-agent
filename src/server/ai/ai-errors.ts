/**
 * P0-2 · AI 统一错误模型（纯函数层，无 Nest / DB 依赖）。
 *
 * 上游所有失败都归一到 AiError（结构化 code + retryable + retryAfterMs），
 * controller 据此把结构化错误返回给前端，不再透传晦涩的原始 HTTP 文本。
 * 隐私铁律：这里只承载「错误码 + 中文文案 + 元数据」，绝不承载 prompt 或响应正文。
 */

export type AiErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_BASE_URL'
  | 'AUTH_FAILED'
  | 'MODEL_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'BAD_REQUEST'
  | 'UPSTREAM_ERROR'
  | 'BODY_TOO_LARGE'
  | 'STREAM_ABORTED';

/** 统一错误结构：前端拿到的是这个对象的 JSON（apiKey 等敏感信息永不在其中）。 */
export interface AiError {
  code: AiErrorCode;
  message: string;
  status?: number;
  retryable: boolean;
  retryAfterMs?: number;
}

/** 中文错误文案（前后端共享同一份，前端可直接按 code 兜底展示）。 */
export const AI_ERROR_TEXT: Record<AiErrorCode, string> = {
  INVALID_CONFIG: 'AI 配置不完整或非法',
  INVALID_BASE_URL: '上游地址非法或指向内网 / 保留地址',
  AUTH_FAILED: '鉴权失败：apiKey 无效或已过期，请到「账号与设置」检查',
  MODEL_NOT_FOUND: '模型不存在：请检查模型 ID 是否与上游一致',
  RATE_LIMITED: '请求过于频繁：已被上游限流，请稍后重试',
  TIMEOUT: '上游响应超时',
  BAD_REQUEST: '请求参数有误',
  UPSTREAM_ERROR: '上游服务异常，请稍后重试',
  BODY_TOO_LARGE: '上游响应体过大，已中断',
  STREAM_ABORTED: '流式响应被中断',
};

/** 构造 AiError 的便捷工厂，未传的字段给保守默认值。 */
export function makeAiError(
  code: AiErrorCode,
  message: string,
  opts: { status?: number; retryable?: boolean; retryAfterMs?: number } = {}
): AiError {
  return {
    code,
    message,
    status: opts.status,
    retryable: opts.retryable ?? false,
    retryAfterMs: opts.retryAfterMs,
  };
}

/** 由 HTTP 状态码推导错误码（AiProxyError 兜底用，未显式给 code 时）。 */
export function codeFromStatus(status: number): AiErrorCode {
  switch (status) {
    case 401:
    case 403:
      return 'AUTH_FAILED';
    case 404:
      return 'MODEL_NOT_FOUND';
    case 429:
      return 'RATE_LIMITED';
    case 408:
    case 504:
      return 'TIMEOUT';
    case 400:
      return 'BAD_REQUEST';
    default:
      return status >= 500 ? 'UPSTREAM_ERROR' : 'UPSTREAM_ERROR';
  }
}

/** 由错误码推导默认 HTTP 状态码（仅当上游没给 status 时兜底）。 */
export function statusFromCode(code: AiErrorCode): number {
  switch (code) {
    case 'INVALID_CONFIG':
    case 'INVALID_BASE_URL':
    case 'BAD_REQUEST':
      return 400;
    case 'AUTH_FAILED':
      return 401;
    case 'MODEL_NOT_FOUND':
      return 404;
    case 'RATE_LIMITED':
      return 429;
    case 'TIMEOUT':
    case 'UPSTREAM_ERROR':
    case 'BODY_TOO_LARGE':
    case 'STREAM_ABORTED':
      return 502;
    default:
      return 502;
  }
}

/**
 * 解析 Retry-After 头：支持秒数与 HTTP-date 两种格式。
 * 返回毫秒；无法解析时返回 undefined（交由调用方的指数退避兜底）。
 */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  const s = String(value ?? '').trim();
  if (!s) return undefined;
  const secs = Number(s);
  if (s !== '' && Number.isFinite(secs) && secs >= 0) {
    return Math.min(Math.round(secs * 1000), 60_000);
  }
  const date = Date.parse(s);
  if (Number.isFinite(date)) {
    return Math.max(0, Math.min(date - Date.now(), 60_000));
  }
  return undefined;
}

/**
 * 把上游 HTTP 状态映射为统一 AiError。
 *   · 401/403 → AUTH_FAILED；404 → MODEL_NOT_FOUND；429 → RATE_LIMITED（带 retryAfterMs）
 *   · 408/504 → TIMEOUT；400 → BAD_REQUEST；其余 5xx → UPSTREAM_ERROR
 * 只重试 retryable=true 的错误：400/401/403/404 不重试。
 * @param retryAfterMs 已解析为毫秒的 Retry-After（调用方用 parseRetryAfterMs 预解析）。
 */
export function mapUpstreamError(status: number, bodyText: string, retryAfterMs?: number): AiError {
  const text = String(bodyText || '').slice(0, 300);
  switch (status) {
    case 401:
    case 403:
      return makeAiError('AUTH_FAILED', AI_ERROR_TEXT.AUTH_FAILED, { status, retryable: false });
    case 404:
      return makeAiError('MODEL_NOT_FOUND', AI_ERROR_TEXT.MODEL_NOT_FOUND + (text ? `（${text}）` : ''), {
        status,
        retryable: false,
      });
    case 429:
      return makeAiError('RATE_LIMITED', AI_ERROR_TEXT.RATE_LIMITED, {
        status,
        retryable: true,
        retryAfterMs,
      });
    case 408:
    case 504:
      return makeAiError('TIMEOUT', AI_ERROR_TEXT.TIMEOUT, { status, retryable: true });
    case 400:
      // 保留上游 400 正文：parseJd 依赖其中的 response_format 关键字做能力降级。
      return makeAiError('BAD_REQUEST', text ? `${AI_ERROR_TEXT.BAD_REQUEST}：${text}` : AI_ERROR_TEXT.BAD_REQUEST, {
        status,
        retryable: false,
      });
    default:
      if (status >= 500) {
        return makeAiError('UPSTREAM_ERROR', AI_ERROR_TEXT.UPSTREAM_ERROR + (text ? `（${text}）` : ''), {
          status,
          retryable: true,
        });
      }
      return makeAiError('UPSTREAM_ERROR', AI_ERROR_TEXT.UPSTREAM_ERROR + (text ? `（${text}）` : ''), {
        status,
        retryable: false,
      });
  }
}

/**
 * 兼容旧链路的具体错误类。既可作为 AiError 使用（instanceof AiError 成立），
 * 也保留旧版 `instanceof AiProxyError` 的判空用法（practice / agent 依赖）。
 */
export class AiProxyError extends Error implements AiError {
  readonly code: AiErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    status: number,
    message: string,
    code?: AiErrorCode | string | null,
    retryable = false,
    retryAfterMs?: number
  ) {
    super(message);
    this.name = 'AiProxyError';
    this.status = status;
    this.code = (code as AiErrorCode) || codeFromStatus(status);
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }

  static from(err: AiError): AiProxyError {
    return new AiProxyError(
      err.status ?? statusFromCode(err.code),
      err.message,
      err.code,
      err.retryable,
      err.retryAfterMs
    );
  }
}
