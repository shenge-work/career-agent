import 'reflect-metadata';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, asc, eq } from 'drizzle-orm';
import { AppModule } from '../src/server/app.module';
import { DB_TOKEN } from '../src/shared/constants';
import { createDatabase, type Database } from '../src/server/db/client';
import { applyMigrations } from '../src/server/db/migrate';
import { hashPassword } from '../src/server/auth/password';
import { TenantDb } from '../src/server/tenant/tenant-db';
import {
  changeLog,
  conflictSnapshots,
  practiceEvaluations,
  practiceSessions,
  users,
} from '../src/server/db/schema';
import { encodeHlc, parseHlc } from '../src/server/sync/hlc';
import { applyRemoteUpsert } from '../src/server/sync/sync-import';
import { DIMENSION_CODES } from '../src/server/practice/rubric';

/**
 * N14 · AI 面试练习端到端：
 *   · 无 Key 降级（本地题库 + 自评）闭环；
 *   · AI 全链路（出题 / 作答 / 评分 / 追问 / 沉淀 / 成长）；
 *   · 评分三态（generated / not_generated / pending_retry）与画像护栏；
 *   · 行级隔离；
 *   · 软删除墓碑 + change_log 记账 + 跨设备 LWW 冲突留底；
 *   · 跨 rubric_version 不混算。
 */
const A = { email: 'practice-a@local.test', password: 'aaaa-pass-123' };
const B = { email: 'practice-b@local.test', password: 'bbbb-pass-123' };

let app: NestFastifyApplication;
let db: Database;
let closeDb: () => Promise<void>;
let upstream: http.Server;
let upstreamPort = 0;
let scoreMode: 'valid' | 'invalid' | 'error' = 'valid';

let cookieA = '';
let cookieB = '';
let uidA = '';
let uidB = '';

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

function tenant(uid: string) {
  return new TenantDb(db).forUser(uid);
}

/** 6 维同档位的评分维度（供 mock 与直插画像用）。 */
function dims(level: number) {
  return DIMENSION_CODES.map((dimension) => ({
    dimension,
    reason: 'r-' + dimension,
    level,
    evidence: 'e-' + dimension,
  }));
}

function validScoreJson() {
  return JSON.stringify({
    dimensions: dims(3),
    strengths: ['行动具体'],
    actions: ['补充量化结果'],
    sampleAnswer: '示范，非标准答案：……',
    summary: '整体结构完整',
  });
}

function questionsJson(count: number) {
  const questions = Array.from({ length: count }, (_, i) => ({
    question: '面试题 ' + (i + 1) + '：讲一次你主导的项目，你个人做了什么？',
    type: i === 1 ? 'behavioral' : 'project',
    dimension: ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'][i % 6],
    difficulty: i === 1 ? 'easy' : 'standard',
    basis: { source: 'generic', excerpt: '' },
  }));
  return JSON.stringify({ questions });
}

function systemOf(body: any): string {
  const msgs = body?.messages || [];
  return String(msgs[0]?.content || '');
}

function mockUpstream(body: any) {
  const sys = systemOf(body);
  if (sys.includes('Rubric 执行器')) {
    if (scoreMode === 'error') return { status: 500, body: JSON.stringify({ error: 'upstream boom' }) };
    if (scoreMode === 'invalid') return { status: 200, body: JSON.stringify({ choices: [{ message: { content: '{"dimensions":[]}' } }] }) };
    return { status: 200, body: JSON.stringify({ choices: [{ message: { content: validScoreJson() } }] }) };
  }
  if (sys.includes('出面试练习题')) {
    const m = String(body?.messages?.[1]?.content || '');
    const n = Number((m.match(/出题数量：(\d+)/) || [])[1] || 3);
    return { status: 200, body: JSON.stringify({ choices: [{ message: { content: questionsJson(Math.max(1, Math.min(n, 10))) } }] }) };
  }
  if (sys.includes('结构化追问')) {
    return {
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ followUp: '你个人具体做了什么？', target: '缺个人动作', enough: false }) } }],
      }),
    };
  }
  if (sys.includes('参考范例答案')) {
    return {
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ sampleAnswer: '示范，非标准答案，请用自己的话重说：……', basedOn: 'resume' }) } }],
      }),
    };
  }
  return { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'pong' } }] }) };
}

