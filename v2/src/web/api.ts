import type { CurrentUser } from '../shared/constants';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface Me {
  user: CurrentUser;
}

export interface ResumeItem {
  id: string;
  title: string;
  kind: string;
  isMaster: boolean;
  tags: string[] | null;
  parentId: string | null;
  jobId: string | null;
  jdText: string | null;
  payload: Record<string, any>;
  savedAt: number;
  updatedAt: string;
  createdAt: string;
}

export interface CompanyItem {
  id: string;
  name: string;
  payload: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface JdItem {
  id: string;
  companyId: string;
  payload: Record<string, any>;
  createdAt: string;
}

export interface TrackerItem {
  id: string;
  companyId: string | null;
  payload: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface VersionItem {
  id: string;
  resumeId: string;
  kind: string;
  label: string | null;
  snapshot: Record<string, any>;
  createdAt: string;
}

export interface UserRow {
  id: string;
  email: string;
  displayName: string | null;
  role: 'admin' | 'member';
  status: 'active' | 'disabled';
  createdAt: string;
  lastLoginAt: string | null;
}

export interface SettingsResponse {
  payload: Record<string, any>;
}

export interface AiStatus {
  configured: boolean;
  hasApiKey: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  models: Record<string, string>;
  temperature: number;
  timeoutMs: number;
  source: string;
  nodeVersion: string;
  hint: string;
  usage: {
    requests: number;
    errors: number;
    todayRequests: number;
    lastAt: string | null;
    lastModel: string | null;
    days: Array<{ day: string; requests: number; errors: number }>;
  };
}

export interface CollectStatus {
  scriptAvailable: boolean;
  defaultPort: number;
  hint: string;
}

export interface CollectResult {
  ok: boolean;
  added: number;
  total: number;
  hint: string;
  title?: string;
  url?: string;
  company?: string;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  // 没有请求体时绝不声明 JSON Content-Type：Fastify 会对「声明了 JSON 却是空 body」
  // 的 DELETE / POST 直接回 400（Body cannot be empty），曾让「停用 AI 配置」按钮失效。
  const hasBody = init.body !== undefined && init.body !== null;
  const res = await fetch('/api' + path, {
    ...init,
    credentials: 'include',
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });

  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const raw = body?.message || body?.error || `HTTP ${res.status}`;
    const message = Array.isArray(raw) ? raw.join('；') : String(raw);
    // /auth/me 的 401 由 App 自己处理（它据此渲染登录页），其余接口的 401 统一广播跳登录。
    if (res.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new CustomEvent('rs:unauthorized'));
    }
    throw new HttpError(res.status, message);
  }
  return body as T;
}

export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const put = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) });

export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

/** PDF 下载地址：vector=Chrome 原生打印（文字可选中），image=v1 截图管线（精确分页）。 */
export const pdfUrl = (id: string, mode: 'vector' | 'image' = 'vector') =>
  `/api/resumes/${encodeURIComponent(id)}/pdf${mode === 'image' ? '?mode=image' : ''}`;

/** 导出专用页：浏览器自行跑 v1 截图管线并下载（不经服务端 Chrome）。 */
export const exportPageUrl = (id: string) =>
  `/api/resumes/${encodeURIComponent(id)}/export-page`;

export const fmtTime = (v: unknown): string => {
  if (v == null || v === '') return '—';
  const n = typeof v === 'number' ? v : Number(v);
  const d = Number.isFinite(n) ? new Date(n) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN');
};
