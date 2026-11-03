import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppModule } from '../src/server/app.module';
import { DB_TOKEN } from '../src/shared/constants';
import { createDatabase, type Database } from '../src/server/db/client';
import { applyMigrations } from '../src/server/db/migrate';
import { hashPassword } from '../src/server/auth/password';
import { TenantDb } from '../src/server/tenant/tenant-db';
import { users, syncState, syncConfigs } from '../src/server/db/schema';
import { SYNC_HTTP, type FeishuHttp, type FeishuHttpResponse } from '../src/server/sync/feishu-client';
import { assertLocalRequest } from '../src/server/security';
import {
  buildAuthorizeUrl,
  buildCallbackPage,
  buildProbeDefaults,
  encodeAddons,
  mapPollStatus,
  normalizeSyncPatch,
  oauthPublicStatus,
  publicSyncConfig,
} from '../src/server/sync/sync-config';
import { eq } from 'drizzle-orm';
import zlib from 'node:zlib';

/* ================================================================ 工具 */

const USER_A = { email: 'a@local.test', password: 'aaaa-pass-123' };
const USER_B = { email: 'b@local.test', password: 'bbbb-pass-123' };
const USER_C = { email: 'c@local.test', password: 'cccc-pass-123' };

let app: NestFastifyApplication;
let db: Database;
let closeDb: () => Promise<void>;
let cookieA = '';
let cookieB = '';
let cookieC = '';

function cookieOf(res: any): string {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return first ? String(first).split(';')[0] : '';
}

async function login(cred: { email: string; password: string }): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: cred,
  });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

async function createResume(cookie: string, id: string, title: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/resumes',
    headers: { 'content-type': 'application/json', cookie },
    payload: { id, title, payload: { data: { sections: [] }, name: title } },
  });
  expect(res.statusCode).toBe(201);
}

/* ================================================================ 飞书桩 */

/**
 * 路由式飞书桩：记录全部请求，按 URL / method / body 关键字分发响应。
 * 测试通过直接改 registerPollPlan / oauthGrant 等可变状态控制场景。
 */
const calls: Array<{ url: string; method: string; body: string | Buffer | undefined }> = [];
const registerPollPlan: Array<Record<string, any>> = [];
let registerAction = 'begin';
let oauthGrant = { access_token: 'user-tok-1', refresh_token: 'ref-1', expires_in: 3600, scope: 'drive:drive' };
let createdFiles = 0;

function jres(status: number, data: Record<string, any> | null): FeishuHttpResponse {
  return { status, text: JSON.stringify(data === null ? {} : { code: 0, data }), json: data === null ? null : { code: 0, data } };
}

function fail(status: number, body: Record<string, any>): FeishuHttpResponse {
  return { status, text: JSON.stringify(body), json: body };
}

