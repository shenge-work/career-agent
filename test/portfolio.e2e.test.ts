import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/server/app.module';
import { DB_TOKEN } from '../src/shared/constants';
import { createDatabase, type Database } from '../src/server/db/client';
import { applyMigrations } from '../src/server/db/migrate';
import { hashPassword } from '../src/server/auth/password';
import { users } from '../src/server/db/schema';

let app: NestFastifyApplication;
let db: Database;
let closeDb: () => Promise<void>;

const A = { email: 'a@local.test', password: 'aaaa-pass-123' };
const B = { email: 'b@local.test', password: 'bbbb-pass-123' };

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

async function call(method: Method, url: string, cookie?: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload !== undefined ? { payload } : {}),
  });
}

async function login(cred: { email: string; password: string }): Promise<string> {
  const res = await call('POST', '/api/auth/login', undefined, cred);
  expect(res.statusCode).toBe(200);
  const raw = res.headers['set-cookie'];
  return String(Array.isArray(raw) ? raw[0] : raw).split(';')[0];
}

beforeAll(async () => {
  const handle = await createDatabase();
  db = handle.db;
  closeDb = handle.close;
  await applyMigrations(handle.client);

  for (const u of [A, B]) {
    await db.insert(users).values({
      email: u.email,
      passwordHash: await hashPassword(u.password),
      role: 'member',
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

describe('N13 · 个人作品集站点（portfolios）', () => {
  it('未登录访问作品集接口全部 401', async () => {
    expect((await call('GET', '/api/portfolios')).statusCode).toBe(401);
    expect((await call('GET', '/api/portfolios/templates')).statusCode).toBe(401);
    expect((await call('POST', '/api/portfolios')).statusCode).toBe(401);
    expect((await call('GET', '/api/portfolios/whatever')).statusCode).toBe(401);
    expect((await call('GET', '/api/portfolios/whatever/render')).statusCode).toBe(401);
  });

  it('模板画廊返回 3 套内置模板', async () => {
    const a = await login(A);
    const res = await call('GET', '/api/portfolios/templates', a);
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list.length).toBe(3);
    expect(list.map((t: any) => t.id).sort()).toEqual(['dark-tech', 'magazine', 'minimal']);
  });

  it('创建作品集：title 必填、默认 minimal 模板', async () => {
    const a = await login(A);
    const created = await call('POST', '/api/portfolios', a, { title: '我的作品集' });
    expect(created.statusCode).toBe(201);
    expect(created.json().title).toBe('我的作品集');
    expect(created.json().templateId).toBe('minimal');
    expect(created.json().payload).toEqual({});
  });

  it('title 为空返回 400，非法模板返回 400', async () => {
    const a = await login(A);
    expect((await call('POST', '/api/portfolios', a, { title: '   ' })).statusCode).toBe(400);
    expect(
      (await call('POST', '/api/portfolios', a, { title: 'x', templateId: 'not-exist' })).statusCode
    ).toBe(400);
  });

  it('换模板 + 保存内容后，渲染出含该内容的 HTML', async () => {
    const a = await login(A);
    const pf = (await call('POST', '/api/portfolios', a, { title: '作品集' })).json();

    const updated = await call('PUT', `/api/portfolios/${pf.id}`, a, {
      templateId: 'dark-tech',
      payload: {
        name: '张三',
        title: '高级前端工程师',
        headline: '让每一行代码都恰到好处',
        bio: '我是一名前端工程师',
        skills: ['React', 'TypeScript'],
        projects: [{ name: '项目A', desc: '一个项目' }],
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().templateId).toBe('dark-tech');

    const rendered = await call('GET', `/api/portfolios/${pf.id}/render`, a);
    expect(rendered.statusCode).toBe(200);
    const html = rendered.json().html as string;
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('张三');
    expect(html).toContain('高级前端工程师');
    expect(html).toContain('React');
    // 深色科技模板应有终端风格标记
    expect(html).toContain('$ whoami');
  });

  it('行级隔离：A 的作品集 B 读不到（单条/列表/改/删/render 均 404 或不出现）', async () => {
    const a = await login(A);
    const b = await login(B);
    const pf = (await call('POST', '/api/portfolios', a, { title: 'A 的私有作品集' })).json();
    const id = pf.id;

    expect((await call('GET', `/api/portfolios/${id}`, b)).statusCode).toBe(404);
    expect((await call('GET', `/api/portfolios/${id}/render`, b)).statusCode).toBe(404);
    expect((await call('PUT', `/api/portfolios/${id}`, b, { title: '改' })).statusCode).toBe(404);
    expect((await call('DELETE', `/api/portfolios/${id}`, b)).statusCode).toBe(404);

    const listB = await call('GET', '/api/portfolios', b);
    expect(listB.json().some((r: any) => r.id === id)).toBe(false);

    const own = await call('GET', `/api/portfolios/${id}`, a);
    expect(own.json().title).toBe('A 的私有作品集');
  });

  it('删除作品集', async () => {
    const a = await login(A);
    const pf = (await call('POST', '/api/portfolios', a, { title: '待删作品集' })).json();
    expect((await call('DELETE', `/api/portfolios/${pf.id}`, a)).statusCode).toBe(200);
    expect((await call('GET', `/api/portfolios/${pf.id}`, a)).statusCode).toBe(404);
  });

  it('发布：repo 为空或非法格式返回 400（不触发真实 git）', async () => {
    const a = await login(A);
    const pf = (await call('POST', '/api/portfolios', a, { title: '待发布作品集' })).json();

    // repo 缺失 → 400
    expect((await call('POST', `/api/portfolios/${pf.id}/deploy`, a, {})).statusCode).toBe(400);
    // repo 空串 → 400
    expect(
      (await call('POST', `/api/portfolios/${pf.id}/deploy`, a, { repo: '   ' })).statusCode
    ).toBe(400);
    // 非法格式 → 400
    expect(
      (await call('POST', `/api/portfolios/${pf.id}/deploy`, a, { repo: 'not-a-repo' })).statusCode
    ).toBe(400);
    // 含空白的仓库名 → 400
    expect(
      (await call('POST', `/api/portfolios/${pf.id}/deploy`, a, { repo: 'owner/repo with space' })).statusCode
    ).toBe(400);
  });

  it('发布：行级隔离，B 不能发布 A 的作品集', async () => {
    const a = await login(A);
    const b = await login(B);
    const pf = (await call('POST', '/api/portfolios', a, { title: 'A 的作品集' })).json();

    // B 对 A 的作品集发布 → 404（get 阶段就拦下，不触发 git）
    expect(
      (await call('POST', `/api/portfolios/${pf.id}/deploy`, b, { repo: 'b-owner/b-repo' })).statusCode
    ).toBe(404);
  });
});