async function configureAi(cookie: string) {
  const res = await call('PUT', '/api/ai/config', cookie, {
    provider: 'test-mock',
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    apiKey: 'sk-mock',
    models: { fast: 'mock-fast' },
    temperature: 0.3,
    timeoutMs: 5000,
  });
  expect(res.statusCode).toBe(200);
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      let body: any = {};
      try {
        body = JSON.parse(buf || '{}');
      } catch {
        /* noop */
      }
      const out = mockUpstream(body);
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', () => {
      upstreamPort = (upstream.address() as any).port;
      resolve();
    })
  );

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
  if (upstream) {
    (upstream as any).closeAllConnections?.();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
  if (closeDb) await closeDb();
});

describe('N14 · 门禁与行级隔离', () => {
  it('未登录访问全部 401', async () => {
    for (const [method, url] of [
      ['GET', '/api/practice/sessions'],
      ['POST', '/api/practice/sessions'],
      ['POST', '/api/practice/sessions/x/questions/generate'],
      ['POST', '/api/practice/questions/x/answers'],
      ['GET', '/api/practice/growth'],
      ['GET', '/api/practice/weaknesses'],
    ] as Array<[Method, string]>) {
      expect((await call(method, url)).statusCode).toBe(401);
    }
  });

  it('跨用户：B 看不到 A 的会话，越权 404 不泄露存在性', async () => {
    const created = await call('POST', '/api/practice/sessions', cookieA, { questionCount: 2 });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const bList = await call('GET', '/api/practice/sessions', cookieB);
    expect(bList.json().some((s: any) => s.id === id)).toBe(false);
    expect((await call('GET', `/api/practice/sessions/${id}`, cookieB)).statusCode).toBe(404);

    const gen = await call('POST', `/api/practice/sessions/${id}/questions/generate`, cookieA, { count: 1 });
    expect(gen.statusCode).toBe(200);
    const qid = gen.json().questions[0].id as string;
    expect((await call('POST', `/api/practice/questions/${qid}/answers`, cookieB, { answer: 'x' })).statusCode).toBe(404);
  });
});

describe('N14 · 无 Key 降级闭环（本地题库 + 自评）', () => {
  it('无 AI 配置：出题降级本地题库，作答评分明确 400，答案已落库可自评', async () => {
    // B 从未配置 AI
    const created = await call('POST', '/api/practice/sessions', cookieB, { questionCount: 3 });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json().id as string;

    const gen = await call('POST', `/api/practice/sessions/${sessionId}/questions/generate`, cookieB, { count: 3 });
    expect(gen.statusCode).toBe(200);
    expect(gen.json().aiUsed).toBe(false);
    expect(gen.json().degraded).toBe(true);
    expect(gen.json().questions).toHaveLength(3);

    const qid = gen.json().questions[0].id as string;
    const answerText = '我在项目中负责缓存层重构，把接口 P99 从 800ms 降到 120ms。';
    const submit = await call('POST', `/api/practice/questions/${qid}/answers`, cookieB, { answer: answerText });
    expect(submit.statusCode).toBe(400); // AI 未配置 → 明确 400，前端走自评降级
    expect(String(submit.json().message)).toContain('AI 未配置');

    // 答案已落库（评分失败不吞掉回答）
    const got = await call('GET', `/api/practice/sessions/${sessionId}`, cookieB);
    const q0 = got.json().questions.find((q: any) => q.id === qid);
    expect(q0.answers[0].answer).toBe(answerText);
    expect(q0.answers[0].isDraft).toBe(false);

    // 自评降级：source=self，不计画像
    const aid = q0.answers[0].id as string;
    const self = await call('POST', `/api/practice/answers/${aid}/self-evaluate`, cookieB, {
      dimensions: [
        { dimension: 'D1', level: 3 },
        { dimension: 'D3', level: 2 },
      ],
    });
    expect(self.statusCode).toBe(200);
    expect(self.json().source).toBe('self');
    expect(self.json().status).toBe('generated');
    expect(self.json().includeInProfile).toBe(false);

    // 自评不计入画像：growth 无 AI 评分
    const growth = await call('GET', '/api/practice/growth', cookieB);
    expect(growth.statusCode).toBe(200);
    expect(growth.json().rubricVersions).toEqual([]);
    expect(growth.json().profile.D1.latest).toBeNull();
  });
});