const stubHttp: FeishuHttp = async (url, init) => {
  calls.push({ url, method: init.method, body: init.body });
  const u = url.replace('https://open.feishu.cn/open-apis', '');
  const bodyStr = typeof init.body === 'string' ? init.body : '';

  // 应用身份 token
  if (u === '/auth/v3/tenant_access_token/internal') {
    return jres(200, { tenant_access_token: 'tenant-token-1', expire: 7200 });
  }
  // probe 建文件夹
  if (u === '/drive/v1/files/create_folder') {
    return jres(200, { token: 'fld_created_1' });
  }
  // docx
  if (u === '/docx/v1/documents' && init.method === 'POST') {
    return jres(200, { document: { document_id: 'docn_created_' + (++createdFiles) } });
  }
  if (u.startsWith('/docx/v1/documents/') && u.includes('/children') && init.method === 'GET') {
    return jres(200, { items: [], page_token: '' });
  }
  if (u.includes('/children/batch_delete')) {
    return jres(200, {});
  }
  if (u.startsWith('/docx/v1/documents/') && u.endsWith('/children') && init.method === 'POST') {
    return jres(200, { block: { block_id: 'blk_1' } });
  }
  // 云盘上传（multipart）
  if (u === '/drive/v1/files/upload_all') {
    return jres(200, { file_token: 'file_created_' + (++createdFiles) });
  }
  // 版本列表
  if (/\/drive\/v1\/files\/[^/]+\/versions$/.test(u)) {
    return jres(200, { items: [{ version_id: 'ver_1', revision_id: 1 }, { version_id: 'ver_2', revision_id: 2 }] });
  }
  // 版本下载：直接返回 JSON 文本（非 JSON API 响应）
  if (/\/drive\/v1\/files\/[^/]+\/versions\/[^/]+\/download$/.test(u)) {
    return { status: 200, text: '{"name":"from-feishu-version"}', json: null };
  }
  // OAuth token 端点（授权码 / refresh）
  if (url === 'https://open.feishu.cn/open-apis/authen/v2/oauth/token') {
    if (bodyStr.includes('"refresh_token"')) {
      return jres(200, { access_token: 'user-tok-refreshed', refresh_token: 'ref-2', expires_in: 3600, scope: 'drive:drive' });
    }
    return jres(200, oauthGrant);
  }
  // Device Flow（accounts.feishu.cn 表单端点）
  if (url === 'https://accounts.feishu.cn/oauth/v1/app/registration') {
    if (registerAction === 'begin') {
      return jres(200, {
        device_code: 'dev_code_1',
        user_code: 'ABCD-EFGH',
        verification_uri_complete: 'https://accounts.feishu.cn/oauth/v1/device_auth?user_code=ABCD-EFGH',
        interval: 1,
        expires_in: 600,
      });
    }
    const next = registerPollPlan.shift();
    if (!next) return fail(400, { error: 'authorization_pending' });
    return next.client_id ? jres(200, next) : fail(400, next);
  }
  return fail(404, { error: `stub 未覆盖: ${init.method} ${url}` });
};

