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

describe('P0 · 岗位/申请聚合根（applications）', () => {
  it('未登录访问岗位接口全部 401', async () => {
    expect((await call('GET', '/api/applications')).statusCode).toBe(401);
    expect((await call('POST', '/api/applications')).statusCode).toBe(401);
    expect((await call('GET', '/api/applications/whatever')).statusCode).toBe(401);
    expect((await call('GET', '/api/applications/whatever/events')).statusCode).toBe(401);
  });

  it('创建岗位：position 必填、默认 interested、自动写一条旅程起点事件', async () => {
    const a = await login(A);
    const created = await call('POST', '/api/applications', a, { position: '高级前端工程师' });
    expect(created.statusCode).toBe(201);
    const appRow = created.json();
    expect(appRow.position).toBe('高级前端工程师');
    expect(appRow.status).toBe('interested');

    const events = await call('GET', `/api/applications/${appRow.id}/events`, a);
    expect(events.statusCode).toBe(200);
    expect(events.json().length).toBe(1);
    expect(events.json()[0].toStatus).toBe('interested');
    expect(events.json()[0].fromStatus).toBe(null);
  });

  it('position 为空返回 400', async () => {
    const a = await login(A);
    expect((await call('POST', '/api/applications', a, { position: '   ' })).statusCode).toBe(400);
  });

  it('状态变更写流水 + 首次 applied 自动补 appliedAt', async () => {
    const a = await login(A);
    const appRow = (await call('POST', '/api/applications', a, { position: '后端工程师' })).json();

    const updated = await call('PUT', `/api/applications/${appRow.id}`, a, { status: 'applied' });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().status).toBe('applied');
    expect(updated.json().appliedAt).toBeTruthy();

    const events = await call('GET', `/api/applications/${appRow.id}/events`, a);
    const list = events.json();
    expect(list.length).toBe(2);
    const latest = list[0];
    expect(latest.toStatus).toBe('applied');
    expect(latest.fromStatus).toBe('interested');
  });

  it('非法 status 归一化回退 interested，不抛错', async () => {
    const a = await login(A);
    const appRow = (await call('POST', '/api/applications', a, { position: '测试岗位' })).json();
    const updated = await call('PUT', `/api/applications/${appRow.id}`, a, { status: 'bogus' });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().status).toBe('interested');
  });

  it('行级隔离：A 的岗位 B 读不到（单条/列表/改/删/事件均 404 或不出现）', async () => {
    const a = await login(A);
    const b = await login(B);
    const appRow = (await call('POST', '/api/applications', a, { position: 'A 的私有岗位' })).json();
    const id = appRow.id;

    expect((await call('GET', `/api/applications/${id}`, b)).statusCode).toBe(404);
    expect((await call('GET', `/api/applications/${id}/events`, b)).statusCode).toBe(404);
    expect((await call('PUT', `/api/applications/${id}`, b, { status: 'offered' })).statusCode).toBe(404);
    expect((await call('DELETE', `/api/applications/${id}`, b)).statusCode).toBe(404);

    const listB = await call('GET', '/api/applications', b);
    expect(listB.json().some((r: any) => r.id === id)).toBe(false);

    const own = await call('GET', `/api/applications/${id}`, a);
    expect(own.json().position).toBe('A 的私有岗位');
  });

  it('companyId / resumeId 必须是本人的，否则 404', async () => {
    const a = await login(A);
    const b = await login(B);

    const companyId = (await call('POST', '/api/companies', a, { name: 'A 的公司' })).json().id;
    const resumeId = (await call('POST', '/api/resumes', a, {
      title: 'A 的简历',
      payload: { data: { sections: [] } },
    })).json().id;

    expect(
      (await call('POST', '/api/applications', b, { position: '越权岗位', companyId })).statusCode
    ).toBe(404);
    expect(
      (await call('POST', '/api/applications', b, { position: '越权岗位2', resumeId })).statusCode
    ).toBe(404);

    const ok = await call('POST', '/api/applications', a, { position: '正常岗位', companyId, resumeId });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().companyId).toBe(companyId);
    expect(ok.json().resumeId).toBe(resumeId);
  });

  it('删除岗位连带清理状态流水', async () => {
    const a = await login(A);
    const appRow = (await call('POST', '/api/applications', a, { position: '待删岗位' })).json();
    expect((await call('GET', `/api/applications/${appRow.id}/events`, a)).json().length).toBe(1);

    expect((await call('DELETE', `/api/applications/${appRow.id}`, a)).statusCode).toBe(200);
    expect((await call('GET', `/api/applications/${appRow.id}`, a)).statusCode).toBe(404);
    expect((await call('GET', `/api/applications/${appRow.id}/events`, a)).statusCode).toBe(404);
  });
});
