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

describe('N15 · STAR 经历素材库（snippets）', () => {
  it('未登录访问素材接口全部 401', async () => {
    expect((await call('GET', '/api/snippets')).statusCode).toBe(401);
    expect((await call('POST', '/api/snippets')).statusCode).toBe(401);
    expect((await call('GET', '/api/snippets/whatever')).statusCode).toBe(401);
    expect((await call('PUT', '/api/snippets/whatever')).statusCode).toBe(401);
    expect((await call('DELETE', '/api/snippets/whatever')).statusCode).toBe(401);
  });

  it('新建素材：缺标题或 STAR 四要素全空被 400 拒绝', async () => {
    const a = await login(A);
    expect((await call('POST', '/api/snippets', a, { title: '' })).statusCode).toBe(400);
    expect(
      (await call('POST', '/api/snippets', a, { title: '空素材', situation: '', task: '', action: '', result: '' }))
        .statusCode
    ).toBe(400);
  });

  it('新建 + 列表 + 读取 + 更新 + 删除全链路', async () => {
    const a = await login(A);
    // 新建
    const created = await call('POST', '/api/snippets', a, {
      title: '高并发网关性能优化',
      category: '项目',
      tags: ['Java', '高并发', '性能优化'],
      situation: '核心网关 QPS 翻倍后 P99 延迟恶化',
      task: '在不加机器前提下把 P99 压回 200ms 内',
      action: '重构连接池 + 引入协程化 IO + 分级缓存',
      result: 'P99 从 480ms 降到 180ms，CPU 降 35%',
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect(id).toBeTruthy();

    // 列表
    const list = await call('GET', '/api/snippets', a);
    expect(list.statusCode).toBe(200);
    expect(list.json().length).toBe(1);

    // 读取
    const get = await call('GET', `/api/snippets/${id}`, a);
    expect(get.statusCode).toBe(200);
    expect(get.json().title).toBe('高并发网关性能优化');
    expect(get.json().tags).toEqual(['Java', '高并发', '性能优化']);

    // 更新
    const upd = await call('PUT', `/api/snippets/${id}`, a, { title: '网关性能优化 v2' });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().title).toBe('网关性能优化 v2');

    // 删除
    const del = await call('DELETE', `/api/snippets/${id}`, a);
    expect(del.statusCode).toBe(200);
    expect((await call('GET', '/api/snippets', a)).json().length).toBe(0);
  });

  it('跨用户访问素材一律 404（不泄露存在性）', async () => {
    const a = await login(A);
    const b = await login(B);
    const created = await call('POST', '/api/snippets', a, {
      title: '私有素材',
      action: '做了某件事',
    });
    const id = created.json().id;

    expect((await call('GET', `/api/snippets/${id}`, b)).statusCode).toBe(404);
    expect((await call('PUT', `/api/snippets/${id}`, b, { title: '篡改' })).statusCode).toBe(404);
    expect((await call('DELETE', `/api/snippets/${id}`, b)).statusCode).toBe(404);
    // 用户 B 的列表里也看不到
    expect((await call('GET', '/api/snippets', b)).json().length).toBe(0);
  });
});