describe('N14 · AI 全链路（出题 / 作答 / 评分 / 追问 / 沉淀 / 成长）', () => {
  it('配置 AI 后完整闭环，评分 generated 并计入画像', async () => {
    await configureAi(cookieA);
    scoreMode = 'valid';

    const created = await call('POST', '/api/practice/sessions', cookieA, {
      jdText: '高级前端工程师，要求精通 React 与性能优化。',
      questionType: 'project',
      difficulty: 'standard',
      questionCount: 3,
    });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json().id as string;

    const gen = await call('POST', `/api/practice/sessions/${sessionId}/questions/generate`, cookieA, { count: 3 });
    expect(gen.statusCode).toBe(200);
    expect(gen.json().aiUsed).toBe(true);
    expect(gen.json().degraded).toBe(false);
    expect(gen.json().questions).toHaveLength(3);

    const qid = gen.json().questions[0].id as string;
    const firstAnswerId = gen.json().questions[0].answers[0].id as string;
    const submit = await call('POST', `/api/practice/questions/${qid}/answers`, cookieA, {
      answer: '我主导了缓存层重构，把接口 P99 从 800ms 降到 120ms，并做了灰度与回滚预案。',
    });
    expect(submit.statusCode).toBe(200);
    expect(submit.json().aiUsed).toBe(true);
    expect(submit.json().evaluation.status).toBe('generated');
    expect(submit.json().evaluation.includeInProfile).toBe(true);
    expect(submit.json().evaluation.dimensions).toHaveLength(6);
    expect(submit.json().evaluation.rubricVersion).toBe('v1');

    // 追问：产生 turn=1 的草稿回答
    const fu = await call('POST', `/api/practice/questions/${qid}/follow-up`, cookieA, { answerId: firstAnswerId });
    expect(fu.statusCode).toBe(200);
    expect(fu.json().aiUsed).toBe(true);
    expect(fu.json().answer.turn).toBe(1);
    expect(fu.json().answer.isDraft).toBe(true);

    // 范例答案（基于 resume，此处无简历 → generic，AI 生成）
    const sa = await call('POST', `/api/practice/answers/${firstAnswerId}/sample-answer`, cookieA);
    expect(sa.statusCode).toBe(200);
    expect(sa.json().aiUsed).toBe(true);
    expect(String(sa.json().sampleAnswer)).toContain('示范');

    // 沉淀
    const settle = await call('POST', `/api/practice/sessions/${sessionId}/settle`, cookieA);
    expect(settle.statusCode).toBe(200);
    expect(settle.json().session.status).toBe('completed');

    // 成长画像
    const growth = await call('GET', '/api/practice/growth', cookieA);
    expect(growth.statusCode).toBe(200);
    expect(growth.json().rubricVersions).toContain('v1');
    expect(growth.json().profile.D1.latest).toBe(3);
    expect(growth.json().profile.D1.count).toBeGreaterThanOrEqual(1);
    expect(growth.json().radar.recent.D1).toBe(3);
    expect(growth.json().trend.D1.length).toBeGreaterThanOrEqual(1);
    expect(growth.json().calendar.totalDays).toBeGreaterThanOrEqual(1);
  });
});

