import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { AppModule } from '../src/server/app.module';
import { DB_TOKEN } from '../src/shared/constants';
import { createDatabase, type Database } from '../src/server/db/client';
import { applyMigrations } from '../src/server/db/migrate';
import { hashPassword, verifyPassword } from '../src/server/auth/password';
import { TenantDb } from '../src/server/tenant/tenant-db';
import { assertLocalRequest } from '../src/server/security';
import { users } from '../src/server/db/schema';

let app: NestFastifyApplication;
let db: Database;
let closeDb: () => Promise<void>;

const ADMIN = { email: 'admin@local.test', password: 'admin-pass-123' };
const USER_A = { email: 'a@local.test', password: 'aaaa-pass-123' };
const USER_B = { email: 'b@local.test', password: 'bbbb-pass-123' };
const USER_C = { email: 'c@local.test', password: 'cccc-pass-123' };

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

async function createResume(cookie: string, title: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/resumes',
    headers: { 'content-type': 'application/json', cookie },
    payload: { title, payload: { sections: [{ id: 's1', title: '个人优势' }] } },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

beforeAll(async () => {
  const handle = await createDatabase(); // 内存库，测试之间不落盘
  db = handle.db;
  closeDb = handle.close;
  await applyMigrations(handle.client);

  // 账号一律平等：不再写入任何角色；users.role 物理列保留以兼容存量数据，
  // 但建号默认值 'member' 不再被任何产品行为读取。ADMIN 只是历史命名，视为普通账号。
  for (const u of [ADMIN, USER_A, USER_B, USER_C]) {
    await db.insert(users).values({
      email: u.email,
      passwordHash: await hashPassword(u.password),
    });
  }

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB_TOKEN)
    .useValue(db)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  if (app) await app.close();
  if (closeDb) await closeDb();
});

describe('P0 · 账号登录与会话', () => {
  it('Argon2id 哈希可验证且不相同', async () => {
    const h = await hashPassword('hello-world-123');
    expect(h.startsWith('$argon2')).toBe(true);
    expect(h).not.toContain('hello-world-123');
    expect(await verifyPassword(h, 'hello-world-123')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
  });

  it('未登录访问受保护接口返回 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/resumes' });
    expect(res.statusCode).toBe(401);
  });

  it('错误密码 / 不存在的账号返回 401，且不泄露账号是否存在', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: ADMIN.email, password: 'totally-wrong' },
    });
    const missing = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'nobody@local.test', password: 'whatever-123' },
    });
    expect(bad.statusCode).toBe(401);
    expect(missing.statusCode).toBe(401);
    expect(bad.json().message).toBe(missing.json().message);
  });

  it('登录成功写入 HttpOnly + SameSite=Lax 会话 cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: ADMIN,
    });
    expect(res.statusCode).toBe(200);
    const raw = String(res.headers['set-cookie']);
    expect(raw).toContain('rs_sid=');
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
    expect(res.json().user.email).toBe(ADMIN.email);
    expect(res.json().user).not.toHaveProperty('passwordHash');
  });

  it('GET /api/auth/me 返回当前身份', async () => {
    const cookie = await login(ADMIN);
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe(ADMIN.email);
    // 去角色化：身份里不得再携带 role，也不得有等价的权限等级字段。
    expect(res.json().user).not.toHaveProperty('role');
    expect(res.json().user).not.toHaveProperty('isAdmin');
  });

  it('登出后会话立即失效', async () => {
    const cookie = await login(USER_A);
    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(out.statusCode).toBe(200);
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');

    const after = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });
});

