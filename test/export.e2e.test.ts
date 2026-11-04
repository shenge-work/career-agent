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

const U = { email: 'export@local.test', password: 'export-pass-123' };

let app: NestFastifyApplication;
let closeDb: () => Promise<void>;
let cookie = '';
let resumeId = '';

function cookieOf(res: any): string {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return first ? String(first).split(';')[0] : '';
}

beforeAll(async () => {
  const handle = await createDatabase();
  const db: Database = handle.db;
  closeDb = handle.close;
  await applyMigrations(handle.client);
  await db.insert(users).values({ email: U.email, passwordHash: await hashPassword(U.password), role: 'member' });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB_TOKEN)
    .useValue(db)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: U,
  });
  expect(login.statusCode).toBe(200);
  cookie = cookieOf(login);

  const create = await app.inject({
    method: 'POST',
    url: '/api/resumes',
    headers: { 'content-type': 'application/json', cookie },
    payload: {
      title: '陈培胜的主简历',
      payload: {
        data: {
          name: '陈培胜',
          sections: [{ id: 's1', type: 'highlights', title: '个人优势', cards: [{ text: '**五年经验**' }] }],
        },
      },
    },
  });
  expect(create.statusCode).toBe(201);
  resumeId = create.json().id;
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe('P0-2：多格式文本导出（中文文件名不再 500）', () => {
  for (const fmt of ['txt', 'md', 'doc'] as const) {
    it(`/${fmt} 导出返回 200 且 Content-Disposition 合法（ASCII filename + RFC5987 filename*）`, async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/resumes/${resumeId}/export?format=${fmt}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200); // 修复前中文名触发 ERR_INVALID_CHAR → 500
      const cd = res.headers['content-disposition'] || '';
      expect(cd).toContain('attachment');
      // filename= 必须把非 ASCII 转成 ASCII（下划线占位），不能出现裸中文
      const filenamePart = cd.match(/filename="([^"]*)"/);
      expect(filenamePart).toBeTruthy();
      expect(filenamePart![1]).not.toMatch(/[^\x20-\x7e]/); // 纯 ASCII
      expect(cd).toContain("filename*=UTF-8''");
      expect(cd).toContain(encodeURIComponent('陈培胜'));
      expect(res.body.length).toBeGreaterThan(0);
    });
  }
});