beforeAll(async () => {
  const handle = await createDatabase(); // 内存库，不落盘、与 dev 的 pgdata 互不冲突
  db = handle.db;
  closeDb = handle.close;
  await applyMigrations(handle.client);

  for (const u of [USER_A, USER_B, USER_C]) {
    await db.insert(users).values({ email: u.email, passwordHash: await hashPassword(u.password), role: 'member' });
  }

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB_TOKEN)
    .useValue(db)
    .overrideProvider(SYNC_HTTP)
    .useValue(stubHttp)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  cookieA = await login(USER_A);
  cookieB = await login(USER_B);
  cookieC = await login(USER_C);
  await createResume(cookieA, 'res_a1', 'A 的简历');
  await createResume(cookieA, 'res_a2', 'A 的简历2');
  await createResume(cookieB, 'res_b1', 'B 的简历');
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

/* ================================================================ 纯函数 */

describe('P2b-II · 纯函数契约（sync-config）', () => {
  it('encodeAddons：gzip → base64 → URL-safe，解码还原且无 + / =', () => {
    const addons = { scopes: { user: ['drive:drive'] } };
    const encoded = encodeAddons(addons);
    expect(encoded).not.toMatch(/[+/=]/);
    const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'));
    expect(decoded).toEqual(addons);
  });

  it('mapPollStatus：五种状态 + lark 域名切换', () => {
    expect(mapPollStatus({ client_id: 'cli_1', client_secret: 'cs_1' }, null).status).toBe('success');
    expect(mapPollStatus({ error: 'authorization_pending' }, null)).toEqual({ status: 'waiting' });
    expect(mapPollStatus({ error: 'slow_down' }, null).status).toBe('slow_down');
    expect(mapPollStatus({ error: 'access_denied' }, null).status).toBe('failed');
    expect(mapPollStatus({ error: 'expired_token' }, null).status).toBe('expired');
    expect(mapPollStatus({ error: 'whatever' }, null).status).toBe('failed');
    const ctx = { domainSwitched: false };
    mapPollStatus({ user_info: { tenant_brand: 'lark' }, error: 'authorization_pending' }, ctx);
    expect(ctx.domainSwitched).toBe(true);
  });

  it('normalizeSyncPatch：secret 留空沿用旧值；首次必填；fileUploadMode 收窄', () => {
    const cur = {
      appId: 'cli_old', appSecret: 'sec_old', domain: 'feishu.cn', folderToken: 'fld_1',
      docTitle: 't', fileName: 'f', fileUploadMode: 'versioned', dryRun: false,
      source: 'database' as const,
    };
    expect(normalizeSyncPatch({ app_id: 'cli_new' }, cur)).toEqual({
      ok: true, value: { appId: 'cli_new', appSecret: 'sec_old', domain: 'feishu.cn', folderToken: 'fld_1', docTitle: 't', fileName: 'f', fileUploadMode: 'versioned', dryRun: false },
    });
    expect(normalizeSyncPatch({ app_id: 'cli_new', app_secret: 's2' }, null)).toEqual({
      ok: true, value: { appId: 'cli_new', appSecret: 's2', domain: '', folderToken: '', docTitle: '', fileName: '', fileUploadMode: 'versioned', dryRun: false },
    });
    expect(normalizeSyncPatch({ app_id: 'cli_new' }, null).ok).toBe(false); // 首次 secret 必填
    expect(normalizeSyncPatch({ app_id: '' }, cur).ok).toBe(false); // app_id 必填
    expect(normalizeSyncPatch({ app_id: 'x', file_upload_mode: 'new' }, cur).value.fileUploadMode).toBe('new');
    expect(normalizeSyncPatch({ app_id: 'x', dryRun: true }, cur).value.dryRun).toBe(true);
  });

  it('publicSyncConfig：永不回传 app_secret 明文', () => {
    const out = publicSyncConfig({
      appId: 'cli_1', appSecret: 'SUPER_SECRET', domain: '', folderToken: '', docTitle: '', fileName: '',
      fileUploadMode: 'versioned', dryRun: false, source: 'database',
    });
    expect(out.configured).toBe(true);
    expect(out.hasSecret).toBe(true);
    expect(JSON.stringify(out)).not.toContain('SUPER_SECRET');
    expect(publicSyncConfig(null).configured).toBe(false);
  });

  it('buildProbeDefaults：空 folder_token 回退根目录 0', () => {
    expect(buildProbeDefaults('')).toEqual({ folder_token: '0', doc_title: '简历数据备份', file_name: 'resume.json', domain: 'feishu.cn', fileUploadMode: 'versioned' });
    expect(buildProbeDefaults('fld_x').folder_token).toBe('fld_x');
  });

  it('buildAuthorizeUrl：含 app_id / redirect_uri / state / scope', () => {
    const r = buildAuthorizeUrl({ appId: 'cli_1', redirectUri: 'http://127.0.0.1:3000/api/feishu/oauth/callback', state: 'st1' });
    expect(r.url).toContain('app_id=cli_1');
    expect(r.url).toContain(encodeURIComponent('http://127.0.0.1:3000/api/feishu/oauth/callback'));
    expect(r.url).toContain('state=st1');
    expect(r.url).toContain('scope=');
    expect(() => buildAuthorizeUrl({ appId: '', redirectUri: 'x' })).toThrow();
  });

  it('oauthPublicStatus：authorized 语义，绝不回传 token', () => {
    expect(oauthPublicStatus(null, 1000).authorized).toBe(false);
    const s = oauthPublicStatus({ accessToken: 'TOK', refreshToken: 'R', scope: 's', expiresAt: 2000, refreshExpiresAt: 2000, updatedAt: 1000 }, 1000);
    expect(s).toEqual({ authorized: true, scope: 's', expires_at: 2000, updated_at: 1000, hasRefresh: true });
    expect(JSON.stringify(s)).not.toContain('TOK');
    // refresh 过期 → hasRefresh=false
    expect(oauthPublicStatus({ accessToken: 'T', refreshToken: 'R', expiresAt: 2000, refreshExpiresAt: 1500 }, 1000).hasRefresh).toBe(false);
  });

  it('buildCallbackPage：成功页自动关闭；失败页转义尖括号', () => {
    const ok = buildCallbackPage(true, '');
    expect(ok).toContain('授权成功');
    expect(ok).toContain('window.close');
    const bad = buildCallbackPage(false, 'a<script>b</script>');
    expect(bad).not.toContain('<script>b');
    expect(bad).toContain('&lt;script&gt;');
  });
});

/* ================================================================ 回环守卫豁免 */

describe('P2b-II · 回环守卫：OAuth 回调跨站豁免', () => {
  const cbHeaders = { host: '127.0.0.1:3000', 'sec-fetch-site': 'cross-site' };

  it('回调路径 + 跨站 GET → 放行', () => {
    expect(assertLocalRequest(cbHeaders, 'GET', '/api/feishu/oauth/callback?code=x&state=y').ok).toBe(true);
  });
  it('其他路径跨站 → 仍拒绝', () => {
    expect(assertLocalRequest(cbHeaders, 'GET', '/api/sync/config').ok).toBe(false);
  });
  it('回调路径非 GET → 不豁免（防跨站写）', () => {
    expect(assertLocalRequest(cbHeaders, 'POST', '/api/feishu/oauth/callback').ok).toBe(false);
  });
  it('回调路径 Host 非回环 → 仍拒绝（防 DNS rebinding）', () => {
    expect(assertLocalRequest({ host: 'evil.example.com' }, 'GET', '/api/feishu/oauth/callback').ok).toBe(false);
  });
  it('前缀伪造（/api/feishu/oauth/callback/../x）不越权：非精确前缀不豁免', () => {
    expect(assertLocalRequest(cbHeaders, 'GET', '/api/feishu/oauth/callbackX').ok).toBe(false);
  });
});

/* ================================================================ HTTP e2e */

describe('P2b-II · 配置 API 与行级隔离', () => {
  it('未登录：同步端点全 401（OAuth 回调除外）', async () => {
    for (const [method, url] of [
      ['GET', '/api/sync/config'],
      ['PUT', '/api/sync/config'],
      ['DELETE', '/api/sync/config'],
      ['POST', '/api/sync/probe'],
      ['POST', '/api/sync/report/res_a1'],
      ['GET', '/api/sync/versions?resumeId=res_a1'],
      ['POST', '/api/sync/restore'],
      ['POST', '/api/feishu/oauth/start'],
      ['POST', '/api/feishu/oauth/revoke'],
      ['POST', '/api/feishu/register/begin'],
      ['GET', '/api/feishu/register/poll?token=x'],
      ['POST', '/api/feishu/register/cancel?token=x'],
    ]) {
      const res = await app.inject({ method: method as any, url, headers: { 'content-type': 'application/json' }, payload: method === 'GET' || method === 'DELETE' ? undefined : {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('初始状态：未配置 + 未授权 + 提示语', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sync/config', headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.configured).toBe(false);
    expect(body.hasSecret).toBe(false);
    expect(body.oauth.authorized).toBe(false);
    expect(body.hint).toContain('未配置');
  });

  it('保存配置 → 脱敏回读：configured=true、hasSecret=true、无明文', async () => {
    const save = await app.inject({
      method: 'PUT', url: '/api/sync/config',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      payload: { app_id: 'cli_app_1', app_secret: 'SECRET_A', domain: 'feishu.cn', dryRun: false },
    });
    expect(save.statusCode).toBe(200);
    expect(JSON.stringify(save.json())).not.toContain('SECRET_A');
    const get = await app.inject({ method: 'GET', url: '/api/sync/config', headers: { cookie: cookieA } });
    const body = get.json();
    expect(body.configured).toBe(true);
    expect(body.hasSecret).toBe(true);
    expect(body.source).toBe('database');
    expect(JSON.stringify(body)).not.toContain('SECRET_A');
  });

  it('A 的配置不串给 B（B 仍是未配置）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sync/config', headers: { cookie: cookieB } });
    expect(res.json().configured).toBe(false);
  });

  it('PUT 缺 app_id → 400；首次缺 secret → 400', async () => {
    const r1 = await app.inject({
      method: 'PUT', url: '/api/sync/config',
      headers: { 'content-type': 'application/json', cookie: cookieB },
      payload: { app_secret: 'x' },
    });
    expect(r1.statusCode).toBe(400);
    const r2 = await app.inject({
      method: 'PUT', url: '/api/sync/config',
      headers: { 'content-type': 'application/json', cookie: cookieB },
      payload: { app_id: 'cli_b' },
    });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().message).toContain('首次配置必填');
  });

  it('secret 留空保存 = 沿用旧值（不丢失凭证）', async () => {
    const save = await app.inject({
      method: 'PUT', url: '/api/sync/config',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      payload: { app_id: 'cli_app_1', doc_title: '改名了' },
    });
    expect(save.statusCode).toBe(200);
    expect(save.json().configured).toBe(true); // 仍有 secret（沿用）
    expect(save.json().config.doc_title).toBe('改名了');
  });

  it('probe：表单凭证 → 验证 + 建文件夹 + 默认项直接落库', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sync/probe',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().folder_token).toBe('fld_created_1');
    const get = await app.inject({ method: 'GET', url: '/api/sync/config', headers: { cookie: cookieA } });
    expect(get.json().config.folder_token).toBe('fld_created_1');
    expect(get.json().config.doc_title).toBe('简历数据备份');
  });

  it('probe 前先落库表单凭证：留空回退已保存凭证可探测', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sync/probe',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      payload: { app_id: 'cli_app_1' }, // secret 留空 → 用已保存的
    });
    expect(res.statusCode).toBe(200);
  });

  it('未配置 probe → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sync/probe',
      headers: { 'content-type': 'application/json', cookie: cookieB },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('DELETE config = 显式停用：不再回退、不再 configured', async () => {
    await app.inject({
      method: 'PUT', url: '/api/sync/config',
      headers: { 'content-type': 'application/json', cookie: cookieB },
      payload: { app_id: 'cli_b', app_secret: 'SECRET_B' },
    });
    const del = await app.inject({ method: 'DELETE', url: '/api/sync/config', headers: { cookie: cookieB } });
    expect(del.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: '/api/sync/config', headers: { cookie: cookieB } });
    expect(get.json().configured).toBe(false);
    expect(get.json().source).toBe('database'); // 空行存在 = 显式停用，不回退 v1 文件
  });
});

