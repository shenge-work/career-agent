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
  buildImagePdfHtml,
  safeJsonForScript,
} from '../src/server/render/legacy-export-html';
import { ImagePdfService } from '../src/server/render/image-pdf.service';
import { findBrowser, NoBrowserError } from '../src/server/render/pdf.service';

/* ---------- 虚构数据 fixture（不含任何真实 PII） ---------- */
function makePayload(name: string, sections?: any[]) {
  return {
    data: {
      name,
      subtitle: '测试头衔 / Agent 方向',
      meta: '',
      contact: [{ text: 'test@example.com', spacing: { mt: 0, mb: 0 } }],
      pageMargins: { top: 14, right: 14, bottom: 14, left: 14 },
      sections: sections || [
        {
          id: 's1', type: 'highlights', title: '个人优势',
          cards: [{ text: '**五年经验** · ' + name + ' 的要点', spacing: { mt: 0, mb: 0 } }],
          tags: [],
        },
      ],
    },
    v: 1,
    savedAt: 1700000000000,
  };
}

/** 撑出多页的简历，用来触发自然分页点 + 不切行吸附 */
function makeLongPayload(name: string) {
  const sections = Array.from({ length: 6 }, (_, i) => ({
    id: 'sec' + i,
    type: 'highlights',
    title: '板块 ' + (i + 1),
    tags: [],
    cards: Array.from({ length: 8 }, (_, j) => ({
      text: '**要点 ' + j + '** · ' + name + ' 在第 ' + (i + 1) + ' 个板块的第 ' + (j + 1) +
        ' 条说明文字，用于撑开版面以触发自然分页点与行间空白吸附逻辑，保证切口不落在文字行中间。',
      spacing: { mt: 0, mb: 0 },
    })),
  }));
  return makePayload(name, sections);
}

