import { createHash, randomBytes } from 'node:crypto';
import { SESSION_COOKIE, SESSION_TTL_HOURS } from '../../shared/constants';

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 数据库只存 token 的 sha256，库泄露也不能直接拿来登录。 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function readSessionCookie(header?: string): string | null {
  const v = parseCookies(header)[SESSION_COOKIE];
  return v && v.length > 0 ? v : null;
}

export function sessionCookie(token: string, secure = false): string {
  const maxAge = SESSION_TTL_HOURS * 3600;
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

export function clearSessionCookie(secure = false): string {
  return [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}
