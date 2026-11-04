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
import {
  buildPageMarginRule,
  buildStandaloneHtml,
  escapeHtml,
  findLegacyRoot,
  mmNum,
  renderResume,
} from '../src/server/render/legacy-renderer';
import { findBrowser } from '../src/server/render/pdf.service';

/* ---------- 虚构数据 fixture（不含任何真实 PII） ---------- */
function makePayload(name: string, extra: Record<string, any> = {}) {
  return {
    data: {
      name,
      subtitle: '测试头衔 / Agent 方向',
      meta: '',
      contact: [{ text: 'test@example.com', spacing: { mt: 0, mb: 0 } }],
      pageMargins: { top: 20, right: 12, bottom: 18, left: 16 },
      sections: [
        {
          id: 's1',
          type: 'highlights',
          title: '个人优势',
          cards: [{ text: '**五年经验** · ' + name + ' 的要点', spacing: { mt: 0, mb: 0 } }],
          tags: [],
        },
      ],
      ...extra,
    },
    v: 1,
    savedAt: 1700000000000,
  };
}

/* ============================================================ 纯函数层 */
describe('P4 · 服务端渲染器（v1 真实管线）', () => {
  it('能定位到 v1 渲染引擎源码，且不复制第二份', () => {
    const root = findLegacyRoot();
    expect(root.endsWith('/v2') || root.endsWith('/v2/')).toBe(false);
    expect(root.length).toBeGreaterThan(0);
  });

  it('渲染出完整 A4 HTML：.resume / 姓名 / 板块 / 联系方式 / **加粗** / 内联 CSS', () => {
    const r = renderResume(makePayload('虚构甲'));
    expect(r.resumeHtml).toContain('class="resume"');
    expect(r.resumeHtml).toContain('虚构甲');
    expect(r.resumeHtml).toContain('个人优势');
    expect(r.resumeHtml).toContain('test@example.com');
    expect(r.resumeHtml).toContain('<strong>五年经验</strong>');
    expect(r.html).toContain('<!DOCTYPE html>');
    expect(r.html).toContain('.resume');           // css/style.css 已内联
    expect(r.html.length).toBeGreaterThan(20000);
  });

  it('@page 边距跟随 payload，且 null / 空串不退化成 0mm', () => {
    expect(buildPageMarginRule(makePayload('甲'))).toBe(
      '@media print{@page{size:A4;margin:20mm 12mm 18mm 16mm;}}'
    );
    const p = makePayload('甲', { pageMargins: { top: null, right: '', bottom: -1, left: 'abc' } });
    expect(buildPageMarginRule(p)).toBe('@media print{@page{size:A4;margin:14mm 14mm 14mm 14mm;}}');
    expect(mmNum(null, 14)).toBe(14);
    expect(mmNum('', 14)).toBe(14);
    expect(mmNum(-1, 14)).toBe(14);
    expect(mmNum('abc', 14)).toBe(14);
    expect(mmNum(0, 14)).toBe(0);            // 显式 0 是合法值，不能被兜底吃掉
    expect(mmNum(12.345, 14)).toBe(12.35);
  });

  it('escapeHtml 覆盖五类字符', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;'
    );
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(123)).toBe('123');
  });

  it('name 含注入标签时 title 被转义，且 CSP 明确禁止脚本执行', () => {
    const evil = '</title><script>alert(1)</script>';
    const r = renderResume(makePayload(evil));
    expect(r.html).not.toContain('<script>alert(1)</script>');
    expect(r.html).toContain('&lt;/title&gt;&lt;script&gt;');
    expect(r.html).toContain("script-src 'none'");
    expect(r.html).toContain("object-src 'none'");
  });

  it('连续渲染两份不同 payload 不串数据（每次新建 vm context）', () => {
    const a = renderResume(makePayload('虚构甲'));
    const b = renderResume(makePayload('虚构乙'));
    const c = renderResume(makePayload('虚构甲'));
    expect(a.resumeHtml).toContain('虚构甲');
    expect(a.resumeHtml).not.toContain('虚构乙');
    expect(b.resumeHtml).toContain('虚构乙');
    expect(b.resumeHtml).not.toContain('虚构甲');
    expect(c.resumeHtml).toContain('虚构甲');
  });

  it('缺少 data.sections 直接拒绝，不产出半截 HTML', () => {
    expect(() => renderResume({ data: { name: '甲' } })).toThrow(/data.sections/);
    expect(() => renderResume(null)).toThrow(/data.sections/);
  });

  it('buildStandaloneHtml 可单独组装，且带字体 CSS 变量外壳', () => {
    const html = buildStandaloneHtml('<div class="resume">片段</div>', makePayload('虚构甲'));
    expect(html).toContain('<div class="resume">片段</div>');
    expect(html).toContain('虚构甲 · 简历');
    expect(html).not.toContain('<script');
  });
});

