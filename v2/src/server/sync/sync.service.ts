import { Inject, Injectable } from '@nestjs/common';
import { TenantDb } from '../tenant/tenant-db';
import { readLegacyJson } from '../legacy-paths';
import {
  SYNC_HTTP,
  defaultFeishuHttp,
  fapiJson,
  fapiMultipart,
  downloadVersionContent,
  postRegisterForm,
  type FeishuHttp,
} from './feishu-client';
import {
  buildAuthorizeUrl,
  buildCallbackPage,
  buildProbeDefaults,
  DEFAULT_FEISHU_DOMAIN,
  DEFAULT_LARK_DOMAIN,
  encodeAddons,
  FEISHU_TOKEN_URL,
  mapPollStatus,
  normalizeSyncPatch,
  oauthPublicStatus,
  parseBeginResponse,
  publicSyncConfig,
  REGISTER_DEFAULT_ADDONS,
  REGISTER_SOURCE,
  runtimeConfigFromRow,
  type SyncRuntimeConfig,
} from './sync-config';
import { RegisterSessionStore } from './register-session.store';

/** 上游失败需要把 HTTP 状态带给 controller，不在这里拼 Nest 响应（与 AiProxyError 同款）。 */
export class SyncError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

interface AuthContext {
  token: string;
  mode: 'user' | 'app';
}

/** 扫码授权的 pending state → 发起用户（回调是匿名请求，只能靠 state 找回账号）。 */
interface PendingOauth {
  userId: string;
  createdAt: number;
}

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const NOT_CONFIGURED = '飞书未配置：请先保存 App ID / App Secret（或用「扫码注册个人应用」自动创建）';

@Injectable()
export class SyncService {
  /** tenant_access_token 按账号缓存（v1 是模块级单缓存，多账号必须分键）。 */
  private readonly tenantTokens = new Map<string, { token: string; exp: number }>();
  private readonly pendingOauth = new Map<string, PendingOauth>();

  constructor(
    private readonly tenant: TenantDb,
    private readonly registerSessions: RegisterSessionStore,
    @Inject(SYNC_HTTP) private readonly http: FeishuHttp = defaultFeishuHttp
  ) {}

  /* ------------------------------------------------------------ 配置 */

  /**
   * DB 配置优先；没有才只读回退 v1 的 sync.config.json（老用户零配置过渡）。
   * ⚠️ OAuth 用户凭证**不**做 v1 文件回退：两套系统的云盘锚点各自管理，
   * 复用 v1 的 user token 会让两边写同一个文件、状态互相打架，重新扫码即可。
   */
  async resolveConfig(userId: string): Promise<SyncRuntimeConfig | null> {
    const rows = await this.tenant.forUser(userId).getSyncConfig();
    const row = rows[0];
    if (row) return runtimeConfigFromRow(row as unknown as Record<string, unknown>, 'database');
    const legacy = readLegacyJson('sync.config.json', process.env.SYNC_CONFIG_FILE);
    return runtimeConfigFromRow(legacy, 'legacy-file');
  }

  /** DB 里有行（哪怕空行）即视为显式配置：空行 = 主动停用，不再回退 v1 文件（与 AI 停用同语义）。 */
  async status(userId: string) {
    const cfg = await this.resolveConfig(userId);
    const oauth = (await this.tenant.forUser(userId).getSyncOauth())[0] || null;
    return {
      ...publicSyncConfig(cfg),
      oauth: oauthPublicStatus(oauth ? { accessToken: oauth.accessToken, refreshToken: oauth.refreshToken, scope: oauth.scope, expiresAt: oauth.expiresAt, refreshExpiresAt: oauth.refreshExpiresAt, updatedAt: oauth.updatedAt } : null),
      hint: cfg
        ? cfg.source === 'legacy-file'
          ? '当前使用 v1 的 sync.config.json（只读回退）；保存一次配置后即切换为账号独立配置。'
          : ''
        : NOT_CONFIGURED,
    };
  }

  /** PUT /api/sync/config：Secret 留空 = 沿用已保存值。 */
  async saveConfig(userId: string, patch: Record<string, unknown>) {
    const current = await this.resolveConfig(userId);
    const norm = normalizeSyncPatch(patch, current);
    if (norm.ok === false) throw new SyncError(400, norm.error);
    await this.tenant.forUser(userId).upsertSyncConfig(norm.value);
    return this.status(userId);
  }

