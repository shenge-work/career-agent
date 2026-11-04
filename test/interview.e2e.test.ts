import 'reflect-metadata';
import http from 'node:http';
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
let upstream: http.Server;
let upstreamPort = 0;
let mode: 'ok' | 'error' = 'ok';

const A = { email: 'iv-a@local.test', password: 'aaaa-pass-123' };
const B = { email: 'iv-b@local.test', password: 'bbbb-pass-123' };

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

function mockUpstreamResponse(body: any): unknown {
  const all = String((body?.messages || []).map((m: any) => m.content).join('\n'));
  if (all.includes('面试复盘教练') || all.includes('面试记录')) {
    return {
      choices: [{
        message: {
          content: JSON.stringify({
            summary: '整体表现稳健，技术深度 OK，但 STAR 表达偏散。',
            strengths: ['React 原理答得清晰'],
            weaknesses: ['项目难点表达不够聚焦'],
            suggestions: ['用 STAR 结构重新组织项目经历'],
            verdict: '通过概率中等，建议补一轮 mock。',
          }),
        },
      }],
    };
  }
  if (all.includes('求职顾问') || all.includes('知识库片段')) {
    return {
      choices: [{
        message: {
          content: JSON.stringify({
            answer: '根据你的知识库：离职原因应聚焦成长诉求，避免负面评价前司。',
            sources: ['行为面 · 离职原因怎么答'],
            grounded: true,
          }),
        },
      }],
    };
  }
  return { choices: [{ message: { content: 'pong' } }] };
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      let body: any = {};
      try { body = JSON.parse(buf || '{}'); } catch { /* noop */ }
      if (mode === 'error') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream boom' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mockUpstreamResponse(body)));
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
  if (upstream) {
    (upstream as any).closeAllConnections?.();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
  if (closeDb) await closeDb();
});

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

