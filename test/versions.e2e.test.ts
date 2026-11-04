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
import { selectVersionIdsToKeep, KEEP_RECENT } from '../src/server/business/version-policy';

/* ================================================================ 纯函数：保留策略 */

describe('版本保留策略（version-policy）', () => {
  const DAY = 24 * 3600 * 1000;
  const now = Date.now();
  /** 该天正午时刻（避开自然日界，小时偏移 ±5h 也不会跨日）。 */
  const noon = (daysAgo: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() - daysAgo);
    d.setHours(12, 0, 0, 0);
    return d.getTime();
  };

  it('手动命名快照永不降采样（无论多老）', () => {
    const keep = selectVersionIdsToKeep(
      [
        { id: 'm1', kind: 'manual', createdAt: now - 90 * DAY },
        { id: 'a1', kind: 'auto', createdAt: now - 90 * DAY },
      ],
      now
    );
    expect(keep.has('m1')).toBe(true);
    expect(keep.has('a1')).toBe(false); // 超过 30 天窗口的 auto 丢弃
  });

  it(`最近 ${KEEP_RECENT} 条 auto 全保留，同日更早的只保首尾`, () => {
    const noonToday = noon(0);
    // 同一自然日内 60 条（11:01–12:00，间隔 1 分钟）
    const vs = Array.from({ length: 60 }, (_, i) => ({
      id: 'v' + i,
      kind: 'auto',
      createdAt: noonToday - i * 60 * 1000, // i=0 最新
    }));
    const keep = selectVersionIdsToKeep(vs, now);
    for (let i = 0; i < KEEP_RECENT; i++) expect(keep.has('v' + i)).toBe(true);
    // 50 条之外更早的 10 条属同一天：保留首（i=50）与尾（i=59）各 1 条
    expect(keep.size).toBe(KEEP_RECENT + 2);
    expect(keep.has('v50')).toBe(true);
    expect(keep.has('v59')).toBe(true);
    expect(keep.has('v55')).toBe(false); // 中间的丢
  });

  it('超龄（>30 天）的 auto 全丢', () => {
    const keep = selectVersionIdsToKeep(
      [
        { id: 'old', kind: 'auto', createdAt: now - 31 * DAY },
        { id: 'new', kind: 'auto', createdAt: now - DAY },
      ],
      now
    );
    expect(keep.has('new')).toBe(true);
    expect(keep.has('old')).toBe(false);
  });

  it('多天历史按「每天首尾 2 条」降采样', () => {
    const vs: Array<{ id: string; kind: string; createdAt: number }> = [];
    // 三天前每天 6 条（当天 07:00–12:00，同一自然日）
    for (let d = 3; d >= 1; d--) {
      for (let h = 0; h < 6; h++) {
        vs.push({ id: `d${d}h${h}`, kind: 'auto', createdAt: noon(d) - h * 3600 * 1000 });
      }
    }
    // 再垫 50 条今天的把历史挤出最近窗口
    for (let i = 0; i < KEEP_RECENT; i++) {
      vs.push({ id: 'today' + i, kind: 'auto', createdAt: noon(0) - i * 60 * 1000 });
    }
    const keep = selectVersionIdsToKeep(vs, now);
    // d3 组内新→旧：首=d3h0（12:00）、尾=d3h5（07:00）
    expect(keep.has('d3h0')).toBe(true);
    expect(keep.has('d3h5')).toBe(true);
    expect(keep.has('d3h2')).toBe(false); // 中间的丢
    expect(keep.has('today0')).toBe(true);
    expect(keep.size).toBe(KEEP_RECENT + 6); // 3 天 × 每天 2 条
  });
});

/* ================================================================ e2e：恢复闭环 */

const A = { email: 'a@local.test', password: 'aaaa-pass-123' };
const B = { email: 'b@local.test', password: 'bbbb-pass-123' };

let app: NestFastifyApplication;
let db: Database;
let closeDb: () => Promise<void>;
let cookieA = '';
let cookieB = '';
let resumeIdA = '';

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

async function createResume(cookie: string, payload: Record<string, unknown>): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/resumes',
    headers: { 'content-type': 'application/json', cookie },
    payload: { title: 'V', payload },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