/* ============================================================ HTTP 层 */
let app: NestFastifyApplication;
let db: Database;
let closeDb: () => Promise<void>;

const A = { email: 'render-a@local.test', password: 'aaaa-pass-123' };
const B = { email: 'render-b@local.test', password: 'bbbb-pass-123' };

async function call(method: string, url: string, cookie?: string, payload?: unknown) {
  return app.inject({
    method: method as any,
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

describe('P4 · 渲染 API 与行级隔离', () => {
  it('未登录访问 preview / pdf 一律 401', async () => {
    expect((await call('GET', '/api/resumes/whatever/preview')).statusCode).toBe(401);
    expect((await call('GET', '/api/resumes/whatever/pdf')).statusCode).toBe(401);
  });

  it('登录后 preview 返回 text/html，内容与本人 payload 一致', async () => {
    const cookie = await login(A);
    const created = await call('POST', '/api/resumes', cookie, {
      title: '甲的可渲染简历',
      payload: makePayload('虚构甲'),
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const res = await call('GET', `/api/resumes/${id}/preview`, cookie);
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/html');
    expect(res.body).toContain('class="resume"');
    expect(res.body).toContain('虚构甲');
    expect(res.body).toContain('个人优势');
    expect(res.body).toContain('margin:20mm 12mm 18mm 16mm');
  });

  it('别的用户的 preview 与 pdf 都是 404（不泄露简历内容）', async () => {
    const cookieA = await login(A);
    const cookieB = await login(B);
    const created = await call('POST', '/api/resumes', cookieA, {
      title: '仅甲可见',
      payload: makePayload('甲的私有内容'),
    });
    const id = created.json().id;

    const prev = await call('GET', `/api/resumes/${id}/preview`, cookieB);
    expect(prev.statusCode).toBe(404);
    expect(prev.body).not.toContain('甲的私有内容');

    const pdf = await call('GET', `/api/resumes/${id}/pdf`, cookieB);
    expect(pdf.statusCode).toBe(404);
    expect(pdf.body).not.toContain('甲的私有内容');
  });

  it('不存在的简历 preview 返回 404 而不是空白 HTML', async () => {
    const cookie = await login(A);
    const res = await call('GET', '/api/resumes/res_does_not_exist/preview', cookie);
    expect(res.statusCode).toBe(404);
  });

  // 有浏览器时真打印一次；没有浏览器时验证诚实降级 501（不假装成功）
  const hasBrowser = findBrowser() !== null;
  const pdfIt = hasBrowser ? it : it.skip;
  pdfIt(
    '有 Chrome 时静默导出文字可选中的 PDF（%PDF 头 + 附件名）',
    async () => {
      const cookie = await login(A);
      const created = await call('POST', '/api/resumes', cookie, {
        title: '导出测试',
        payload: makePayload('虚构甲'),
      });
      const id = created.json().id;
      const res = await call('GET', `/api/resumes/${id}/pdf`, cookie);
      expect(res.statusCode).toBe(200);
      expect(String(res.headers['content-type'])).toContain('application/pdf');
      expect(String(res.headers['content-disposition'])).toContain('.pdf');
      const buf = res.rawPayload;
      expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    },
    120000
  );

  const noBrowserIt = hasBrowser ? it.skip : it;
  noBrowserIt('没有浏览器时 PDF 端点诚实返回 501 + 降级提示', async () => {
    const cookie = await login(A);
    const created = await call('POST', '/api/resumes', cookie, {
      title: '降级测试',
      payload: makePayload('虚构甲'),
    });
    const res = await call('GET', `/api/resumes/${created.json().id}/pdf`, cookie);
    expect(res.statusCode).toBe(501);
    expect(res.json().hint).toMatch(/另存为 PDF/);
  });
});