  /** DELETE /api/sync/config：写一行空配置 = 显式停用（不回退 v1 文件）。 */
  async clearConfig(userId: string) {
    await this.tenant.forUser(userId).upsertSyncConfig({
      appId: '',
      appSecret: '',
      domain: '',
      folderToken: '',
      docTitle: '',
      fileName: '',
      fileUploadMode: 'versioned',
      dryRun: false,
    });
    return { ok: true };
  }

  /**
   * POST /api/sync/probe：验证凭证 + 自动建「简历数据」文件夹 + 默认项直接落库。
   * （v1 只把默认项返回给前端表单回显，用户还得再点一次保存；v2 一步到位。）
   */
  async probe(userId: string, body: { app_id?: string; app_secret?: string }) {
    const appId = String(body?.app_id || '').trim();
    const appSecret = String(body?.app_secret || '').trim();
    let cfg = await this.resolveConfig(userId);
    if (!appId || !appSecret) {
      if (!cfg) throw new SyncError(400, 'App ID 与 App Secret 均必填（或先保存过配置）');
      return this.probeWithCredentials(userId, cfg.appId, cfg.appSecret);
    }
    // 表单带了新凭证：先落库再探测（探测的文件夹回填才有落点）
    await this.tenant.forUser(userId).upsertSyncConfig({
      appId,
      appSecret,
      domain: cfg?.domain || '',
      folderToken: cfg?.folderToken || '',
      docTitle: cfg?.docTitle || '',
      fileName: cfg?.fileName || '',
      fileUploadMode: cfg?.fileUploadMode || 'versioned',
      dryRun: cfg?.dryRun || false,
    });
    return this.probeWithCredentials(userId, appId, appSecret);
  }

  private async probeWithCredentials(userId: string, appId: string, appSecret: string) {
    // 1) 验证凭证（换 tenant token；失败抛飞书原始错误）
    const tokenData = await fapiJson(this.http, 'POST', '/auth/v3/tenant_access_token/internal', { app_id: appId, app_secret: appSecret }, '');
    if (!tokenData.tenant_access_token) throw new SyncError(502, '换取 tenant_access_token 失败：响应缺少 tenant_access_token');
    // 2) 自动创建默认文件夹「简历数据」（根目录；飞书允许重名，始终新建，与 v1 一致）
    const folder = await fapiJson(this.http, 'POST', '/drive/v1/files/create_folder', { name: '简历数据', folder_token: '' }, tokenData.tenant_access_token);
    const folderToken = folder.token || folder.folder_token || '';
    // 3) 默认项直接落库
    const defaults = buildProbeDefaults(String(folderToken));
    await this.tenant.forUser(userId).patchSyncConfig({
      folderToken: defaults.folder_token,
      docTitle: defaults.doc_title,
      fileName: defaults.file_name,
      domain: defaults.domain,
      fileUploadMode: defaults.fileUploadMode,
    });
    return { ok: true, ...defaults };
  }

  /* ------------------------------------------------------------ 认证模式 */

  private async getTenantToken(userId: string, cfg: SyncRuntimeConfig): Promise<string> {
    const cached = this.tenantTokens.get(userId);
    if (cached && Date.now() < cached.exp) return cached.token;
    const d = await fapiJson(
      this.http,
      'POST',
      '/auth/v3/tenant_access_token/internal',
      { app_id: cfg.appId, app_secret: cfg.appSecret },
      ''
    );
    const token = String(d.tenant_access_token || '');
    if (!token) throw new SyncError(502, '换取 tenant_access_token 失败');
    this.tenantTokens.set(userId, { token, exp: Date.now() + ((d.expire || 7200) - 60) * 1000 });
    return token;
  }

