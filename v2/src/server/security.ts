/**
 * 本地回环请求守卫（纯函数，便于单测）：
 * 1) Host 必须是回环地址 —— 防 DNS rebinding（外部域名重绑到 127.0.0.1 后读本机 PII）；
 * 2) Origin 若存在必须是回环 http —— 防跨站 CSRF（简单请求免预检也能直达）；
 * 3) Sec-Fetch-Site: cross-site 直接拒绝。
 * 端口不固定：Vite 5173 代理到 3000 时 Host/Origin 端口不同，按「回环」判定而非精确端口。
 */
export interface SecurityCheckResult {
  ok: boolean;
  reason?: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * 允许「跨站抵达」的路径前缀：飞书 OAuth 回调是浏览器从 accounts.feishu.cn
 * 302 跳转过来的（Sec-Fetch-Site: cross-site、无 Origin），会撞上第 3 条规则。
 * 这些路径仍然校验 Host 回环（防 DNS rebinding），只是放行跨站 GET。
 * 路径本身无副作用（只把授权码换成凭证），且必须携带 start 时签发的 state。
 */
export const CROSS_SITE_ALLOWED_PREFIXES = ['/api/feishu/oauth/callback'];

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().trim();
  if (!h) return false;
  if (h.startsWith('[')) {
    const close = h.indexOf(']');
    return close > 0 && LOOPBACK_HOSTS.has(h.slice(0, close + 1));
  }
  const name = h.split(':')[0];
  return LOOPBACK_HOSTS.has(name);
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && isLoopbackHost(u.hostname);
  } catch {
    return false;
  }
}

export function assertLocalRequest(
  headers: Record<string, unknown>,
  method = 'GET',
  url = ''
): SecurityCheckResult {
  const host = String(headers.host || '');
  if (!isLoopbackHost(host)) return { ok: false, reason: 'Forbidden: invalid Host' };

  // 跨站抵达的外部回调（Host 仍须回环）：飞书 OAuth 回调页
  const isCrossSiteAllowed =
    method === 'GET' && CROSS_SITE_ALLOWED_PREFIXES.some((p) => url === p || url.startsWith(p + '?'));
  if (isCrossSiteAllowed) return { ok: true };

  const origin = headers.origin ? String(headers.origin) : '';
  if (origin && !isLoopbackOrigin(origin)) {
    return { ok: false, reason: 'Forbidden: invalid Origin' };
  }

  const site = String(headers['sec-fetch-site'] || '').toLowerCase();
  if (site === 'cross-site') return { ok: false, reason: 'Forbidden: cross-site request' };

  // 变更类请求若带 Origin，必须同源回环（浏览器跨站表单/简单请求在此被掐断）
  if (method !== 'GET' && method !== 'HEAD' && origin && !isLoopbackOrigin(origin)) {
    return { ok: false, reason: 'Forbidden: cross-origin write' };
  }
  return { ok: true };
}
