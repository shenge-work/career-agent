import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/server/app.module';
import { DB_TOKEN } from '../src/shared/constants';
import { createDatabase } from '../src/server/db/client';
import { applyMigrations } from '../src/server/db/migrate';

let app: NestFastifyApplication;
let closeDb: () => Promise<void>;

const ACCOUNT = { email: 'owner@local.test', password: 'owner-pass-123' };

async function post(url: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload,
  });
}

beforeAll(async () => {
  const handle = await createDatabase(); // 内存库
  closeDb = handle.close;
  await applyMigrations(handle.client);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB_TOKEN)
    .useValue(handle.db)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  if (app) await app.close();
  if (closeDb) await closeDb();
});

describe('桌面端 · 首次运行初始化', () => {
  it('空库时 status 报告需要初始化', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/setup/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ needsSetup: true });
  });

  it('弱密码与非法邮箱被拒绝，且不产生账号', async () => {
    expect((await post('/api/setup/bootstrap', { email: ACCOUNT.email, password: '123' })).statusCode).toBe(400);
    expect((await post('/api/setup/bootstrap', { email: 'not-an-email', password: ACCOUNT.password })).statusCode).toBe(400);
    const status = await app.inject({ method: 'GET', url: '/api/setup/status' });
    expect(status.json().needsSetup).toBe(true);
  });

  it('创建首个账号（无角色）后可用它登录', async () => {
    const res = await post('/api/setup/bootstrap', { ...ACCOUNT, displayName: '机主' });
    expect(res.statusCode).toBe(201);
    expect(res.json().user.email).toBe(ACCOUNT.email);
    expect(res.json().user).not.toHaveProperty('role');
    expect(JSON.stringify(res.json())).not.toContain('passwordHash');

    const login = await post('/api/auth/login', ACCOUNT);
    expect(login.statusCode).toBe(200);
    expect(String(login.headers['set-cookie'])).toContain('rs_sid');
  });

  it('已有账号后仍可自助创建独立账号，重复邮箱则拒绝', async () => {
    const status = await app.inject({ method: 'GET', url: '/api/setup/status' });
    expect(status.json()).toEqual({ needsSetup: false });

    const second = await post('/api/setup/bootstrap', {
      email: 'second@local.test',
      password: 'second-pass-123',
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().user).not.toHaveProperty('role');
    const login2 = await post('/api/auth/login', {
      email: 'second@local.test',
      password: 'second-pass-123',
    });
    expect(login2.statusCode).toBe(200);

    const duplicate = await post('/api/setup/bootstrap', { ...ACCOUNT });
    expect(duplicate.statusCode).toBe(409);
  });
});