  /** 扫码用户身份优先，失败回退应用身份（v1 getAuth 语义；token 缓存按账号分键）。 */
  private async getAuth(userId: string, cfg: SyncRuntimeConfig): Promise<AuthContext> {
    try {
      const rows = await this.tenant.forUser(userId).getSyncOauth();
      const o = rows[0];
      if (o && o.accessToken) {
        if (Date.now() < o.expiresAt) return { token: o.accessToken, mode: 'user' };
        if (o.refreshToken && Date.now() < o.refreshExpiresAt) {
          const refreshed = await this.refreshOauthToken(userId, cfg, o.refreshToken);
          return { token: refreshed.accessToken, mode: 'user' };
        }
      }
    } catch {
      /* 刷新失败 → 回退应用身份（v1 同款降级） */
    }
    return { token: await this.getTenantToken(userId, cfg), mode: 'app' };
  }

  private async postTokenEndpoint(body: Record<string, unknown>): Promise<Record<string, any>> {
    const res = await this.http(FEISHU_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    const j = res.json;
    if (res.status < 200 || res.status >= 300 || !j || !j.access_token) {
      throw new SyncError(502, '换取用户凭证失败：' + (res.status) + ' ' + (j ? JSON.stringify(j).slice(0, 300) : res.text.slice(0, 200)));
    }
    return j;
  }

  private async refreshOauthToken(userId: string, cfg: SyncRuntimeConfig, refreshToken: string) {
    const j = await this.postTokenEndpoint({
      grant_type: 'refresh_token',
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      refresh_token: refreshToken,
    });
    const rows = await this.tenant.forUser(userId).upsertSyncOauth({
      accessToken: j.access_token,
      refreshToken: j.refresh_token || refreshToken,
      expiresAt: Date.now() + ((j.expires_in || 3600) - 60) * 1000,
      refreshExpiresAt: j.refresh_expires_in ? Date.now() + (j.refresh_expires_in - 60) * 1000 : 0,
      scope: j.scope || '',
    });
    return rows[0];
  }

  /* ------------------------------------------------------------ 上报 / 版本 / 恢复 */

  private docUrl(cfg: SyncRuntimeConfig, docId: string) {
    return `https://${cfg.domain || 'feishu.cn'}/docx/${docId}`;
  }
  private fileUrl(cfg: SyncRuntimeConfig, fileToken: string) {
    return `https://${cfg.domain || 'feishu.cn'}/file/${fileToken}`;
  }

  /** POST /api/sync/report/:resumeId —— 简历从 DB 读（v2 优势：不信任前端载荷）。 */
  async report(userId: string, resumeId: string) {
    const rows = await this.tenant.forUser(userId).getResume(resumeId);
    const resume = rows[0];
    if (!resume) throw new SyncError(404, '简历不存在');
    const cfg = await this.resolveConfig(userId);
    if (!cfg) throw new SyncError(400, NOT_CONFIGURED);

    const jsonStr = JSON.stringify(resume.payload, null, 2);
    if (cfg.dryRun || process.env.FEISHU_DRY_RUN === '1') {
      return { ok: true, dryRun: true, docUrl: '[dry-run] 飞书文档', fileUrl: '[dry-run] 云盘文件', size: jsonStr.length, authMode: 'dry' };
    }

    const auth = await this.getAuth(userId, cfg);
    const [docId, fileToken] = await Promise.all([
      this.writeDoc(userId, cfg, auth, resumeId, resume.title, jsonStr),
      this.writeFile(userId, cfg, auth, resumeId, resume.title, jsonStr),
    ]);
    return {
      ok: true,
      docUrl: this.docUrl(cfg, docId),
      fileUrl: this.fileUrl(cfg, fileToken),
      size: jsonStr.length,
      authMode: auth.mode,
    };
  }

  private anchorColumns(mode: 'user' | 'app') {
    return mode === 'user'
      ? { documentId: 'userDocumentId', fileToken: 'userFileToken' }
      : { documentId: 'documentId', fileToken: 'fileToken' };
  }

  /** 写 docx：锚点存在则复用并整篇覆盖（batch_clear + code block），否则新建（v1 writeDoc/ensureDoc）。 */
  private async writeDoc(
    userId: string,
    cfg: SyncRuntimeConfig,
    auth: AuthContext,
    resumeId: string,
    resumeName: string,
    jsonStr: string
  ): Promise<string> {
    const t = this.tenant.forUser(userId);
    const state = (await t.getSyncState(resumeId))[0];
    const existing = auth.mode === 'user' ? state?.userDocumentId : state?.documentId;

    let docId = existing || '';
    if (!docId) {
      const title = (resumeName ? resumeName + ' - ' : '') + (cfg.docTitle || '简历数据备份');
      const d = await fapiJson(this.http, 'POST', '/docx/v1/documents', { title }, auth.token);
      docId = d.document.document_id;
    }

    // 清空旧 children（分页拉全 → batch_delete，失败逐条删兜底）
    let allItems: any[] = [];
    let pageToken = '';
    do {
      const qs = pageToken ? `?page_size=200&page_token=${pageToken}` : '?page_size=200';
      const list = await fapiJson(this.http, 'GET', `/docx/v1/documents/${docId}/blocks/${docId}/children${qs}`, undefined, auth.token);
      allItems = allItems.concat(list.items || []);
      pageToken = list.page_token || '';
    } while (pageToken);
    if (allItems.length > 0) {
      try {
        await fapiJson(this.http, 'DELETE', `/docx/v1/documents/${docId}/blocks/${docId}/children/batch_delete`, { start_index: 0, end_index: allItems.length }, auth.token);
      } catch {
        for (const it of allItems) {
          try {
            await fapiJson(this.http, 'DELETE', `/docx/v1/documents/${docId}/blocks/${it.block_id}`, undefined, auth.token);
          } catch {
            /* 单条删除失败不致命 */
          }
        }
      }
    }
    await fapiJson(this.http, 'POST', `/docx/v1/documents/${docId}/blocks/${docId}/children`, {
      index: 0,
      children: [{ block_type: 14, code: { elements: [{ text_run: { content: jsonStr } }], style: { language: 1 } } }],
    }, auth.token);

    const patch = auth.mode === 'user' ? { userDocumentId: docId } : { documentId: docId };
    await t.upsertSyncState(resumeId, patch);
    return docId;
  }

  /** 写云盘 resume.json：versioned 模式复用 file_token 累积版本历史（v1 writeFile）。 */
  private async writeFile(
    userId: string,
    cfg: SyncRuntimeConfig,
    auth: AuthContext,
    resumeId: string,
    resumeName: string,
    jsonStr: string
  ): Promise<string> {
    const t = this.tenant.forUser(userId);
    const state = (await t.getSyncState(resumeId))[0];
    const existing = auth.mode === 'user' ? state?.userFileToken : state?.fileToken;
    const buf = Buffer.from(jsonStr, 'utf8');
    const fileName = (resumeName || (cfg.fileName || 'resume.json').replace(/\.json$/, '')) + '.json';

    const fields: Record<string, string | number> = {
      file_name: fileName,
      parent_type: 'explorer',
      parent_node: cfg.folderToken || '',
      size: buf.length,
    };
    // 'new' = 每次新建文件（不累积版本）；'versioned' = 复用 file_token 覆盖更新
    if (cfg.fileUploadMode !== 'new' && existing) fields.file_token = existing;

    const d = await fapiMultipart(this.http, '/drive/v1/files/upload_all', fields, buf, auth.token);
    const fileToken = String(d.file_token || '');
    const patch = auth.mode === 'user' ? { userFileToken: fileToken } : { fileToken: fileToken };
    await t.upsertSyncState(resumeId, patch);
    return fileToken;
  }

  /** GET /api/sync/versions?resumeId= —— 版本必须来自同一份云盘文件（file_token），docx 只作人读备份。 */
  async listVersions(userId: string, resumeId: string) {
    const rows = await this.tenant.forUser(userId).getResume(resumeId);
    if (!rows[0]) throw new SyncError(404, '简历不存在');
    const cfg = await this.resolveConfig(userId);
    if (!cfg) throw new SyncError(400, NOT_CONFIGURED);
    const auth = await this.getAuth(userId, cfg);
    const state = (await this.tenant.forUser(userId).getSyncState(resumeId))[0];
    const fileToken = auth.mode === 'user' ? state?.userFileToken : state?.fileToken;
    if (!fileToken) return { authMode: auth.mode, versions: [] };
    try {
      const d = await fapiJson(this.http, 'GET', `/drive/v1/files/${fileToken}/versions?page_size=50`, undefined, auth.token);
      return { authMode: auth.mode, versions: d.items || [] };
    } catch {
      // 版本列表打不通不视为致命（v1 同款：出错返回空列表）
      return { authMode: auth.mode, versions: [] };
    }
  }

  /** POST /api/sync/restore：取回某个版本的内容文本，前端确认后自行 PUT 写回。 */
  async getVersion(userId: string, resumeId: string, versionId: string) {
    if (!versionId) throw new SyncError(400, '缺少 versionId');
    const rows = await this.tenant.forUser(userId).getResume(resumeId);
    if (!rows[0]) throw new SyncError(404, '简历不存在');
    const cfg = await this.resolveConfig(userId);
    if (!cfg) throw new SyncError(400, NOT_CONFIGURED);
    const auth = await this.getAuth(userId, cfg);
    const state = (await this.tenant.forUser(userId).getSyncState(resumeId))[0];
    const fileToken = auth.mode === 'user' ? state?.userFileToken : state?.fileToken;
    if (!fileToken) throw new SyncError(400, '尚未上报过，飞书中没有可用版本');
    const text = await downloadVersionContent(this.http, `/drive/v1/files/${fileToken}/versions/${versionId}/download`, auth.token);
    return { authMode: auth.mode, json: text };
  }

  /* ------------------------------------------------------------ 扫码授权（OAuth 授权码模式） */

  /** POST /api/feishu/oauth/start：生成授权链接；state 记住发起账号（回调是匿名请求）。 */
  async oauthStart(userId: string) {
    const cfg = await this.resolveConfig(userId);
    if (!cfg) throw new SyncError(400, NOT_CONFIGURED);
    const port = process.env.PORT || 3000;
    const redirectUri = `http://127.0.0.1:${port}/api/feishu/oauth/callback`;
    const r = buildAuthorizeUrl({ appId: cfg.appId, redirectUri });
    const state = r.state;
    this.pendingOauth.set(state, { userId, createdAt: Date.now() });
    return { ok: true, authorizeUrl: r.url, state, redirect_uri: redirectUri };
  }

  /** GET /api/feishu/oauth/callback：匿名端点（飞书 302 跨站抵达），靠 state 找回账号。 */
  async oauthCallback(code: string, state: string): Promise<string> {
    // 清理过期 pending
    const now = Date.now();
    for (const [k, v] of this.pendingOauth) {
      if (now - v.createdAt > OAUTH_STATE_TTL_MS) this.pendingOauth.delete(k);
    }
    if (!code) return buildCallbackPage(false, '未收到授权码');
    const pending = state ? this.pendingOauth.get(state) : null;
    if (!pending) return buildCallbackPage(false, '授权会话不存在或已过期，请回到编辑器重新发起扫码');
    this.pendingOauth.delete(state);

    const cfg = await this.resolveConfig(pending.userId);
    if (!cfg) return buildCallbackPage(false, '缺少应用身份（App ID / App Secret），无法换取用户凭证');
    try {
      const j = await this.postTokenEndpoint({
        grant_type: 'authorization_code',
        client_id: cfg.appId,
        client_secret: cfg.appSecret,
        code,
        redirect_uri: `http://127.0.0.1:${process.env.PORT || 3000}/api/feishu/oauth/callback`,
      });
      await this.tenant.forUser(pending.userId).upsertSyncOauth({
        accessToken: j.access_token,
        refreshToken: j.refresh_token || '',
        expiresAt: Date.now() + ((j.expires_in || 3600) - 60) * 1000,
        refreshExpiresAt: j.refresh_expires_in ? Date.now() + (j.refresh_expires_in - 60) * 1000 : 0,
        scope: j.scope || '',
      });
      return buildCallbackPage(true, '');
    } catch (e) {
      return buildCallbackPage(false, (e as Error).message);
    }
  }

  async oauthRevoke(userId: string) {
    await this.tenant.forUser(userId).deleteSyncOauth();
    return { ok: true };
  }

  /* ------------------------------------------------------------ 个人应用注册（Device Flow） */

  /** POST /api/feishu/register/begin：发起设备授权，建会话，返回二维码 URL + user_code。 */
  async registerBegin(userId: string) {
    const res = await postRegisterForm(this.http, DEFAULT_FEISHU_DOMAIN, {
      action: 'begin',
      archetype: 'PersonalAgent',
      auth_method: 'client_secret',
      request_user_info: 'open_id',
    });
    const parsed = parseBeginResponse(res.status, res.json, res.text);
    if (!parsed.ok) throw new SyncError(502, parsed.error);
    const bj = parsed.value;
    const qrUrl = new URL(bj.verification_uri_complete);
    qrUrl.searchParams.set('from', 'sdk');
    qrUrl.searchParams.set('source', `node-sdk/${REGISTER_SOURCE}`);
    qrUrl.searchParams.set('tp', 'sdk');
    qrUrl.searchParams.set('addons', encodeAddons(REGISTER_DEFAULT_ADDONS));

    const token = this.registerSessions.create(userId, {
      deviceCode: bj.device_code,
      domain: DEFAULT_FEISHU_DOMAIN,
      larkDomain: DEFAULT_LARK_DOMAIN,
      interval: bj.interval || 5,
      expiresIn: bj.expires_in || 600,
    });
    return { ok: true, token, qrUrl: qrUrl.toString(), userCode: bj.user_code || '', expireIn: bj.expires_in || 600 };
  }

  /**
   * GET /api/feishu/register/poll：轮询扫码终态。
   * 节流尊重飞书返回的 interval；slow_down 时 interval +5s；终态缓存、会话作废（v1 同款）。
   * 成功时：凭证 + probe 默认项一并落库（v1 只落凭证、默认项靠前端表单回显，v2 一步到位）。
   */
  async registerPoll(userId: string, token: string) {
    const sess = this.registerSessions.find(token, userId);
    if (!sess) throw new SyncError(404, '会话不存在或已过期，请重新发起扫码');
    if (this.registerSessions.isExpired(sess)) {
      this.registerSessions.delete(token);
      return { status: 'expired' };
    }
    if (this.registerSessions.isTerminal(sess) && sess.lastResult) {
      return sess.lastResult; // 终态直接返回缓存，不再打飞书
    }
    const minGap = Math.max(sess.interval - 1, 1) * 1000;
    if (Date.now() - sess.lastPollAt < minGap) {
      return sess.lastResult || { status: 'waiting' }; // 未到间隔，返回上次结果
    }

    const domain = sess.domainSwitched ? sess.larkDomain : sess.domain;
    const res = await postRegisterForm(this.http, domain, { action: 'poll', device_code: sess.deviceCode });
    const mapped = mapPollStatus(res.json || {}, sess);
    sess.lastPollAt = Date.now();

    if (mapped.status === 'slow_down') {
      sess.interval += 5;
      sess.lastResult = { status: 'waiting' };
      return { status: 'waiting' };
    }
    if (mapped.status === 'waiting') {
      sess.lastResult = { status: 'waiting' };
      return { status: 'waiting' };
    }
    if (mapped.status === 'success') {
      sess.lastResult = { status: 'success', appId: mapped.client_id, appSecret: mapped.client_secret };
      this.registerSessions.delete(token); // 凭证已落库，会话作废
      const cur = await this.resolveConfig(userId);
      await this.tenant.forUser(userId).upsertSyncConfig({
        appId: mapped.client_id,
        appSecret: mapped.client_secret,
        domain: cur?.domain || '',
        folderToken: cur?.folderToken || '',
        docTitle: cur?.docTitle || '',
        fileName: cur?.fileName || '',
        fileUploadMode: cur?.fileUploadMode || 'versioned',
        dryRun: cur?.dryRun || false,
      });
      // 自动探测绑定：建默认文件夹 + 回填默认项（失败不致命，可手动重试）
      let probe: Record<string, unknown> | null = null;
      try {
        probe = await this.probeWithCredentials(userId, mapped.client_id, mapped.client_secret);
      } catch (e) {
        probe = { error: (e as Error).message };
      }
      return { status: 'success', appId: mapped.client_id, appSecret: mapped.client_secret, probe };
    }
    // failed / expired
    sess.lastResult = mapped;
    this.registerSessions.delete(token);
    return mapped;
  }

  /** POST /api/feishu/register/cancel：提前作废会话（用户主动关闭二维码）。 */
  async registerCancel(userId: string, token: string) {
    const sess = this.registerSessions.find(token, userId);
    if (sess) this.registerSessions.delete(token);
    return { ok: true };
  }
}