/* ============================================================ 纯函数层 */
describe('P4b · 导出页生成（纯函数）', () => {
  it('safeJsonForScript 防 </script> 逃逸与行分隔符，且中文原样保真', () => {
    const evil = { name: '</script><script>alert(1)</script>', note: 'a\u2028b\u2029c' };
    const s = safeJsonForScript(evil);
    expect(s).not.toContain('</script>');
    expect(s).not.toContain('\u2028');
    expect(s).not.toContain('\u2029');
    expect(s).toContain('\\u003c');
    expect(JSON.parse(s)).toEqual(evil);
  });

  it('导出页内联 v1 真实导出管线与本地 vendor，不加载任何外部资源', () => {
    const { html } = buildImagePdfHtml(makePayload('虚构甲'));
    expect(html).toContain('<!DOCTYPE html>');
    // v1 截图导出管线的核心符号（不是复制的第二份实现）
    expect(html).toContain('function makeCaptureClone(live)');
    expect(html).toContain('RB.computePageBreaks(cap.clone)');
    expect(html).toContain('function computePageBreaks(root)');
    expect(html).toContain('function snapBreaksToBoxes');
    // 本地 vendor：离线可用
    expect(html).toContain('html2canvas');
    expect(html).toMatch(/jsPDF|jspdf/);
    expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)=["']https?:/i);
    expect(html).toContain("connect-src 'none'");
  });

  it('三个 headless 坑的防线都在：confirm 桩 / 无真 iframe / 下载而非回传 base64', () => {
    const { html } = buildImagePdfHtml(makePayload('虚构甲'));
    // 坑 1：applyImported 的 confirm() 会挂起主线程等 CDP 处理对话框
    expect(html).toContain('window.confirm = function(){ return true; }');
    // 坑 2：真 iframe 加载 blob: PDF 会让 headless 卡住；pdfFrame 必须交给 DOM 兜底。
    // 注意 vendor 源码里含 <iframe 字面量，所以只否定「页面里有 pdfFrame 这个 iframe 元素」。
    expect(html).not.toMatch(/<iframe[^>]*id=["']pdfFrame/i);
    expect(html).toContain("document.getElementById('pdfFrame')");
    // 坑 3：5MB base64 不能走 CDP 回传，直接让 Chrome 下载落盘
    expect(html).toContain('ResumeExport.downloadPDFNow()');
    expect(html).not.toContain('__RESULT__.base64');
    // DOM 哑元素兜底：v1 boot 里有不判空的 addEventListener
    expect(html).toContain('document.getElementById = function(id)');
    // 自动跑完整链路
    expect(html).toContain('ResumeEditor.applyImported(');
    expect(html).toContain('ResumeExport.exportPDF()');
    expect(html).toContain('__RESULT__');
  });

  it('payload 里的注入标签不会变成可执行脚本', () => {
    const evil = '</script><script>window.__PWNED__=1</script>';
    const { html } = buildImagePdfHtml(makePayload(evil));
    expect(html).not.toContain('<script>window.__PWNED__=1</script>');
    expect(html).toContain('\\u003c/script>');
    expect(html).not.toContain('虚构甲'); // fixture 姓名已被替换，不应残留默认名
  });

  it('缺少 data.sections 直接拒绝，不产出半截导出页', () => {
    expect(() => buildImagePdfHtml({ data: { name: '甲' } })).toThrow(/data.sections/);
    expect(() => buildImagePdfHtml(null)).toThrow(/data.sections/);
  });

  it('连续生成两份不同 payload 不串数据', () => {
    const a = buildImagePdfHtml(makePayload('虚构甲')).html;
    const b = buildImagePdfHtml(makePayload('虚构乙')).html;
    expect(a).toContain('虚构甲');
    expect(a).not.toContain('虚构乙');
    expect(b).toContain('虚构乙');
    expect(b).not.toContain('虚构甲');
  });
});

/* ============================================================ HTTP 层 */
let app: NestFastifyApplication;
let db: Database;
let closeDb: () => Promise<void>;

const A = { email: 'imgpdf-a@local.test', password: 'aaaa-pass-123' };
const B = { email: 'imgpdf-b@local.test', password: 'bbbb-pass-123' };

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

describe('P4b · 图片版 API 与行级隔离', () => {
  it('未登录访问图片版 PDF 与导出页一律 401', async () => {
    expect((await call('GET', '/api/resumes/whatever/pdf?mode=image')).statusCode).toBe(401);
    expect((await call('GET', '/api/resumes/whatever/export-page')).statusCode).toBe(401);
  });

  it('export-page 只返回本人简历内容', async () => {
    const cookie = await login(A);
    const created = await call('POST', '/api/resumes', cookie, {
      title: '甲的图片版简历', payload: makePayload('虚构甲'),
    });
    const id = created.json().id;
    const res = await call('GET', `/api/resumes/${id}/export-page`, cookie);
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/html');
    expect(res.body).toContain('虚构甲');
    expect(res.body).toContain('ResumeExport.exportPDF()');
  });

  it('别人的图片版 PDF 与导出页都是 404（不泄露简历内容）', async () => {
    const cookieA = await login(A);
    const cookieB = await login(B);
    const created = await call('POST', '/api/resumes', cookieA, {
      title: '甲私有', payload: makePayload('虚构甲'),
    });
    const id = created.json().id;
    expect((await call('GET', `/api/resumes/${id}/pdf?mode=image`, cookieB)).statusCode).toBe(404);
    expect((await call('GET', `/api/resumes/${id}/export-page`, cookieB)).statusCode).toBe(404);
  });

  it('不存在的简历两种模式都是 404', async () => {
    const cookie = await login(A);
    expect((await call('GET', '/api/resumes/res_missing/pdf?mode=image', cookie)).statusCode).toBe(404);
    expect((await call('GET', '/api/resumes/res_missing/export-page', cookie)).statusCode).toBe(404);
  });

  const hasBrowser = findBrowser() !== null;

  const realIt = hasBrowser ? it : it.skip;
  realIt(
    '有 Chrome 时图片版 PDF 真下载：%PDF 头 + 中文附件名 + 大体积',
    async () => {
      const cookie = await login(A);
      const created = await call('POST', '/api/resumes', cookie, {
        title: '图片版导出测试', payload: makeLongPayload('虚构甲'),
      });
      const id = created.json().id;
      const res = await call('GET', `/api/resumes/${id}/pdf?mode=image`, cookie);
      expect(res.statusCode).toBe(200);
      expect(String(res.headers['content-type'])).toContain('application/pdf');
      // filename* 是 RFC 5987 编码，中文后缀要先解码
      expect(decodeURIComponent(String(res.headers['content-disposition']))).toContain('_图片版');
      const buf = res.rawPayload;
      expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      // 图片版是位图页，体积远大于矢量版；用 100KB 区分「空壳 PDF」
      expect(buf.length).toBeGreaterThan(100_000);
    },
    180000
  );

  const noBrowserIt = hasBrowser ? it.skip : it;
  noBrowserIt('没有浏览器时图片版 PDF 诚实返回 501 + 降级提示', async () => {
    const cookie = await login(A);
    const created = await call('POST', '/api/resumes', cookie, {
      title: '降级测试', payload: makePayload('虚构甲'),
    });
    const res = await call('GET', `/api/resumes/${created.json().id}/pdf?mode=image`, cookie);
    expect(res.statusCode).toBe(501);
    expect(res.json().hint).toMatch(/矢量 PDF|另存为 PDF/);
  });
});

/* ============================================================ 真实导出契约 */
describe('P4b · 真实图片版导出契约', () => {
  const hasBrowser = findBrowser() !== null;
  const realIt = hasBrowser ? it : it.skip;

  realIt(
    '分页点量的是克隆节点、克隆与预览同高、断点单调且页数一致',
    async () => {
      const result = await new ImagePdfService().render(makeLongPayload('虚构甲'));
      expect(result.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(result.pages).toBeGreaterThanOrEqual(2);
      expect(result.pagesLabel).toMatch(/共\s*\d+\s*页/);
      expect(Number(result.pagesLabel.match(/\d+/)?.[0])).toBe(result.pages);
      // 铁律 A：computePageBreaks 的入参必须是被截图的那个克隆，不是实时预览
      expect(result.paging).not.toBeNull();
      expect(result.paging!.rootIsClone).toBe(true);
      // 铁律 B：makeCaptureClone 与预览必须同高，否则分页点 / 预览 / PDF 三者对不上
      expect(result.live.w).toBeGreaterThan(700);
      expect(result.live.h).toBeGreaterThan(1000);
      expect(result.paging!.rootW).toBe(result.live.w);
      expect(result.paging!.rootH).toBe(result.live.h);
      // 铁律 C：断点覆盖整篇内容，单调递增，首点为 0，吸附只会把自然点上移
      const breaks = result.paging!.breaks;
      expect(breaks.length).toBeGreaterThanOrEqual(3);
      expect(breaks[0]).toBe(0);
      for (let i = 1; i < breaks.length; i++) {
        expect(breaks[i]).toBeGreaterThan(breaks[i - 1]);
      }
      expect(breaks.length - 1).toBe(result.pages);
      expect(breaks[breaks.length - 1]).toBeLessThanOrEqual(result.live.h);
    },
    180000
  );

  const noBrowserIt = hasBrowser ? it.skip : it;
  noBrowserIt('没有浏览器时 render 直接抛 NoBrowserError', async () => {
    await expect(new ImagePdfService().render(makePayload('虚构甲'))).rejects.toBeInstanceOf(NoBrowserError);
  });
});