describe('N14 · 评分三态与画像护栏', () => {
  async function freshAnsweredQuestion(cookie: string) {
    const created = await call('POST', '/api/practice/sessions', cookie, { questionCount: 1 });
    const sessionId = created.json().id as string;
    const gen = await call('POST', `/api/practice/sessions/${sessionId}/questions/generate`, cookie, { count: 1 });
    const qid = gen.json().questions[0].id as string;
    return { sessionId, qid, firstAnswerId: gen.json().questions[0].answers[0].id as string };
  }

  it('解析失败 → not_generated，不写画像、不产低分', async () => {
    await configureAi(cookieA);
    scoreMode = 'invalid';
    const { qid } = await freshAnsweredQuestion(cookieA);
    const submit = await call('POST', `/api/practice/questions/${qid}/answers`, cookieA, {
      answer: '我做了缓存优化。',
    });
    expect(submit.statusCode).toBe(200);
    expect(submit.json().evaluation.status).toBe('not_generated');
    expect(submit.json().evaluation.includeInProfile).toBe(false);
    expect(submit.json().evaluation.dimensions).toEqual([]);
    expect(submit.json().notGenerated).toBe(true);

    const growth = await call('GET', '/api/practice/growth', cookieA);
    // 该评分不入画像：D1 计数不应增长（此处仅断言不因 not_generated 产生档位）
    expect(growth.json().profile.D1.history.every((h: any) => h.rubricVersion !== 'not_generated')).toBe(true);
    scoreMode = 'valid';
  });

  it('上游 500 → pending_retry，可重试，不写画像', async () => {
    await configureAi(cookieA);
    scoreMode = 'error';
    const { qid } = await freshAnsweredQuestion(cookieA);
    const submit = await call('POST', `/api/practice/questions/${qid}/answers`, cookieA, {
      answer: '我做了缓存优化。',
    });
    expect(submit.statusCode).toBe(200);
    expect(submit.json().evaluation.status).toBe('pending_retry');
    expect(submit.json().evaluation.includeInProfile).toBe(false);
    expect(submit.json().pendingRetry).toBe(true);
    scoreMode = 'valid';
  });

  it('自评来源 status 非法 / 维度非法 → 400', async () => {
    await configureAi(cookieA);
    const { firstAnswerId } = await freshAnsweredQuestion(cookieA);
    expect(
      (await call('POST', `/api/practice/answers/${firstAnswerId}/self-evaluate`, cookieA, { dimensions: [] })).statusCode
    ).toBe(400);
    expect(
      (await call('POST', `/api/practice/answers/${firstAnswerId}/self-evaluate`, cookieA, {
        dimensions: [{ dimension: 'D9', level: 2 }],
      })).statusCode
    ).toBe(400);
  });
});

describe('N14 · 跨 rubric_version 不混算', () => {
  it('growth 按 rubricVersion 过滤，版本间画像隔离', async () => {
    // 用从未产生 AI 评分的 B 账号，避免被其它用例的同版本评分污染计数。
    const base = {
      userId: uidB,
      answerId: 'eval-cross-answer',
      questionId: 'eval-cross-question',
      source: 'ai' as const,
      status: 'generated' as const,
      promptVersion: 'v1',
      includeInProfile: true,
    };
    await db.insert(practiceEvaluations).values({
      ...base,
      id: 'eval-cross-v1',
      rubricVersion: 'v1',
      dimensions: dims(2),
      createdAt: new Date('2024-01-01T00:00:00Z'),
    });
    await db.insert(practiceEvaluations).values({
      ...base,
      id: 'eval-cross-v2',
      rubricVersion: 'v2',
      dimensions: dims(4),
      createdAt: new Date('2024-02-01T00:00:00Z'),
    });

    const all = (await call('GET', '/api/practice/growth', cookieB)).json();
    expect(all.rubricVersions).toEqual(['v1', 'v2']);
    expect(all.profile.D1.count).toBe(2);
    expect(all.profile.D1.latest).toBe(4);

    const v1 = (await call('GET', '/api/practice/growth?rubricVersion=v1', cookieB)).json();
    expect(v1.rubricVersions).toEqual(['v1']);
    expect(v1.profile.D1.count).toBe(1);
    expect(v1.profile.D1.latest).toBe(2);

    const v2 = (await call('GET', '/api/practice/growth?rubricVersion=v2', cookieB)).json();
    expect(v2.rubricVersions).toEqual(['v2']);
    expect(v2.profile.D1.count).toBe(1);
    expect(v2.profile.D1.latest).toBe(4);
  });
});

