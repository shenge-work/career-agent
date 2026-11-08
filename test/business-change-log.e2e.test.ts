import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { AppModule } from '../src/server/app.module';
import { DB_TOKEN } from '../src/shared/constants';
import { createDatabase, type Database } from '../src/server/db/client';
import { applyMigrations } from '../src/server/db/migrate';
import { hashPassword } from '../src/server/auth/password';
import {
  aiConfigs,
  changeLog,
  companies,
  interviewKb,
  resumes,
  settings,
  users,
} from '../src/server/db/schema';

/**
 * 0010：全业务表接入 change_log（本地 outbox）。
 *
 * 重点验证「零应用层侵入」是否真的成立：查询语义不变、物理删除仍可用，
 * 但每次写（含删除）都能被云端按游标增量拉走；同时敏感列不落到 outbox。
 */
const A = { email: 'clog-a@local.test', password: 'aaaa-pass-123' };
const B = { email: 'clog-b@local.test', password: 'bbbb-pass-123' };
const SECRET = 'sk-super-secret-should-not-leak';

let app: NestFastifyApplication;
let db: Database;
let closeDb: () => Promise<void>;
let cookieA = '';
let cookieB = '';
let uidA = '';
let uidB = '';

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

async function changes(cookie: string, since = '', limit = 500) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/attachments/sync/changes?since=${encodeURIComponent(since)}&limit=${limit}`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    changes: Array<{
      id: string;
      userId: string;
      entity: string;
      entityId: string;
      op: string;
      hlc: string;
      deviceId: string;
      payload: Record<string, any>;
    }>;
    nextCursor: string;
  };
}

beforeAll(async () => {
  const handle = await createDatabase();
  db = handle.db;
  closeDb = handle.close;
  await applyMigrations(handle.client);

  const [a] = await db
    .insert(users)
    .values({ email: A.email, passwordHash: await hashPassword(A.password), role: 'member' })
    .returning({ id: users.id });
  const [b] = await db
    .insert(users)
    .values({ email: B.email, passwordHash: await hashPassword(B.password), role: 'member' })
    .returning({ id: users.id });
  uidA = a.id;
  uidB = b.id;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB_TOKEN)
    .useValue(db)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  cookieA = await login(A);
  cookieB = await login(B);
});

afterAll(async () => {
  if (app) await app.close();
  if (closeDb) await closeDb();
});

describe('全业务表增量日志（0010 触发器）', () => {
  it('各业务表的写都进 outbox；账号 / 会话表不进；敏感列不落到 payload', async () => {
    // 走真实 API 创建简历，另用 ORM 覆盖几张形状不同的表
    const created = await app.inject({
      method: 'POST',
      url: '/api/resumes',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      payload: { title: '同步验证简历', payload: { data: { sections: [] } } },
    });
    expect(created.statusCode).toBe(201);

    await db.insert(companies).values({ id: 'clog-c1', userId: uidA, name: '甲公司', payload: {} });
    await db.insert(settings).values({ userId: uidA, payload: { theme: 'dark' } });
    await db.insert(aiConfigs).values({
      userId: uidA,
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: SECRET,
    });
    await db.insert(interviewKb).values({
      id: 'clog-kb1',
      userId: uidA,
      title: '面经',
      content: '内容',
    });

    const all = await changes(cookieA);
    const entities = new Set(all.changes.map((c) => c.entity));
    for (const e of ['resumes', 'companies', 'settings', 'ai_configs', 'interview_kb']) {
      expect(entities.has(e)).toBe(true);
    }
    expect(entities.has('sessions')).toBe(false);
    expect(entities.has('users')).toBe(false);
    expect(entities.has('ai_usage')).toBe(false);

    // outbox 只放轻量信号，apiKey 绝不出现（它会被 UI 读取、将来会被上传）
    const aiChange = all.changes.find((c) => c.entity === 'ai_configs');
    expect(aiChange).toBeTruthy();
    expect(JSON.stringify(aiChange!.payload)).not.toContain(SECRET);
    expect(aiChange!.deviceId).toBe('local');
  });

  it('更新与物理删除都产生增量；删除带 deleted_at 墓碑', async () => {
    const before = await changes(cookieA);
    const id = 'clog-resume-life';
    await db.insert(resumes).values({
      id,
      userId: uidA,
      title: '初版',
      payload: {},
      savedAt: Date.now(),
    });
    await db.update(resumes).set({ title: '二版' }).where(eq(resumes.id, id));

    const mid = await changes(cookieA, before.nextCursor);
    const upserts = mid.changes.filter((c) => c.entity === 'resumes' && c.entityId === id && c.op === 'upsert');
    expect(upserts.length).toBe(2); // insert + update 各一条

    await db.delete(resumes).where(eq(resumes.id, id));
    const after = await changes(cookieA, mid.nextCursor);
    const tombstone = after.changes.find(
      (c) => c.entity === 'resumes' && c.entityId === id && c.op === 'delete'
    );
    expect(tombstone).toBeTruthy();
    expect(tombstone!.payload.deletedAt || tombstone!.payload.deleted_at).toBeTruthy();
  });

  it('游标严格单调：同毫秒批量写不重复、分页增量一条不漏', async () => {
    const before = await changes(cookieA);
    const ids = Array.from({ length: 24 }, (_, i) => `clog-batch-${i}`);
    await db.insert(resumes).values(
      ids.map((id) => ({
        id,
        userId: uidA,
        title: '批量',
        payload: {},
        savedAt: Date.now(),
      }))
    );

    const batch = await changes(cookieA, before.nextCursor);
    const batchRows = batch.changes.filter((c) => ids.includes(c.entityId));
    expect(batchRows).toHaveLength(ids.length);
    for (let i = 1; i < batchRows.length; i++) {
      expect(batchRows[i - 1].hlc < batchRows[i].hlc).toBe(true);
    }

    // 模拟云端按 5 条一页续拉，游标不能吃掉任何一条
    let cursor = before.nextCursor;
    const collected = new Set<string>();
    for (let page = 0; page < 40; page++) {
      const r = await changes(cookieA, cursor, 5);
      if (!r.changes.length) break;
      for (const c of r.changes) collected.add(c.entityId);
      cursor = r.nextCursor;
    }
    for (const id of ids) expect(collected.has(id)).toBe(true);
  });

  it('跨用户增量隔离：B 的游标表不含 A 的任何变更', async () => {
    const a = await changes(cookieA);
    const b = await changes(cookieB);
    const aIds = new Set(a.changes.map((c) => c.entityId));
    expect(aIds.size).toBeGreaterThan(0);
    for (const c of b.changes) expect(aIds.has(c.entityId)).toBe(false);
    expect(b.changes.every((c) => c.userId === uidB)).toBe(true);
  });

  it('删除用户不被 outbox 外键卡住（级联删除时跳过记账）', async () => {
    await db.insert(companies).values({
      id: 'clog-b-company',
      userId: uidB,
      name: 'B 的公司',
      payload: {},
    });
    await expect(db.delete(users).where(eq(users.id, uidB))).resolves.toBeTruthy();
    const left = await db.select().from(changeLog).where(eq(changeLog.userId, uidB));
    expect(left).toHaveLength(0); // 级联清理干净
  });
});