describe('P2b-II · 上报 / 版本 / 恢复', () => {
  it('未配置上报 → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/sync/report/res_b1', headers: { cookie: cookieB } });
    expect(res.statusCode).toBe(400);
  });

  it('dryRun=true：整条链路不打外网，返回占位结果', async () => {
    const save = await app.inject({
      method: 'PUT', url: '/api/sync/config',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      payload: { app_id: 'cli_app_1', dryRun: true },
    });
    expect(save.statusCode).toBe(200);
    calls.length = 0;
    const res = await app.inject({ method: 'POST', url: '/api/sync/report/res_a1', headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(200);
    expect(res.json().dryRun).toBe(true);
    expect(calls.length).toBe(0);
  });

  it('真实链路：上报 → docx + 云盘双写，锚点落 app 列，authMode=app', async () => {
    await app.inject({
      method: 'PUT', url: '/api/sync/config',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      payload: { app_id: 'cli_app_1', dryRun: false },
    });
    const res = await app.inject({ method: 'POST', url: '/api/sync/report/res_a1', headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.authMode).toBe('app');
    expect(body.docUrl).toContain('feishu.cn/docx/');
    expect(body.fileUrl).toContain('feishu.cn/file/');
    // 锚点落在 app 列，user 列保持空（分列即 v1 的分键隔离）
    const tenant = new TenantDb(db);
    const st = (await tenant.forUser((await db.select().from(users).where(eq(users.email, USER_A.email)).limit(1))[0].id).getSyncState('res_a1'))[0];
    expect(st.fileToken).toContain('file_created_');
    expect(st.documentId).toContain('docn_created_');
    expect(st.userFileToken).toBe('');
    expect(st.userDocumentId).toBe('');
  });

  it('别人的简历 → 404（不泄露存在性）', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/sync/report/res_b1', headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(404);
  });

  it('版本列表：来自同一云盘文件；别人的简历 → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sync/versions?resumeId=res_a1', headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(200);
    expect(res.json().versions).toHaveLength(2);
    expect(res.json().versions[0].version_id).toBe('ver_1');
    const b = await app.inject({ method: 'GET', url: '/api/sync/versions?resumeId=res_a1', headers: { cookie: cookieB } });
    expect(b.statusCode).toBe(404);
  });

  it('恢复：取回版本内容文本（不直接覆盖）', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sync/restore',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      payload: { resumeId: 'res_a1', versionId: 'ver_1' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.json().json)).toEqual({ name: 'from-feishu-version' });
  });

  it('未上报过的简历恢复 → 400「尚未上报过」', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sync/restore',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      payload: { resumeId: 'res_a2', versionId: 'ver_1' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('尚未上报过');
  });
});