describe('N12 S2 · 面试复盘 + 面经知识库', () => {
  it('未登录访问 interview/kb 接口全部 401', async () => {
    expect((await call('GET', '/api/interview-notes')).statusCode).toBe(401);
    expect((await call('POST', '/api/interview-notes', undefined, {})).statusCode).toBe(401);
    expect((await call('GET', '/api/kb')).statusCode).toBe(401);
    expect((await call('POST', '/api/agent/kb-ask', undefined, { question: 'x' })).statusCode).toBe(401);
    expect((await call('POST', '/api/agent/review-interview', undefined, { noteId: 'x' })).statusCode).toBe(401);
  });

  it('面试笔记 CRUD：创建（带岗位）→ 列表 → 更新 → 删除', async () => {
    const a = await login(A);
    const appRow = (await call('POST', '/api/applications', a, { position: '后端工程师' })).json();

    const created = await call('POST', '/api/interview-notes', a, {
      applicationId: appRow.id,
      round: '一面',
      payload: { transcript: '问了分布式一致性，我答得一般。' },
    });
    expect(created.statusCode).toBe(201);
    const note = created.json();
    expect(note.id).toMatch(/^in_/);
    expect(note.round).toBe('一面');

    // 按岗位过滤列表
    const list = await call('GET', `/api/interview-notes?applicationId=${appRow.id}`, a);
    expect(list.json().some((n: any) => n.id === note.id)).toBe(true);

    // 更新
    const updated = await call('PUT', `/api/interview-notes/${note.id}`, a, { round: '二面' });
    expect(updated.json().round).toBe('二面');

    // 删除
    const delRes = await call('DELETE', `/api/interview-notes/${note.id}`, a);
    expect(delRes.statusCode).toBe(200);
    const after = await call('GET', `/api/interview-notes?applicationId=${appRow.id}`, a);
    expect(after.json().some((n: any) => n.id === note.id)).toBe(false);
  });

  it('面试笔记：跨用户越权返回 404（get/update/delete）', async () => {
    const a = await login(A);
    const b = await login(B);
    const note = (await call('POST', '/api/interview-notes', a, {
      round: '一面',
      payload: { transcript: 'secret' },
    })).json();

    expect((await call('GET', `/api/interview-notes/${note.id}`, b)).statusCode).toBe(404);
    expect((await call('PUT', `/api/interview-notes/${note.id}`, b, { round: 'x' })).statusCode).toBe(404);
    expect((await call('DELETE', `/api/interview-notes/${note.id}`, b)).statusCode).toBe(404);
  });

  it('review-interview：AI 未配置时模板降级，写回 payload.aiReview', async () => {
    const b = await login(B); // B 未配置 AI
    const note = (await call('POST', '/api/interview-notes', b, {
      round: '一面',
      payload: { transcript: '问了 React 原理。' },
    })).json();

    const res = await call('POST', '/api/agent/review-interview', b, { noteId: note.id });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.aiReview.summary).toBeTruthy();
    expect(j.aiReview.degraded).toBe(true);
    expect(j.aiReview.generatedAt).toBeTypeOf('number');

    const got = await call('GET', `/api/interview-notes/${note.id}`, b);
    expect(got.json().payload.aiReview.summary).toBe(j.aiReview.summary);
  });

  it('review-interview：AI 已配置时结构化复盘，model 落库', async () => {
    const a = await login(A);
    await configureAi(a);
    const note = (await call('POST', '/api/interview-notes', a, {
      round: '一面',
      payload: { transcript: '问了 React 原理，我答得还行。' },
    })).json();

    mode = 'ok';
    const res = await call('POST', '/api/agent/review-interview', a, { noteId: note.id });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.aiReview.degraded).toBe(false);
    expect(j.aiReview.model).toBe('mock-fast');
    expect(j.aiReview.strengths).toContain('React 原理答得清晰');
    expect(j.aiReview.weaknesses).toContain('项目难点表达不够聚焦');
  });

  it('review-interview：缺少 transcript 返回 400', async () => {
    const a = await login(A);
    const note = (await call('POST', '/api/interview-notes', a, { round: '一面' })).json();
    expect((await call('POST', '/api/agent/review-interview', a, { noteId: note.id })).statusCode).toBe(400);
  });

  it('review-interview：跨用户越权 404', async () => {
    const a = await login(A);
    const b = await login(B);
    const note = (await call('POST', '/api/interview-notes', a, {
      round: '一面', payload: { transcript: 'x' },
    })).json();
    expect((await call('POST', '/api/agent/review-interview', b, { noteId: note.id })).statusCode).toBe(404);
  });

  it('面经库 CRUD + 本地检索', async () => {
    const a = await login(A);
    const created = await call('POST', '/api/kb', a, {
      title: '行为面 · 离职原因怎么答',
      category: '行为面',
      tags: ['离职', 'HR'],
      content: '聚焦成长诉求，避免负面评价前司，用 STAR 结构表达。',
    });
    expect(created.statusCode).toBe(201);
    const kb = created.json();
    expect(kb.id).toMatch(/^kb_/);

    const list = await call('GET', '/api/kb', a);
    expect(list.json().some((k: any) => k.id === kb.id)).toBe(true);

    // 检索命中
    const search = await call('GET', '/api/kb/search?q=离职原因', a);
    expect(search.json().some((k: any) => k.id === kb.id)).toBe(true);

    // 检索未命中
    const miss = await call('GET', '/api/kb/search?q=完全不存在的词xyz', a);
    expect(miss.json().some((k: any) => k.id === kb.id)).toBe(false);

    // 更新
    const updated = await call('PUT', `/api/kb/${kb.id}`, a, { title: '行为面 · 离职原因（改）' });
    expect(updated.json().title).toContain('（改）');

    // 删除
    await call('DELETE', `/api/kb/${kb.id}`, a);
    const after = await call('GET', '/api/kb', a);
    expect(after.json().some((k: any) => k.id === kb.id)).toBe(false);
  });

  it('面经库：跨用户越权 404', async () => {
    const a = await login(A);
    const b = await login(B);
    const kb = (await call('POST', '/api/kb', a, { title: 'secret', content: 'x' })).json();
    expect((await call('GET', `/api/kb/${kb.id}`, b)).statusCode).toBe(404);
    expect((await call('PUT', `/api/kb/${kb.id}`, b, { title: 'hack' })).statusCode).toBe(404);
    expect((await call('DELETE', `/api/kb/${kb.id}`, b)).statusCode).toBe(404);
  });

  it('面经库：标题或内容为空返回 400', async () => {
    const a = await login(A);
    expect((await call('POST', '/api/kb', a, { title: '', content: 'x' })).statusCode).toBe(400);
    expect((await call('POST', '/api/kb', a, { title: 'x', content: '' })).statusCode).toBe(400);
  });

  it('kb-ask：AI 未配置时直接返回命中的知识库原文（grounded）', async () => {
    const b = await login(B);
    const kb = (await call('POST', '/api/kb', b, {
      title: '技术面 · 事件循环',
      category: '技术面',
      content: '事件循环：宏任务与微任务的执行顺序。',
    })).json();

    const res = await call('POST', '/api/agent/kb-ask', b, { question: '事件循环是什么' });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.degraded).toBe(true);
    expect(j.grounded).toBe(true);
    expect(j.sources).toContain(kb.title);
    expect(j.answer).toContain('事件循环');
  });

  it('kb-ask：AI 已配置时基于知识库作答，sources 标注', async () => {
    const a = await login(A);
    await configureAi(a);
    await call('POST', '/api/kb', a, {
      title: '行为面 · 离职原因怎么答',
      category: '行为面',
      content: '聚焦成长诉求。',
    });

    mode = 'ok';
    const res = await call('POST', '/api/agent/kb-ask', a, { question: '离职原因怎么答' });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.degraded).toBe(false);
    expect(j.aiUsed).toBe(true);
    expect(j.model).toBe('mock-fast');
    expect(j.grounded).toBe(true);
    expect(j.sources.length).toBeGreaterThan(0);
  });

  it('kb-ask：问题为空返回 400', async () => {
    const a = await login(A);
    expect((await call('POST', '/api/agent/kb-ask', a, { question: '  ' })).statusCode).toBe(400);
  });

  it('kb-ask：知识库无命中时 grounded=false（AI 未配置降级）', async () => {
    const b = await login(B);
    const res = await call('POST', '/api/agent/kb-ask', b, { question: '完全不相关的问题xyz' });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.grounded).toBe(false);
    expect(j.sources.length).toBe(0);
  });
});