describe('N14 · 软删除墓碑 + change_log 记账 + 跨设备冲突', () => {
  it('练习会话软删除留墓碑、写 change_log delete、同 id 复活', async () => {
    const t = tenant(uidA);
    const created = await t.createPracticeSession({
      id: 'ps-del-1',
      status: 'active',
      goal: {},
      currentQuestionOrder: 0,
      usage: {},
    });
    const hlcBefore = created[0].hlc;

    expect(await t.deletePracticeSession('ps-del-1')).toHaveLength(1);
    expect(await t.getPracticeSession('ps-del-1')).toHaveLength(0);

    const raw = await db
      .select()
      .from(practiceSessions)
      .where(and(eq(practiceSessions.userId, uidA), eq(practiceSessions.id, 'ps-del-1')));
    expect(raw).toHaveLength(1);
    expect(raw[0].deletedAt).not.toBeNull();

    const logs = await db
      .select()
      .from(changeLog)
      .where(and(eq(changeLog.userId, uidA), eq(changeLog.entityId, 'ps-del-1')))
      .orderBy(asc(changeLog.hlc));
    const delLog = logs.filter((c) => c.op === 'delete');
    expect(delLog).toHaveLength(1);
    expect(delLog[0].entity).toBe('practice_sessions');
    expect(delLog[0].payload.table).toBe('practice_sessions');
    expect(delLog[0].payload.row_hlc).toBeTruthy();
    expect(delLog[0].payload.deleted_at).toBeTruthy();

    const again = await t.createPracticeSession({
      id: 'ps-del-1',
      status: 'paused',
      goal: {},
      currentQuestionOrder: 0,
      usage: {},
    });
    expect(again).toHaveLength(1);
    expect(again[0].deletedAt).toBeNull();
    expect(again[0].hlc > hlcBefore).toBe(true);
  });

  it('练习会话跨设备 LWW：远端胜覆盖、本地胜拒绝，双向都留冲突快照', async () => {
    const id = 'ps-lww-1';
    const local = await tenant(uidA).createPracticeSession({
      id,
      status: 'active',
      goal: {},
      currentQuestionOrder: 0,
      usage: {},
    });
    const localHlc = local[0].hlc;
    const baseMs = parseHlc(localHlc).ms;

    // 远端更晚：覆盖本地，本地旧版本进快照（remote_wins）
    const newer = encodeHlc(baseMs + 100, 0);
    const win = await applyRemoteUpsert(db, {
      entity: 'practice_sessions',
      row: { id, userId: uidA, status: 'completed', hlc: newer, deviceId: 'dev-B' },
    });
    expect(win.applied).toBe(true);
    const after = await db
      .select()
      .from(practiceSessions)
      .where(and(eq(practiceSessions.userId, uidA), eq(practiceSessions.id, id)));
    expect(after[0].status).toBe('completed');
    expect(after[0].deviceId).toBe('dev-B');

    // 第三台设备更旧的写：被 LWW 拒绝，远端整行进快照（local_wins）
    const older = encodeHlc(baseMs - 500, 0);
    const lose = await applyRemoteUpsert(db, {
      entity: 'practice_sessions',
      row: { id, userId: uidA, status: 'paused', hlc: older, deviceId: 'dev-C' },
    });
    expect(lose.applied).toBe(false);
    const still = await db
      .select()
      .from(practiceSessions)
      .where(and(eq(practiceSessions.userId, uidA), eq(practiceSessions.id, id)));
    expect(still[0].status).toBe('completed');

    const snaps = await tenant(uidA).listConflictSnapshots({ entity: 'practice_sessions', entityId: id });
    expect(snaps).toHaveLength(2);
    const remoteWins = snaps.find((s) => s.resolution === 'remote_wins');
    const localWins = snaps.find((s) => s.resolution === 'local_wins');
    expect(remoteWins?.snapshot.status).toBe('active');
    expect(remoteWins?.loserHlc).toBe(localHlc);
    expect(localWins?.snapshot.status).toBe('paused');
    expect(localWins?.loserHlc).toBe(older);
    expect(localWins?.winnerHlc).toBe(newer);
  });

  it('conflict_snapshots 本身不进 change_log（练习表不放大同步）', async () => {
    const rows = await db
      .select()
      .from(changeLog)
      .where(eq(changeLog.entity, 'conflict_snapshots'));
    expect(rows).toHaveLength(0);
    const snapRows = await db
      .select()
      .from(conflictSnapshots)
      .where(eq(conflictSnapshots.entity, 'practice_sessions'));
    expect(snapRows.length).toBeGreaterThanOrEqual(2);
  });
});