describe('P2b-II · 扫码授权（OAuth 授权码模式）', () => {
  it('未配置 → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/feishu/oauth/start', headers: { cookie: cookieB } });
    expect(res.statusCode).toBe(400);
  });

  it('start → 授权链接 + state；未知 state 回调 → 失败页', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/feishu/oauth/start', headers: { cookie: cookieA } });
    expect(start.statusCode).toBe(200);
    expect(start.json().authorizeUrl).toContain('app_id=cli_app_1');
    const bad = await app.inject({ method: 'GET', url: '/api/feishu/oauth/callback?code=stealed&state=not-exist' });
    expect(bad.statusCode).toBe(200); // 回调页永远 200（HTML），错误在页面上说明
    expect(bad.headers['content-type']).toContain('text/html');
    expect(bad.body).toContain('授权会话不存在或已过期');
  });

  it('正常回调：state 找回账号 → 凭证落 sync_oauth → 授权成功页', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/feishu/oauth/start', headers: { cookie: cookieA } });
    const { state } = start.json();
    const cb = await app.inject({ method: 'GET', url: `/api/feishu/oauth/callback?code=authcode123&state=${state}` });
    expect(cb.headers['content-type']).toContain('text/html');
    expect(cb.body).toContain('授权成功');
    const st = await app.inject({ method: 'GET', url: '/api/sync/config', headers: { cookie: cookieA } });
    expect(st.json().oauth.authorized).toBe(true);
    expect(JSON.stringify(st.json())).not.toContain('user-tok-1');
  });

  it('授权后上报走用户身份：authMode=user、锚点落 user 列（与 app 列互不串写）', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/sync/report/res_a1', headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(200);
    expect(res.json().authMode).toBe('user');
    const tenant = new TenantDb(db);
    const st = (await tenant.forUser((await db.select().from(users).where(eq(users.email, USER_A.email)).limit(1))[0].id).getSyncState('res_a1'))[0];
    expect(st.userFileToken).toContain('file_created_');
    expect(st.userDocumentId).toContain('docn_created_');
    expect(st.fileToken).toContain('file_created_'); // 之前的 app 锚点仍在
  });

  it('token 过期 + refresh 可用 → 自动刷新后仍走用户身份', async () => {
    const userId = (await db.select().from(users).where(eq(users.email, USER_A.email)).limit(1))[0].id;
    // 直接把 oauth 行改成已过期（refresh 仍有效）
    await db.update(syncConfigs).set({}).where(eq(syncConfigs.userId, userId));
    const tenant = new TenantDb(db);
    const row = (await tenant.forUser(userId).getSyncOauth())[0];
    await tenant.forUser(userId).upsertSyncOauth({
      accessToken: row.accessToken, refreshToken: row.refreshToken,
      expiresAt: Date.now() - 1000, refreshExpiresAt: Date.now() + 3600_000, scope: row.scope,
    });
    const res = await app.inject({ method: 'POST', url: '/api/sync/report/res_a2', headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(200);
    expect(res.json().authMode).toBe('user');
  });

  it('解除授权 → 回退应用身份，app 锚点不受影响', async () => {
    const rev = await app.inject({ method: 'POST', url: '/api/feishu/oauth/revoke', headers: { cookie: cookieA } });
    expect(rev.statusCode).toBe(200);
    const st = await app.inject({ method: 'GET', url: '/api/sync/config', headers: { cookie: cookieA } });
    expect(st.json().oauth.authorized).toBe(false);
    const res = await app.inject({ method: 'POST', url: '/api/sync/report/res_a1', headers: { cookie: cookieA } });
    expect(res.json().authMode).toBe('app');
  });
});

