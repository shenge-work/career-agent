/** 前后端共用的常量。保持零依赖，server 与 web 都可 import。 */

/** NestJS DI token。用字符串而非 Symbol，方便测试里 overrideProvider。 */
export const DB_TOKEN = 'RESUME_STUDIO_DB';

export const SESSION_COOKIE = 'rs_sid';
export const SESSION_TTL_HOURS = 168;

export const IS_PUBLIC_KEY = 'resume_studio:is_public';

export const API_PREFIX = '/api';

/**
 * 登录身份。账号一律平等：本产品没有角色、没有管理员、没有成员管理。
 * 身份只用于数据归属（user_id），不携带任何权限等级。
 */
export interface CurrentUser {
  id: string;
  email: string;
  displayName: string | null;
}

/** 登录失败限流：同 email+ip 在窗口内最多失败次数。 */
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 5 * 60 * 1000;
