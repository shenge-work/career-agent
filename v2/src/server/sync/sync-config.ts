import crypto from 'node:crypto';
import zlib from 'node:zlib';

/**
 * P2b 第二期 · 飞书同步的纯函数层（不碰 DB / 网络的契约都在这里，便于离线单测）。
 *
 * 与 v1 的对应关系：
 *   publicSyncConfig     ← serve.js GET /api/sync/config 的脱敏形状（hasSecret，无明文）
 *   normalizeSyncPatch   ← serve.js POST /api/sync/config（Secret 留空 = 沿用已保存值）
 *   buildAuthorizeUrl    ← feishu-oauth.js buildAuthorizeUrl
 *   oauthPublicStatus    ← feishu-oauth.js status()
 *   buildProbeDefaults   ← feishu-sync.js buildProbeDefaults
 *   encodeAddons         ← feishu-register.js encodeAddons（gzip → base64 → URL-safe）
 *   mapPollStatus        ← feishu-register.js mapPollStatus（RFC 8628 轮询状态映射）
 */

export const FEISHU_AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
export const FEISHU_TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
export const FEISHU_REGISTER_ENDPOINT = '/oauth/v1/app/registration';
export const DEFAULT_FEISHU_DOMAIN = 'accounts.feishu.cn';
export const DEFAULT_LARK_DOMAIN = 'accounts.larksuite.com';
export const OAUTH_SCOPE = 'drive:drive docx:document drive:drive:version:readonly';
export const REGISTER_SOURCE = 'resume-studio-v2';

/** 应用身份配置（来自 DB 行或 v1 文件回退），服务内部形状。 */
export interface SyncRuntimeConfig {
  appId: string;
  appSecret: string;
  domain: string;
  folderToken: string;
  docTitle: string;
  fileName: string;
  fileUploadMode: string;
  dryRun: boolean;
  source: 'database' | 'legacy-file';
}

