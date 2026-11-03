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

const ADMIN = { email: 'admin@local.test', password: 'admin-pass-123' };
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

async function createResume(cookie: string, title: string): Promise<string> {
  const res = await call('POST', '/api/resumes', cookie, { title, payload: { data: { sections: [] } } });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

beforeAll(async () => {
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
});

describe('P2 · 新接口门禁', () => {
  it('未登录访问公司 / 投递 / 设置 / 版本全部 401', async () => {
    for (const url of [
      '/api/companies',
      '/api/tracker',
      '/api/settings',
      '/api/resumes/whatever/versions',
    ]) {
      expect((await call('GET', url)).statusCode).toBe(401);
    }
  });

  it('路由不冲突：:id 与 :id/jds、:id/versions 各自命中', async () => {
    const cookie = await login(A);
    const created = await call('POST', '/api/companies', cookie, { name: '路由测试公司' });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    expect((await call('GET', `/api/companies/${id}`, cookie)).statusCode).toBe(200);
    expect((await call('GET', `/api/companies/${id}/jds`, cookie)).json()).toEqual([]);

    const rid = await createResume(cookie, '版本路由测试');
    expect((await call('GET', `/api/resumes/${rid}`, cookie)).statusCode).toBe(200);
    expect((await call('GET', `/api/resumes/${rid}/versions`, cookie)).json()).toEqual([]);
  });
});

describe('P2 · 公司档案与 JD 的行级隔离', () => {
  it('A 的公司 B 读不到：单条 404、列表不出现、改删也 404', async () => {
    const a = await login(A);
    const b = await login(B);
    const created = await call('POST', '/api/companies', a, {
      name: 'A 的私有公司',
      payload: { industry: 'AI', research: [{ dim: '公司简介', content: '内部资料' }] },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    expect((await call('GET', `/api/companies/${id}`, b)).statusCode).toBe(404);
    const listB = await call('GET', '/api/companies', b);
    expect(listB.json().some((c: any) => c.id === id)).toBe(false);
    expect((await call('PUT', `/api/companies/${id}`, b, { name: '篡改' })).statusCode).toBe(404);
    expect((await call('DELETE', `/api/companies/${id}`, b)).statusCode).toBe(404);

    const own = await call('GET', `/api/companies/${id}`, a);
    expect(own.statusCode).toBe(200);
    expect(own.json().name).toBe('A 的私有公司');
    expect(own.json().payload.industry).toBe('AI');
  });

  it('公司 CRUD + 重命名 + 删除时连带清理 JD', async () => {
    const a = await login(A);
    const created = await call('POST', '/api/companies', a, { name: '待改公司' });
    const id = created.json().id;

    const jd = await call('POST', `/api/companies/${id}/jds`, a, {
      payload: { title: 'Agent 工程师', salary: '30-60K' },
    });
    expect(jd.statusCode).toBe(201);
    expect(jd.json().payload.id).toBe(jd.json().id);

    const renamed = await call('PUT', `/api/companies/${id}`, a, { name: '已改公司' });
    expect(renamed.json().name).toBe('已改公司');

    const jdId = jd.json().id;
    expect((await call('GET', `/api/companies/${id}/jds`, a)).json().length).toBe(1);
    expect((await call('DELETE', `/api/companies/${id}/jds/${jdId}`, a)).statusCode).toBe(200);
    expect((await call('GET', `/api/companies/${id}/jds`, a)).json()).toEqual([]);

    await call('POST', `/api/companies/${id}/jds`, a, { payload: { title: '另一个岗位' } });
    expect((await call('DELETE', `/api/companies/${id}`, a)).statusCode).toBe(200);
    expect((await call('GET', `/api/companies/${id}`, a)).statusCode).toBe(404);
    expect((await call('GET', `/api/companies/${id}/jds`, a)).statusCode).toBe(404);
  });

  it('B 不能用 A 的 companyId 读/建/删 JD', async () => {
    const a = await login(A);
    const b = await login(B);
    const id = (await call('POST', '/api/companies', a, { name: 'JD 隔离公司' })).json().id;
    const jd = await call('POST', `/api/companies/${id}/jds`, a, { payload: { title: '私有岗位' } });
    const jdId = jd.json().id;

    expect((await call('GET', `/api/companies/${id}/jds`, b)).statusCode).toBe(404);
    expect((await call('POST', `/api/companies/${id}/jds`, b, { payload: { title: '注入' } })).statusCode).toBe(404);
    expect((await call('DELETE', `/api/companies/${id}/jds/${jdId}`, b)).statusCode).toBe(404);
    expect((await call('GET', `/api/companies/${id}/jds`, a)).json().length).toBe(1);
  });
});

describe('P2 · 投递管理的行级隔离', () => {
  it('A 建投递记录，B 列表不出现且单条 / 改 / 删均 404', async () => {
    const a = await login(A);
    const b = await login(B);
    const created = await call('POST', '/api/tracker', a, {
      payload: { company: '测试公司', position: 'Agent 工程师', platform: 'BOSS直聘', chat: [] },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const listB = await call('GET', '/api/tracker', b);
    expect(listB.json().some((r: any) => r.id === id)).toBe(false);
    expect((await call('GET', `/api/tracker/${id}`, b)).statusCode).toBe(404);
    expect((await call('PUT', `/api/tracker/${id}`, b, { payload: { status: '篡改' } })).statusCode).toBe(404);
    expect((await call('DELETE', `/api/tracker/${id}`, b)).statusCode).toBe(404);

    const own = await call('GET', `/api/tracker/${id}`, a);
    expect(own.json().payload.company).toBe('测试公司');
  });

  it('companyId 必须是本人的公司，否则 404', async () => {
    const a = await login(A);
    const b = await login(B);
    const companyId = (await call('POST', '/api/companies', a, { name: 'A 的公司' })).json().id;
    expect((await call('POST', '/api/tracker', b, { companyId, payload: { company: '越权' } })).statusCode).toBe(404);
    expect((await call('POST', '/api/tracker', a, { companyId, payload: { company: '正常' } })).statusCode).toBe(201);
  });
});

describe('P2 · 版本历史与设置', () => {
  it('版本历史先校验简历归属，B 不能用 A 的 resumeId 读写', async () => {
    const a = await login(A);
    const b = await login(B);
    const rid = await createResume(a, '版本隔离简历');

    const added = await call('POST', `/api/resumes/${rid}/versions`, a, {
      kind: 'manual',
      label: '手动快照',
      snapshot: { data: { name: '快照' } },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().snapshot.data.name).toBe('快照');
    expect((await call('GET', `/api/resumes/${rid}/versions`, a)).json().length).toBe(1);

    expect((await call('GET', `/api/resumes/${rid}/versions`, b)).statusCode).toBe(404);
    expect((await call('POST', `/api/resumes/${rid}/versions`, b, { snapshot: { x: 1 } })).statusCode).toBe(404);
    expect((await call('GET', `/api/resumes/${rid}/versions`, a)).json().length).toBe(1);
  });

  it('删除简历时一并清理版本历史', async () => {
    const a = await login(A);
    const rid = await createResume(a, '待删简历');
    await call('POST', `/api/resumes/${rid}/versions`, a, { kind: 'manual', snapshot: { a: 1 } });
    expect((await call('GET', `/api/resumes/${rid}/versions`, a)).json().length).toBe(1);
    expect((await call('DELETE', `/api/resumes/${rid}`, a)).statusCode).toBe(200);
    expect((await call('GET', `/api/resumes/${rid}/versions`, a)).statusCode).toBe(404);
  });

  it('设置是 jsonb 合并且按账号隔离', async () => {
    const a = await login(A);
    const b = await login(B);

    expect((await call('GET', '/api/settings', a)).json().payload).toEqual({});
    await call('PUT', '/api/settings', a, { theme: 'dark' });
    const merged = await call('PUT', '/api/settings', a, { activeResumeId: 'res_x' });
    expect(merged.json().payload).toEqual({ theme: 'dark', activeResumeId: 'res_x' });
    expect((await call('GET', '/api/settings', a)).json().payload.theme).toBe('dark');
    expect((await call('GET', '/api/settings', b)).json().payload).toEqual({});
    expect((await call('PUT', '/api/settings', a, {})).statusCode).toBe(400);
  });
});

describe('P2 · 主简历互斥', () => {
  it('设为主简历时清掉旧主，且目标不存在时零副作用', async () => {
    const a = await login(A);
    const first = (await call('POST', '/api/resumes', a, {
      title: '第一份',
      isMaster: true,
      payload: { data: { sections: [] } },
    })).json();
    const second = await createResume(a, '第二份');

    const set = await call('POST', `/api/resumes/${second}/master`, a);
    expect(set.statusCode).toBe(201);
    expect(set.json().isMaster).toBe(true);
    expect((await call('GET', `/api/resumes/${first.id}`, a)).json().isMaster).toBe(false);

    expect((await call('POST', '/api/resumes/not-exist/master', a)).statusCode).toBe(404);
    expect((await call('GET', `/api/resumes/${second}`, a)).json().isMaster).toBe(true);
  });

  it('B 不能把 A 的简历设为主，也不影响 A 的主简历状态', async () => {
    const a = await login(A);
    const b = await login(B);
    const master = (await call('POST', '/api/resumes', a, {
      title: 'A 的主',
      isMaster: true,
      payload: { data: { sections: [] } },
    })).json();
    expect((await call('POST', `/api/resumes/${master.id}/master`, b)).statusCode).toBe(404);
    expect((await call('GET', `/api/resumes/${master.id}`, a)).json().isMaster).toBe(true);
  });
});
