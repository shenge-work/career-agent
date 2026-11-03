import 'reflect-metadata';
import fs from 'node:fs';
import http from 'node:http';
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
import {
  buildChatPayload,
  isPrivateIpLiteral,
  normalizeConfig,
  publicConfig,
  validateBaseUrl,
} from '../src/server/ai/ai-config';

let app: NestFastifyApplication;
let db: Database;
let closeDb: () => Promise<void>;
let upstream: http.Server;
let upstreamPort = 0;
let mode: 'ok' | 'error' | 'hang' = 'ok';
let lastUpstream: { headers: http.IncomingHttpHeaders; body: any; url: string } | null = null;
let legacyConfigFile: string;
let originalAiConfigFile: string | undefined;
let tmpDir: string;

const ADMIN = { email: 'admin@local.test', password: 'admin-pass-123' };
const A = { email: 'a@local.test', password: 'aaaa-pass-123' };
const B = { email: 'b@local.test', password: 'bbbb-pass-123' };
const SECRET = 'sk-this-must-never-reach-browser-9527';

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

const goodConfig = (extra: Record<string, unknown> = {}) => ({
  provider: 'test-mock',
  baseUrl: `http://127.0.0.1:${upstreamPort}`,
  apiKey: SECRET,
  models: { fast: 'mock-fast', strong: 'mock-strong' },
  temperature: 0.3,
  timeoutMs: 5000,
  ...extra,
});

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-ai-test-'));
  legacyConfigFile = path.join(tmpDir, 'no-legacy-config.json');
  originalAiConfigFile = process.env.AI_CONFIG_FILE;
  process.env.AI_CONFIG_FILE = legacyConfigFile; // 隔绝真实 ai.config.json

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
      lastUpstream = { headers: req.headers, body, url: req.url || '' };
      if (mode === 'error') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream boom' }));
        return;
      }
      if (mode === 'hang') return; // 不响应，用于超时用例
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
      }
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
  if (upstream) {
    (upstream as any).closeAllConnections?.();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
  if (closeDb) await closeDb();
  if (originalAiConfigFile === undefined) delete process.env.AI_CONFIG_FILE;
  else process.env.AI_CONFIG_FILE = originalAiConfigFile;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('P2b · AI 配置的纯函数', () => {
  it('baseUrl 拒绝内网 / 元数据 / 非 http(s) / userinfo / 明文 http 公网', () => {
    for (const url of [
      'http://192.168.1.10:8080',
      'https://169.254.169.254/latest/meta-data',
      'http://api.example.com',
      'file:///etc/passwd',
      'https://user:pw@api.example.com',
      'https://10.0.0.5',
      'https://api.example.com/?x=1',
      'https://172.16.0.1',
    ]) {
      expect(validateBaseUrl(url).ok, url).toBe(false);
    }
    expect(validateBaseUrl('https://api.deepseek.com').ok).toBe(true);
    expect(validateBaseUrl('http://127.0.0.1:11434').ok).toBe(true);
    expect(validateBaseUrl('http://localhost:11434/v1').ok).toBe(true);
  });

  it('私有 IP 字面量识别覆盖 IPv4 / IPv6', () => {
    expect(isPrivateIpLiteral('10.1.2.3')).toBe(true);
    expect(isPrivateIpLiteral('172.31.255.255')).toBe(true);
    expect(isPrivateIpLiteral('169.254.169.254')).toBe(true);
    expect(isPrivateIpLiteral('fd00::1')).toBe(true);
    expect(isPrivateIpLiteral('8.8.8.8')).toBe(false);
    expect(isPrivateIpLiteral('127.0.0.1')).toBe(false);
  });

  it('normalizeConfig：首次缺 Key 拒绝，留空沿用旧值', () => {
    const base = { baseUrl: 'https://api.example.com', models: { fast: 'm' } };
    expect(normalizeConfig({ ...base, apiKey: '' }).ok).toBe(false);
    const existing = {
      provider: 'p', baseUrl: 'https://api.example.com', apiKey: 'old-key',
      models: {}, temperature: 0.4, timeoutMs: 60000, source: 'database' as const,
    };
    const r = normalizeConfig({ ...base, apiKey: '' }, existing);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.apiKey).toBe('old-key');
  });

  it('publicConfig 永不携带 apiKey 明文', () => {
    const cfg = {
      provider: 'p', baseUrl: 'https://api.example.com', apiKey: SECRET,
      models: { fast: 'm' }, temperature: 0.4, timeoutMs: 60000, source: 'database' as const,
    };
    const out = publicConfig(cfg);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.hasApiKey).toBe(true);
    expect(out.model).toBe('m');
    expect('apiKey' in out).toBe(false);
  });

  it('buildChatPayload 只放行白名单字段', () => {
    const cfg = {
      provider: 'p', baseUrl: 'https://api.example.com', apiKey: SECRET,
      models: { fast: 'm' }, temperature: 0.4, timeoutMs: 60000, source: 'database' as const,
    };
    const r = buildChatPayload(cfg, {
      messages: [{ role: 'user', content: 'hi', evil: 'x' }],
      model: 'm', temperature: 0.1, max_tokens: 32,
    }, true);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.stream).toBe(true);
      expect((r.payload.messages as any[])[0]).toEqual({ role: 'user', content: 'hi' });
      expect(r.payload.max_tokens).toBe(32);
      expect('evil' in r.payload).toBe(false);
    }
    expect(buildChatPayload(cfg, { messages: [] }, true).ok).toBe(false);
  });
});