describe('P2b-II · 个人应用注册（Device Flow）', () => {
  it('begin → token + 二维码 URL（addons 为 URL-safe base64）', async () => {
    registerAction = 'begin';
    const res = await app.inject({ method: 'POST', url: '/api/feishu/register/begin', headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toBeTruthy();
    expect(body.qrUrl).toContain('addons=');
    expect(body.qrUrl).not.toMatch(/[+/=]/);
    expect(body.userCode).toBe('ABCD-EFGH');
  });

  it('poll：waiting；节流窗口内再 poll 不打飞书', async () => {
    registerAction = 'poll';
    registerPollPlan.length = 0;
    registerPollPlan.push({ error: 'authorization_pending' });
    const begin = await app.inject({ method: 'POST', url: '/api/feishu/register/begin', headers: { cookie: cookieA } });
    const token = begin.json().token;
    calls.length = 0;
    const p1 = await app.inject({ method: 'GET', url: `/api/feishu/register/poll?token=${token}`, headers: { cookie: cookieA } });
    expect(p1.statusCode).toBe(200);
    expect(p1.json().status).toBe('waiting');
    expect(calls.length).toBe(1);
    // 未到 interval（stub 给 1s，minGap=1s）：立即再 poll 不应打飞书
    const p2 = await app.inject({ method: 'GET', url: `/api/feishu/register/poll?token=${token}`, headers: { cookie: cookieA } });
    expect(p2.json().status).toBe('waiting');
    expect(calls.length).toBe(1);
  });

  it('success：凭证 + probe 默认项一并落库，会话作废（再 poll → 404）', async () => {
    registerAction = 'begin';
    const begin = await app.inject({ method: 'POST', url: '/api/feishu/register/begin', headers: { cookie: cookieA } });
    const token = begin.json().token;
    registerAction = 'poll';
    registerPollPlan.length = 0;
    registerPollPlan.push({ client_id: 'cli_auto_1', client_secret: 'sec_auto_1' });
    await new Promise((r) => setTimeout(r, 1100)); // 过节流窗口
    const poll = await app.inject({ method: 'GET', url: `/api/feishu/register/poll?token=${token}`, headers: { cookie: cookieA } });
    expect(poll.statusCode).toBe(200);
    const body = poll.json();
    expect(body.status).toBe('success');
    expect(body.appId).toBe('cli_auto_1');
    expect(body.probe.folder_token).toBe('fld_created_1'); // probe 自动回填
    const cfg = await app.inject({ method: 'GET', url: '/api/sync/config', headers: { cookie: cookieA } });
    expect(cfg.json().config.app_id).toBe('cli_auto_1');
    expect(cfg.json().config.folder_token).toBe('fld_created_1');
    expect(JSON.stringify(cfg.json())).not.toContain('sec_auto_1');
    const again = await app.inject({ method: 'GET', url: `/api/feishu/register/poll?token=${token}`, headers: { cookie: cookieA } });
    expect(again.statusCode).toBe(404);
  });

  it('B 拿 A 的注册 token poll → 404（会话按账号隔离）', async () => {
    registerAction = 'begin';
    const begin = await app.inject({ method: 'POST', url: '/api/feishu/register/begin', headers: { cookie: cookieA } });
    const token = begin.json().token;
    const poll = await app.inject({ method: 'GET', url: `/api/feishu/register/poll?token=${token}`, headers: { cookie: cookieB } });
    expect(poll.statusCode).toBe(404);
  });

  it('slow_down → interval+5；cancel 后 poll → 404', async () => {
    registerAction = 'begin';
    const begin = await app.inject({ method: 'POST', url: '/api/feishu/register/begin', headers: { cookie: cookieA } });
    const token = begin.json().token;
    registerAction = 'poll';
    registerPollPlan.length = 0;
    registerPollPlan.push({ error: 'slow_down' });
    const p1 = await app.inject({ method: 'GET', url: `/api/feishu/register/poll?token=${token}`, headers: { cookie: cookieA } });
    expect(p1.json().status).toBe('waiting'); // slow_down 对外表现为 waiting
    calls.length = 0;
    // slow_down 后 interval=6s：立即再 poll 必须被节流（不打飞书）
    const p2 = await app.inject({ method: 'GET', url: `/api/feishu/register/poll?token=${token}`, headers: { cookie: cookieA } });
    expect(p2.json().status).toBe('waiting');
    expect(calls.length).toBe(0);
    const cancel = await app.inject({ method: 'POST', url: `/api/feishu/register/cancel?token=${token}`, headers: { cookie: cookieA } });
    expect(cancel.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: `/api/feishu/register/poll?token=${token}`, headers: { cookie: cookieA } });
    expect(after.statusCode).toBe(404);
  });
});

describe('P2b-II · v1 sync.config.json 只读回退', () => {
  it('C（从未保存过 DB 配置）回退读取 v1 文件：source=legacy-file、凭证可用', async () => {
    const tmp = path.join(os.tmpdir(), `rs-sync-legacy-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ app_id: 'cli_legacy', app_secret: 'sec_legacy', folder_token: 'fld_legacy' }), 'utf8');
    process.env.SYNC_CONFIG_FILE = tmp;
    try {
      const res = await app.inject({ method: 'GET', url: '/api/sync/config', headers: { cookie: cookieC } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.configured).toBe(true);
      expect(body.source).toBe('legacy-file');
      expect(body.config.app_id).toBe('cli_legacy');
      expect(body.config.folder_token).toBe('fld_legacy');
      expect(JSON.stringify(body)).not.toContain('sec_legacy');
      // legacy 凭证可直接上报（回退配置参与 getAuth，不打真网）
      const report = await app.inject({ method: 'POST', url: '/api/sync/report/res_a1', headers: { cookie: cookieC } });
      expect(report.statusCode).toBe(404); // C 没有这份简历 → 404 优先于配置判定
    } finally {
      delete process.env.SYNC_CONFIG_FILE;
      try { fs.unlinkSync(tmp); } catch { /* noop */ }
    }
  });

  it('显式停用（空 DB 行）优先于 v1 文件回退：B 停用后不受 legacy 文件影响', async () => {
    const tmp = path.join(os.tmpdir(), `rs-sync-legacy2-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ app_id: 'cli_legacy', app_secret: 'sec_legacy' }), 'utf8');
    process.env.SYNC_CONFIG_FILE = tmp;
    try {
      const res = await app.inject({ method: 'GET', url: '/api/sync/config', headers: { cookie: cookieB } });
      expect(res.json().source).toBe('database');
      expect(res.json().configured).toBe(false); // 空行 = 停用，绝不回退
    } finally {
      delete process.env.SYNC_CONFIG_FILE;
      try { fs.unlinkSync(tmp); } catch { /* noop */ }
    }
  });
});