describe('P0 · 行级数据隔离（核心）', () => {
  it('A 的简历 B 读不到：单条 404，且列表里也不出现', async () => {
    const cookieA = await login(USER_A);
    const cookieB = await login(USER_B);
    const id = await createResume(cookieA, 'A 的私有简历');

    const one = await app.inject({
      method: 'GET',
      url: `/api/resumes/${id}`,
      headers: { cookie: cookieB },
    });
    expect(one.statusCode).toBe(404);

    const list = await app.inject({
      method: 'GET',
      url: '/api/resumes',
      headers: { cookie: cookieB },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().some((r: any) => r.id === id)).toBe(false);
  });

  it('B 改 / 删 A 的简历同样 404，不产生越权副作用', async () => {
    const cookieA = await login(USER_A);
    const cookieB = await login(USER_B);
    const id = await createResume(cookieA, 'A 的另一份简历');

    const put = await app.inject({
      method: 'PUT',
      url: `/api/resumes/${id}`,
      headers: { 'content-type': 'application/json', cookie: cookieB },
      payload: { title: '被 B 篡改' },
    });
    expect(put.statusCode).toBe(404);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/resumes/${id}`,
      headers: { cookie: cookieB },
    });
    expect(del.statusCode).toBe(404);

    const own = await app.inject({
      method: 'GET',
      url: `/api/resumes/${id}`,
      headers: { cookie: cookieA },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().title).toBe('A 的另一份简历');
  });

  it('TenantDb.forUser 拒绝空 userId，结构上杜绝漏过滤', () => {
    const tenant = new TenantDb(db);
    expect(() => tenant.forUser('')).toThrow(/必须传入 userId/);
  });

  it('简历 payload 以 jsonb 原样存读', async () => {
    const cookie = await login(USER_A);
    const id = await createResume(cookie, 'JSONB 校验');
    const res = await app.inject({
      method: 'GET',
      url: `/api/resumes/${id}`,
      headers: { cookie },
    });
    expect(res.json().payload.sections[0].title).toBe('个人优势');
  });
});

describe('P0 · 账号平权与无跨账号管理', () => {
  it('任意账号行为一致，且不存在账号列表 / 停用他人账号的入口', async () => {
    const cookies = [await login(ADMIN), await login(USER_A), await login(USER_B)];
    const rows = await db.select().from(users).where(eq(users.email, USER_C.email)).limit(1);

    // 旧「管理员专属」接口已整体移除：账号列表与停用他人一律 404，
    // 且对所有账号一视同仁（不再有 403 / 200 的角色差异）。
    for (const cookie of cookies) {
      const list = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie } });
      expect(list.statusCode).toBe(404);

      const disable = await app.inject({
        method: 'POST',
        url: `/api/users/${rows[0].id}/disable`,
        headers: { cookie },
      });
      expect(disable.statusCode).toBe(404);

      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
      expect(me.statusCode).toBe(200);
      expect(me.json().user).not.toHaveProperty('role');
    }
  });

  it('自助创建账号：无需授权、无角色，新账号独立且可登录', async () => {
    const email = 'newbie@local.test';
    // 不携带任何会话 cookie：本地自助建号，不依赖管理员。
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { 'content-type': 'application/json' },
      payload: { email, password: 'newbie-pass-123' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().email).toBe(email);
    expect(created.json()).not.toHaveProperty('passwordHash');
    expect(created.json()).not.toHaveProperty('role');

    const cookie = await login({ email, password: 'newbie-pass-123' });
    expect(cookie).toContain('rs_sid=');

    // 新账号与其他账号互不隶属：看不到别人的数据。
    const otherId = await createResume(await login(USER_A), 'A 的私有简历');
    const cross = await app.inject({
      method: 'GET',
      url: `/api/resumes/${otherId}`,
      headers: { cookie },
    });
    expect(cross.statusCode).toBe(404);
  });

  it('停用他人账号能力已移除，任何账号的会话不受影响', async () => {
    const victimCookie = await login(USER_C);
    const rows = await db.select().from(users).where(eq(users.email, USER_C.email)).limit(1);
    const disabled = await app.inject({
      method: 'POST',
      url: `/api/users/${rows[0].id}/disable`,
      headers: { cookie: await login(ADMIN) },
    });
    expect(disabled.statusCode).toBe(404);

    const after = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: victimCookie },
    });
    expect(after.statusCode).toBe(200);
  });
});

describe('P0 · 本地回环安全守卫', () => {
  it('放行回环 Host / Vite 代理 Origin', () => {
    expect(assertLocalRequest({ host: '127.0.0.1:3000' }, 'GET').ok).toBe(true);
    expect(
      assertLocalRequest(
        { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' },
        'POST'
      ).ok
    ).toBe(true);
  });

  it('拒绝外部 Host、跨站 Origin、cross-site', () => {
    expect(assertLocalRequest({ host: 'evil.example.com' }, 'GET').ok).toBe(false);
    expect(
      assertLocalRequest({ host: '127.0.0.1:3000', origin: 'https://evil.example.com' }, 'POST').ok
    ).toBe(false);
    expect(
      assertLocalRequest(
        { host: '127.0.0.1:3000', 'sec-fetch-site': 'cross-site' },
        'POST'
      ).ok
    ).toBe(false);
  });
});

describe('P0 · 开发免登录（DEV_SKIP_AUTH，仅开发期）', () => {
  it('DEV_SKIP_AUTH=true 时免密码登录并拿到有效会话', async () => {
    const prev = process.env.DEV_SKIP_AUTH;
    process.env.DEV_SKIP_AUTH = 'true';
    try {
      const res = await app.inject({ method: 'POST', url: '/api/auth/dev-login' });
      expect(res.statusCode).toBe(200);
      const cookie = cookieOf(res);
      expect(cookie).toContain('rs_sid=');
      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
      expect(me.statusCode).toBe(200);
      // 账号一律平等，不再「优先选 admin」：只要落到库内任一有效账号即可。
      const emails = (await db.select({ email: users.email }).from(users)).map((r) => r.email);
      expect(emails).toContain(me.json().user.email);
      expect(me.json().user).not.toHaveProperty('role');
    } finally {
      if (prev === undefined) delete process.env.DEV_SKIP_AUTH;
      else process.env.DEV_SKIP_AUTH = prev;
    }
  });

  it('DEV_USER_EMAIL 指定账号时精确落到该账号', async () => {
    const prevAuth = process.env.DEV_SKIP_AUTH;
    const prevEmail = process.env.DEV_USER_EMAIL;
    process.env.DEV_SKIP_AUTH = 'true';
    process.env.DEV_USER_EMAIL = USER_B.email;
    try {
      const res = await app.inject({ method: 'POST', url: '/api/auth/dev-login' });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.email).toBe(USER_B.email);
    } finally {
      if (prevAuth === undefined) delete process.env.DEV_SKIP_AUTH;
      else process.env.DEV_SKIP_AUTH = prevAuth;
      if (prevEmail === undefined) delete process.env.DEV_USER_EMAIL;
      else process.env.DEV_USER_EMAIL = prevEmail;
    }
  });

  it('默认（未设置）时 dev-login 返回 401，不破坏生产隔离', async () => {
    const prev = process.env.DEV_SKIP_AUTH;
    delete process.env.DEV_SKIP_AUTH;
    try {
      const res = await app.inject({ method: 'POST', url: '/api/auth/dev-login' });
      expect(res.statusCode).toBe(401);
    } finally {
      if (prev !== undefined) process.env.DEV_SKIP_AUTH = prev;
    }
  });
});