describe('P2b · AI 接口门禁与配置隔离', () => {
  it('未登录访问全部 401', async () => {
    expect((await call('GET', '/api/ai/status')).statusCode).toBe(401);
    expect((await call('PUT', '/api/ai/config', undefined, goodConfig())).statusCode).toBe(401);
    expect((await call('POST', '/api/ai/test')).statusCode).toBe(401);
    expect((await call('POST', '/api/ai/chat', undefined, { messages: [{ role: 'user', content: 'x' }] })).statusCode).toBe(401);
    expect((await call('GET', '/api/collect/status')).statusCode).toBe(401);
  });

  it('初始状态：未配置、无 Key、用量全 0', async () => {
    const cookie = await login(A);
    const res = await call('GET', '/api/ai/status', cookie);
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.configured).toBe(false);
    expect(j.hasApiKey).toBe(false);
    expect(j.source).toBe('none');
    expect(j.usage.requests).toBe(0);
  });

  it('非法配置一律 400（SSRF / 参数越界）', async () => {
    const cookie = await login(A);
    const bad = [
      goodConfig({ baseUrl: 'http://192.168.1.1:8080' }),
      goodConfig({ baseUrl: 'https://169.254.169.254' }),
      goodConfig({ baseUrl: 'http://api.example.com' }),
      goodConfig({ apiKey: '' }),
      goodConfig({ temperature: 9 }),
      goodConfig({ timeoutMs: 10 }),
      goodConfig({ models: ['not', 'object'] }),
    ];
    for (const body of bad) {
      const res = await call('PUT', '/api/ai/config', cookie, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('保存合法配置 → 响应脱敏，状态里也没有明文 Key', async () => {
    const cookie = await login(A);
    const res = await call('PUT', '/api/ai/config', cookie, goodConfig());
    expect(res.statusCode).toBe(200);
    expect(res.json().configured).toBe(true);
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain(SECRET);

    const status = await call('GET', '/api/ai/status', cookie);
    expect(status.json().source).toBe('database');
    expect(status.json().hasApiKey).toBe(true);
    expect(status.json().model).toBe('mock-fast');
    expect(JSON.stringify(status.json())).not.toContain(SECRET);
  });

  it('配置按账号隔离：B 看不到 A 的配置，也无法借用', async () => {
    const b = await login(B);
    const s = await call('GET', '/api/ai/status', b);
    expect(s.json().configured).toBe(false);
    const t = await call('POST', '/api/ai/test', b);
    expect(t.statusCode).toBe(200);
    expect(t.json().ok).toBe(false);
    const c = await call('POST', '/api/ai/chat', b, { messages: [{ role: 'user', content: 'hi' }] });
    expect(c.statusCode).toBe(400);
  });

  it('apiKey 留空沿用旧值，PUT 后上游仍收到原 Key', async () => {
    const cookie = await login(A);
    const patch = goodConfig({ apiKey: '', provider: 'test-mock-2' });
    const res = await call('PUT', '/api/ai/config', cookie, patch);
    expect(res.statusCode).toBe(200);
    const t = await call('POST', '/api/ai/test', cookie);
    expect(t.json().ok).toBe(true);
    expect(lastUpstream?.headers.authorization).toBe('Bearer ' + SECRET);
  });
});

describe('P2b · AI 上游转发与 SSE', () => {
  it('POST /test 走非流式，返回探活结果并累计用量', async () => {
    const cookie = await login(A);
    mode = 'ok';
    const res = await call('POST', '/api/ai/test', cookie);
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.ok).toBe(true);
    expect(j.model).toBe('mock-fast');
    expect(typeof j.latencyMs).toBe('number');
    expect(lastUpstream?.body.stream).toBe(false);
    expect(String(lastUpstream?.url)).toContain('/chat/completions');
  });

  it('POST /chat 把上游 SSE 字节流原样透传', async () => {
    const cookie = await login(A);
    mode = 'ok';
    const res = await call('POST', '/api/ai/chat', cookie, {
      messages: [{ role: 'user', content: '你好' }],
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/event-stream');
    expect(res.body).toContain('data: {"choices":[{"delta":{"content":"你"}}]}');
    expect(res.body).toContain('data: {"choices":[{"delta":{"content":"好"}}]}');
    expect(res.body).toContain('data: [DONE]');
    expect(lastUpstream?.body.stream).toBe(true);
    expect(lastUpstream?.body.model).toBe('mock-fast');
  });

  it('model 可覆盖；messages 为空 / 缺模型时 400', async () => {
    const cookie = await login(A);
    const ok = await call('POST', '/api/ai/chat', cookie, {
      model: 'mock-strong', messages: [{ role: 'user', content: 'x' }],
    });
    expect(ok.statusCode).toBe(200);
    expect(lastUpstream?.body.model).toBe('mock-strong');

    const bad = await call('POST', '/api/ai/chat', cookie, { messages: [] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain('messages');
  });

  it('上游 500 → 原样透传状态码且错误文本来自上游；用量记一次失败', async () => {
    const cookie = await login(A);
    const before = (await call('GET', '/api/ai/status', cookie)).json().usage.errors;
    mode = 'error';
    const res = await call('POST', '/api/ai/chat', cookie, { messages: [{ role: 'user', content: 'x' }] });
    expect(res.statusCode).toBe(500);
    expect(String(res.json().message)).toContain('upstream boom');
    const after = (await call('GET', '/api/ai/status', cookie)).json().usage.errors;
    expect(after).toBe(before + 1);
    mode = 'ok';
  });

  it('上游超时 → 504 TIMEOUT（timeoutMs 生效）', async () => {
    const cookie = await login(A);
    await call('PUT', '/api/ai/config', cookie, goodConfig({ timeoutMs: 1000 }));
    mode = 'hang';
    const res = await call('POST', '/api/ai/chat', cookie, { messages: [{ role: 'user', content: 'x' }] });
    expect(res.statusCode).toBe(504);
    expect(res.json().code).toBe('TIMEOUT');
    mode = 'ok';
    await call('PUT', '/api/ai/config', cookie, goodConfig());
  });

  it('用量按账号累计，B 始终为 0', async () => {
    const a = await login(A);
    const b = await login(B);
    const sa = (await call('GET', '/api/ai/status', a)).json();
    const sb = (await call('GET', '/api/ai/status', b)).json();
    expect(sa.usage.requests).toBeGreaterThanOrEqual(5);
    expect(sa.usage.days.length).toBeGreaterThan(0);
    expect(sb.usage.requests).toBe(0);
    expect(sa.usage.lastModel).toBeTruthy();
  });

  it('DELETE /config 停用后 chat 回到 400', async () => {
    const cookie = await login(A);
    expect((await call('DELETE', '/api/ai/config', cookie)).statusCode).toBe(200);
    const s = await call('GET', '/api/ai/status', cookie);
    expect(s.json().configured).toBe(false);
    const c = await call('POST', '/api/ai/chat', cookie, { messages: [{ role: 'user', content: 'x' }] });
    expect(c.statusCode).toBe(400);
  });

  it('v1 ai.config.json 只读回退，保存后切回账号配置', async () => {
    const cookie = await login(B);
    const file = path.join(tmpDir, 'legacy.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        provider: 'legacy', baseURL: `http://127.0.0.1:${upstreamPort}`,
        apiKey: 'sk-legacy', models: { fast: 'legacy-fast' },
      })
    );
    process.env.AI_CONFIG_FILE = file;
    const s = await call('GET', '/api/ai/status', cookie);
    expect(s.json().configured).toBe(true);
    expect(s.json().source).toBe('legacy-file');
    expect(JSON.stringify(s.json())).not.toContain('sk-legacy');

    await call('PUT', '/api/ai/config', cookie, goodConfig({ apiKey: 'sk-b-own' }));
    expect((await call('GET', '/api/ai/status', cookie)).json().source).toBe('database');
    process.env.AI_CONFIG_FILE = legacyConfigFile;
  });
});