export interface SyncConfigPatch {
  app_id?: unknown;
  app_secret?: unknown;
  domain?: unknown;
  folder_token?: unknown;
  doc_title?: unknown;
  file_name?: unknown;
  file_upload_mode?: unknown;
  dryRun?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** GET 接口的脱敏形状：配置可回显，app_secret 永不出现（只给 hasSecret）。 */
export function publicSyncConfig(cfg: SyncRuntimeConfig | null) {
  if (!cfg || !cfg.appId || !cfg.appSecret) {
    return {
      configured: false,
      hasSecret: false,
      source: cfg?.source || 'none',
      config: {
        app_id: cfg?.appId || '',
        domain: cfg?.domain || '',
        folder_token: cfg?.folderToken || '',
        doc_title: cfg?.docTitle || '',
        file_name: cfg?.fileName || '',
        file_upload_mode: cfg?.fileUploadMode || 'versioned',
        dryRun: !!(cfg?.dryRun),
      },
    };
  }
  return {
    configured: true,
    hasSecret: true,
    source: cfg.source,
    config: {
      app_id: cfg.appId,
      domain: cfg.domain,
      folder_token: cfg.folderToken,
      doc_title: cfg.docTitle,
      file_name: cfg.fileName,
      file_upload_mode: cfg.fileUploadMode || 'versioned',
      dryRun: !!cfg.dryRun,
    },
  };
}

/**
 * 归一化一次配置保存（POST /api/sync/config 语义）：
 * - app_secret 留空 = 沿用 current 的旧值（每次保存不必重填）；
 * - 首次配置（current 无 secret）时 secret 必填；
 * - dryRun 只接受显式布尔。
 */
export function normalizeSyncPatch(
  patch: SyncConfigPatch,
  current: SyncRuntimeConfig | null
): { ok: true; value: Omit<SyncRuntimeConfig, 'source'> } | { ok: false; error: string } {
  const appId = str(patch.app_id);
  if (!appId) return { ok: false, error: 'App ID 不能为空' };
  const secret = str(patch.app_secret);
  const oldSecret = current?.appSecret || '';
  if (!secret && !oldSecret) return { ok: false, error: 'App Secret 不能为空（首次配置必填）' };
  const dryRun = patch.dryRun === true ? true : patch.dryRun === false ? false : !!(current?.dryRun);
  return {
    ok: true,
    value: {
      appId,
      appSecret: secret || oldSecret,
      domain: str(patch.domain) || current?.domain || '',
      folderToken: str(patch.folder_token) || current?.folderToken || '',
      docTitle: str(patch.doc_title) || current?.docTitle || '',
      fileName: str(patch.file_name) || current?.fileName || '',
      fileUploadMode: str(patch.file_upload_mode) === 'new' ? 'new' : 'versioned',
      dryRun,
    },
  };
}

/** 把 DB 行（或 v1 文件回退对象）折算成运行时配置形状。 */
export function runtimeConfigFromRow(
  row: Record<string, unknown> | null | undefined,
  source: SyncRuntimeConfig['source']
): SyncRuntimeConfig | null {
  if (!row) return null;
  const appId = String(row.app_id ?? row.appId ?? '');
  const appSecret = String(row.app_secret ?? row.appSecret ?? '');
  if (!appId || !appSecret) return null;
  return {
    appId,
    appSecret,
    domain: String(row.domain ?? ''),
    folderToken: String(row.folder_token ?? row.folderToken ?? ''),
    docTitle: String(row.doc_title ?? row.docTitle ?? ''),
    fileName: String(row.file_name ?? row.fileName ?? ''),
    fileUploadMode: String(row.file_upload_mode ?? row.fileUploadMode ?? 'versioned'),
    dryRun: row.dryRun === true || row.dry_run === true,
    source,
  };
}

/* ---------- OAuth（授权码模式） ---------- */

/** 生成授权链接；state 由调用方保存「state → userId」映射（回调据此落对账号）。 */
export function buildAuthorizeUrl(opts: { appId: string; redirectUri: string; state?: string }) {
  if (!opts.appId) throw new Error('飞书应用尚未配置：请先保存 App ID / App Secret，或用「扫码注册个人应用」自动创建');
  const state = opts.state || crypto.randomBytes(12).toString('hex');
  const q = new URLSearchParams({
    app_id: opts.appId,
    redirect_uri: opts.redirectUri,
    state,
    scope: OAUTH_SCOPE,
  });
  return { url: FEISHU_AUTHORIZE_URL + '?' + q.toString(), state, redirectUri: opts.redirectUri };
}

/** GET /api/feishu/oauth/status 的脱敏形状（沿用 v1，绝不回传 token 明文）。 */
export function oauthPublicStatus(
  o: { accessToken?: string; refreshToken?: string; scope?: string; expiresAt?: number; refreshExpiresAt?: number; updatedAt?: number } | null,
  now = Date.now()
) {
  if (!o || !o.accessToken) return { authorized: false };
  return {
    authorized: true,
    scope: o.scope || OAUTH_SCOPE,
    expires_at: o.expiresAt || 0,
    updated_at: o.updatedAt || 0,
    hasRefresh: !!(o.refreshToken && o.refreshExpiresAt && o.refreshExpiresAt > now),
  };
}

/** 生成 OAuth 回调结果页（与 v1 同构：自动关闭，不展示任何 token）。 */
export function buildCallbackPage(ok: boolean, message: string): string {
  const esc = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (!ok) {
    return (
      '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>授权失败</title></head>' +
      '<body style="font-family:sans-serif;background:#fff;color:#1a1a1a;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">' +
      '<div style="text-align:center;"><h2 style="margin:0 0 8px;">✗ 授权失败</h2>' +
      `<p style="color:#6b6b6b;margin:0 0 16px;">${esc}</p>` +
      '</div></body></html>'
    );
  }
  return (
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>授权成功</title></head>' +
    '<body style="font-family:sans-serif;background:#fff;color:#1a1a1a;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">' +
    '<div style="text-align:center;"><h2 style="margin:0 0 8px;">✓ 飞书授权成功</h2>' +
    '<p style="color:#6b6b6b;margin:0 0 16px;">已绑定你的飞书账号，可关闭本页返回编辑器。</p>' +
    '<script>setTimeout(function(){try{window.close();}catch(e){}} ,1500);<\/script>' +
    '</div></body></html>'
  );
}

/* ---------- probe（一键绑定探测） ---------- */

/** 默认项构造（v1 同款纯函数）：folder_token 为空/缺失时回退 '0'=根目录。 */
export function buildProbeDefaults(folderToken: string) {
  return {
    folder_token: folderToken || '0',
    doc_title: '简历数据备份',
    file_name: 'resume.json',
    domain: 'feishu.cn',
    fileUploadMode: 'versioned',
  };
}

/* ---------- Device Flow（个人应用扫码注册，RFC 8628） ---------- */

/** addons 编码（与飞书官方 SDK 一致）：JSON → gzip → base64 → URL-safe。 */
export function encodeAddons(addons: unknown): string {
  const json = JSON.stringify(addons);
  return zlib
    .gzipSync(Buffer.from(json, 'utf8'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export const REGISTER_DEFAULT_ADDONS = {
  scopes: {
    user: ['drive:drive', 'docx:document'],
    tenant: ['drive:drive', 'docx:document'],
  },
};

/** poll 响应 → 本地状态对象（v1 同款映射）；ctx 跨调用持有域名切换标记。 */
export function mapPollStatus(
  res: Record<string, any>,
  ctx: { domainSwitched?: boolean } | null
):
  | { status: 'waiting' }
  | { status: 'slow_down' }
  | { status: 'success'; client_id: string; client_secret: string; user_info: unknown }
  | { status: 'failed'; error: string; error_description: string }
  | { status: 'expired'; error: string; error_description: string } {
  if (ctx && res.user_info && res.user_info.tenant_brand === 'lark' && !ctx.domainSwitched) {
    ctx.domainSwitched = true;
  }
  if (res.client_id && res.client_secret) {
    return {
      status: 'success',
      client_id: res.client_id,
      client_secret: res.client_secret,
      user_info: res.user_info || null,
    };
  }
  switch (res.error) {
    case 'authorization_pending':
      return { status: 'waiting' };
    case 'slow_down':
      return { status: 'slow_down' };
    case 'access_denied':
      return { status: 'failed', error: res.error, error_description: res.error_description || '用户拒绝授权' };
    case 'expired_token':
      return { status: 'expired', error: res.error, error_description: res.error_description || '二维码已过期' };
    default:
      if (res.error) return { status: 'failed', error: res.error, error_description: res.error_description || res.error };
      return { status: 'waiting' };
  }
}

/** begin 响应校验（飞书错误体尽量透出）。 */
export function parseBeginResponse(statusCode: number, json: Record<string, any> | null, raw: string) {
  if (statusCode < 200 || statusCode >= 300 || !json || !json.device_code || !json.verification_uri_complete) {
    const msg = (json && (json.msg || json.error_description)) || `HTTP ${statusCode} ${(raw || '').slice(0, 200)}`;
    return { ok: false as const, error: '飞书设备流初始化失败：' + msg };
  }
  return { ok: true as const, value: json };
}
