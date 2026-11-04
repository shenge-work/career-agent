import 'reflect-metadata';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/server/app.module';
import { DB_TOKEN } from '../src/shared/constants';
import { createDatabase, type Database } from '../src/server/db/client';
import { applyMigrations } from '../src/server/db/migrate';
import { hashPassword } from '../src/server/auth/password';
import { users } from '../src/server/db/schema';
import { mergeChat, normalizeMessages } from '../src/server/collect/collect.service';

let app: NestFastifyApplication;
let db: Database;
let closeDb: () => Promise<void>;
let tmpDir: string;
let fixture: string;
let invalidFixture: string;
let hangFixture: string;
let originalScript: string | undefined;
let originalTimeout: string | undefined;

const ADMIN = { email: 'admin@local.test', password: 'admin-pass-123' };
const A = { email: 'a@local.test', password: 'aaaa-pass-123' };
const B = { email: 'b@local.test', password: 'bbbb-pass-123' };

const HR_TEXT = '陈培胜，在么？方便聊一聊么？';
const MSG_2 = '您好，我已投递简历';
const MSG_3 = '方便发一份附件简历吗';

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

async function createTracker(cookie: string, chat: unknown[]): Promise<string> {
  const res = await call('POST', '/api/tracker', cookie, {
    payload: { company: '测试公司', position: 'Agent 工程师', platform: 'BOSS直聘', chat },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

async function chatOf(cookie: string, id: string): Promise<any[]> {
  const res = await call('GET', `/api/tracker/${id}`, cookie);
  expect(res.statusCode).toBe(200);
  return res.json().payload.chat;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-collect-test-'));
  fixture = path.join(tmpDir, 'fixture.js');
  invalidFixture = path.join(tmpDir, 'invalid.js');
  hangFixture = path.join(tmpDir, 'hang.js');
  fs.writeFileSync(
    fixture,
    'process.stdout.write(JSON.stringify(' +
      JSON.stringify({
        ok: true,
        messages: [
          { role: 'hr', name: '刘女士', timeText: '昨天 14:30', text: HR_TEXT },
          { role: 'me', name: '', timeText: '昨天 14:31', text: MSG_2 },
          { role: 'hr', name: '刘女士', timeText: '昨天 14:32', text: MSG_3 },
          { role: 'hr', name: '刘女士', timeText: '昨天 14:32', text: MSG_3 },
          { role: 'unknown', text: '' }, // 非法项应被丢弃
        ],
        hint: 'ok',
        title: 'BOSS直聘',
        url: 'https://www.zhipin.com/web/geek/chat',
      }) +
      '));'
  );
  fs.writeFileSync(invalidFixture, "process.stdout.write('not-json');");
  fs.writeFileSync(hangFixture, 'setInterval(function(){}, 1000);');

  originalScript = process.env.BOSS_COLLECT_SCRIPT;
  originalTimeout = process.env.COLLECT_TIMEOUT_MS;
  process.env.BOSS_COLLECT_SCRIPT = fixture;
  process.env.COLLECT_TIMEOUT_MS = '4000';

  const handle = await createDatabase();
  db = handle.db;
  closeDb = handle.close;
  await applyMigrations(handle.client);
  for (const u of [ADMIN, A, B]) {
    await db.insert(users).values({
      email: u.email,
      passwordHash: await hashPassword(u.password),
      role: u.email === ADMIN.email ? 'admin' : 'member',
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
  if (originalScript === undefined) delete process.env.BOSS_COLLECT_SCRIPT;
  else process.env.BOSS_COLLECT_SCRIPT = originalScript;
  if (originalTimeout === undefined) delete process.env.COLLECT_TIMEOUT_MS;
  else process.env.COLLECT_TIMEOUT_MS = originalTimeout;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('P2b · 采集归并纯函数', () => {
  it('normalizeMessages 丢弃非法项并归一化 role / ts', () => {
    const out = normalizeMessages([
      { role: 'me', text: ' 你好 ', name: '我', timeText: '今天' },
      { role: 'bogus', text: '未知角色归为 hr' },
      { text: '' },
      null,
      { role: 'sys', text: '系统提示', ts: 123 },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ role: 'me', text: '你好', timeText: '今天', source: 'cdp' });
    expect(out[1].role).toBe('hr');
    expect(out[2]).toMatchObject({ role: 'sys', ts: 123 });
  });

  it('mergeChat：宽松匹配旧消息、同批次重复仍保留', () => {
    const existing = [{ role: 'hr', text: HR_TEXT, ts: 111 }];
    const incoming = normalizeMessages([
      { role: 'hr', text: HR_TEXT, timeText: '昨天 14:30' }, // 与旧消息同文 → 跳过
      { role: 'me', text: MSG_2, timeText: '昨天 14:31' },
      { role: 'hr', text: MSG_3, timeText: '昨天 14:32' },
      { role: 'hr', text: MSG_3, timeText: '昨天 14:32' }, // 同批重复 → 保留
    ]);
    const r = mergeChat(existing, incoming);
    expect(r.added).toBe(3);
    expect(r.chat).toHaveLength(4);
    expect(r.chat[0]).toEqual(existing[0]); // 不篡改既有消息
  });
});

describe('P2b · 采集接口门禁与参数校验', () => {
  it('未登录全部 401', async () => {
    expect((await call('GET', '/api/collect/status')).statusCode).toBe(401);
    expect((await call('POST', '/api/collect/chat', undefined, { trackerId: 'x' })).statusCode).toBe(401);
  });

  it('status 报告脚本可用与默认端口', async () => {
    const cookie = await login(A);
    const res = await call('GET', '/api/collect/status', cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().scriptAvailable).toBe(true);
    expect(res.json().defaultPort).toBe(9222);
    expect(res.json().hint).toContain('Chrome');
  });

  it('不存在的记录 / 别人的记录都 404', async () => {
    const a = await login(A);
    const b = await login(B);
    const idA = await createTracker(a, []);
    expect((await call('POST', '/api/collect/chat', a, { trackerId: 'no-such-id' })).statusCode).toBe(404);
    expect((await call('POST', '/api/collect/chat', b, { trackerId: idA })).statusCode).toBe(404);
  });

  it('非法 port / url 直接拒绝，不调用脚本也不写库', async () => {
    const cookie = await login(A);
    const id = await createTracker(cookie, []);
    const bad = [
      { trackerId: id, port: 99999 },
      { trackerId: id, port: '9222; rm -rf /' },
      { trackerId: id, url: 'javascript:alert(1)' },
    ];
    for (const body of bad) {
      const res = await call('POST', '/api/collect/chat', cookie, body);
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(false);
      expect(res.json().added).toBe(0);
    }
    expect(await chatOf(cookie, id)).toEqual([]);
  });
});

describe('P2b · 采集直接写库（替代 seed.json 通道）', () => {
  it('首次采集去重后入库，重复采集幂等', async () => {
    const cookie = await login(A);
    const id = await createTracker(cookie, [{ role: 'hr', name: '刘女士·HRBP', ts: 1793693100000, text: HR_TEXT }]);

    const first = await call('POST', '/api/collect/chat', cookie, { trackerId: id });
    expect(first.statusCode).toBe(200);
    expect(first.json().ok).toBe(true);
    expect(first.json().added).toBe(3);
    expect(first.json().total).toBe(4);

    const chat = await chatOf(cookie, id);
    expect(chat).toHaveLength(4);
    expect(chat[0].ts).toBe(1793693100000); // 旧消息原样保留
    expect(chat[1]).toMatchObject({ role: 'me', text: MSG_2, source: 'cdp', timeText: '昨天 14:31' });
    expect(chat.filter((m) => m.text === MSG_3)).toHaveLength(2); // 同批重复都保留

    const second = await call('POST', '/api/collect/chat', cookie, { trackerId: id });
    expect(second.json().added).toBe(0);
    expect(second.json().total).toBe(4);
    expect(second.json().ok).toBe(false);
    expect(await chatOf(cookie, id)).toHaveLength(4);
  });

  it('跨账号采集不串数据：B 采集不会影响 A 的记录', async () => {
    const a = await login(A);
    const b = await login(B);
    const idA = await createTracker(a, [{ role: 'hr', text: 'A 的私有聊天' }]);
    const idB = await createTracker(b, []);
    const beforeA = await chatOf(a, idA);

    expect((await call('POST', '/api/collect/chat', b, { trackerId: idA })).statusCode).toBe(404);
    expect(await chatOf(a, idA)).toEqual(beforeA);

    const own = await call('POST', '/api/collect/chat', b, { trackerId: idB });
    expect(own.json().added).toBe(4); // B 的记录没有旧消息，4 条有效消息全入库
    expect(await chatOf(a, idA)).toEqual(beforeA);
  });

  it('脚本输出非法 JSON → 诚实降级', async () => {
    process.env.BOSS_COLLECT_SCRIPT = invalidFixture;
    const cookie = await login(A);
    const id = await createTracker(cookie, []);
    const res = await call('POST', '/api/collect/chat', cookie, { trackerId: id });
    expect(res.json().ok).toBe(false);
    expect(res.json().added).toBe(0);
    expect(res.json().hint).toContain('无有效输出');
    expect(await chatOf(cookie, id)).toEqual([]);
    process.env.BOSS_COLLECT_SCRIPT = fixture;
  });

  it('脚本卡住 → 超时返回，不挂死请求', async () => {
    process.env.BOSS_COLLECT_SCRIPT = hangFixture;
    process.env.COLLECT_TIMEOUT_MS = '300';
    const cookie = await login(A);
    const id = await createTracker(cookie, []);
    const res = await call('POST', '/api/collect/chat', cookie, { trackerId: id });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(res.json().hint).toContain('超时');
    process.env.BOSS_COLLECT_SCRIPT = fixture;
    process.env.COLLECT_TIMEOUT_MS = '4000';
  });
});