beforeAll(async () => {
  const handle = await createDatabase();
  db = handle.db;
  closeDb = handle.close;
  await applyMigrations(handle.client);
  for (const u of [A, B]) {
    await db.insert(users).values({ email: u.email, passwordHash: await hashPassword(u.password), role: 'member' });
  }
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB_TOKEN)
    .useValue(db)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  cookieA = await login(A);
  cookieB = await login(B);
  resumeIdA = await createResume(cookieA, { data: { sections: [{ id: 's1', title: '第一版' }] }, name: 'V' });
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe('版本恢复闭环（PG 版本功能重设计）', () => {
  it('未登录恢复 → 401', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/resumes/x/versions/y/restore` });
    expect(res.statusCode).toBe(401);
  });

  it('完整闭环：存快照 → 改内容 → 恢复 → 正文回到目标版本，且多一条「恢复前自动快照」', async () => {
    // 存第一版快照
    const add = await app.inject({
      method: 'POST',
      url: `/api/resumes/${resumeIdA}/versions`,
      headers: { 'content-type': 'application/json', cookie: cookieA },
      payload: { kind: 'manual', label: '定稿 v1', snapshot: { data: { sections: [{ id: 's1', title: '第一版' }] }, name: 'V' } },
    });
    expect(add.statusCode).toBe(201);
    const versionId = add.json().id;

    // 改正文（第二版）
    const put = await app.inject({
      method: 'PUT',
      url: `/api/resumes/${resumeIdA}`,
      headers: { 'content-type': 'application/json', cookie: cookieA },
      payload: { payload: { data: { sections: [{ id: 's1', title: '第二版' }] }, name: 'V' } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().payload.data.sections[0].title).toBe('第二版');

    // 恢复到「定稿 v1」
    const restore = await app.inject({
      method: 'POST',
      url: `/api/resumes/${resumeIdA}/versions/${versionId}/restore`,
      headers: { cookie: cookieA },
    });
    expect(restore.statusCode).toBe(201);
    const body = restore.json();
    expect(body.resumed.payload.data.sections[0].title).toBe('第一版'); // 正文已恢复
    expect(body.restoredFrom.label).toBe('定稿 v1');

    // 恢复前自动快照存在且内容是「第二版」
    const list = await app.inject({ method: 'GET', url: `/api/resumes/${resumeIdA}/versions`, headers: { cookie: cookieA } });
    const versions = list.json();
    const backup = versions.find((v: any) => String(v.label || '').startsWith('恢复前自动快照'));
    expect(backup).toBeTruthy();
    expect(backup.snapshot.data.sections[0].title).toBe('第二版');

    // 恢复本身可逆：恢复「恢复前自动快照」→ 正文回到第二版
    const restore2 = await app.inject({
      method: 'POST',
      url: `/api/resumes/${resumeIdA}/versions/${backup.id}/restore`,
      headers: { cookie: cookieA },
    });
    expect(restore2.statusCode).toBe(201);
    expect(restore2.json().resumed.payload.data.sections[0].title).toBe('第二版');
  });

  it('P0-3：正文改动经 PUT 后自动写入一条 auto 版本（编辑自动留痕）', async () => {
    const rid = await createResume(cookieA, { data: { sections: [{ id: 's1', title: '初稿' }] }, name: 'W' });
    const before = await app.inject({ method: 'GET', url: `/api/resumes/${rid}/versions`, headers: { cookie: cookieA } });
    expect(before.json()).toHaveLength(0); // 创建不产生版本

    const put = await app.inject({
      method: 'PUT',
      url: `/api/resumes/${rid}`,
      headers: { 'content-type': 'application/json', cookie: cookieA },
      payload: { payload: { data: { sections: [{ id: 's1', title: '改过' }] }, name: 'W' } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().payload.data.sections[0].title).toBe('改过');

    const after = await app.inject({ method: 'GET', url: `/api/resumes/${rid}/versions`, headers: { cookie: cookieA } });
    const versions = after.json() as Array<{ kind: string; snapshot: any }>;
    expect(versions.length).toBeGreaterThanOrEqual(1);
    const auto = versions.find((v) => v.kind === 'auto');
    expect(auto).toBeTruthy();
    expect(auto!.snapshot.data.sections[0].title).toBe('改过');
  });

  it('别人的版本 / 别人的简历 → 404（不泄露存在性）', async () => {
    const listA = await app.inject({ method: 'GET', url: `/api/resumes/${resumeIdA}/versions`, headers: { cookie: cookieA } });
    const versionId = listA.json()[0].id;
    // B 用自己的（不存在的）简历 → 404
    const r1 = await app.inject({
      method: 'POST',
      url: `/api/resumes/${resumeIdA}/versions/${versionId}/restore`,
      headers: { cookie: cookieB },
    });
    expect(r1.statusCode).toBe(404); // 简历不属于 B
  });

  it('不存在的版本 → 404；版本快照非对象 → 400', async () => {
    const r1 = await app.inject({
      method: 'POST',
      url: `/api/resumes/${resumeIdA}/versions/00000000-0000-0000-0000-000000000000/restore`,
      headers: { cookie: cookieA },
    });
    expect(r1.statusCode).toBe(404);
  });

  it('保留策略在多次留痕后生效：超量 auto 版本被降采样，manual 永保', async () => {
    const rid = await createResume(cookieA, { data: { sections: [] }, name: 'P' });
    // manual 一条（很老也保留）
    await app.inject({
      method: 'POST',
      url: `/api/resumes/${rid}/versions`,
      headers: { 'content-type': 'application/json', cookie: cookieA },
      payload: { kind: 'manual', label: '永久', snapshot: { v: 0 } },
    });
    // 塞 60 条 auto（同一天，间隔 1 分钟）→ 最近 50 条保留 + 每天 2 条，总量约 52
    for (let i = 0; i < 60; i++) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/resumes/${rid}/versions`,
        headers: { 'content-type': 'application/json', cookie: cookieA },
        payload: { kind: 'auto', label: null, snapshot: { i } },
      });
      expect(res.statusCode).toBe(201);
    }
    // prune 在 addVersion 后异步触发——等它跑完
    await new Promise((r) => setTimeout(r, 1200));
    const list = await app.inject({ method: 'GET', url: `/api/resumes/${rid}/versions`, headers: { cookie: cookieA } });
    const versions = list.json() as Array<{ kind: string }>;
    expect(versions.filter((v) => v.kind === 'manual')).toHaveLength(1); // manual 永保
    expect(versions.length).toBeLessThanOrEqual(53); // 50 最近 + 同天首尾 + 1 manual
    expect(versions.length).toBeGreaterThanOrEqual(50);
  });
});
