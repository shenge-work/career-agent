/** 前后端共用的常量。保持零依赖，server 与 web 都可 import。 */

export const ROLES = ['admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

/** NestJS DI token。用字符串而非 Symbol，方便测试里 overrideProvider。 */
export const DB_TOKEN = 'RESUME_STUDIO_DB';

export const SESSION_COOKIE = 'rs_sid';
export const SESSION_TTL_HOURS = 168;

export const IS_PUBLIC_KEY = 'resume_studio:is_public';
export const ROLES_KEY = 'resume_studio:roles';

export const API_PREFIX = '/api';

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string | null;
  role: Role;
}

/** 登录失败限流：同 email+ip 在窗口内最多失败次数。 */
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 5 * 60 * 1000;
