/* =============================================================
 * 图片版 PDF（v1 截图导出管线）服务端驱动
 * -------------------------------------------------------------
 * 生成「导出专用页」→ headless Chrome 打开 → CDP 等它自动跑完 → Chrome 把
 * PDF 下载到独立临时目录 → 读回字节。全程不经过公网、不回传大字符串。
 *
 * 与 PdfService（矢量打印版）是两条独立链路：
 *   · 矢量版：Chrome --print-to-pdf，文字可选中、体积小、浏览器原生分页；
 *   · 图片版：html2canvas + jsPDF + computePageBreaks 的「不切行吸附」，
 *     版面与 v1 编辑器里看到的分页线严格一致，代价是不可选字 / 体积大。
 * ============================================================= */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { buildImagePdfHtml } from './legacy-export-html';
import { findBrowser, NoBrowserError } from './pdf.service';

export interface ImagePdfPaging {
  rootIsClone: boolean;
  rootW: number;
  rootH: number;
  breaks: number[];
}

export interface ImagePdfResult {
  buffer: Buffer;
  pages: number;
  live: { w: number; h: number };
  paging: ImagePdfPaging | null;
  /** v1 弹层文案，如「共 3 页」 */
  pagesLabel: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 等下载文件出现且体积连续两次一致，避免读到写了一半的 PDF。 */
async function waitForDownload(dir: string, timeoutMs: number): Promise<string | null> {
  const t0 = Date.now();
  let lastFile = '';
  let lastSize = -1;
  while (Date.now() - t0 < timeoutMs) {
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf'))
      : [];
    if (files.length) {
      const file = path.join(dir, files[0]);
      let size = 0;
      try { size = fs.statSync(file).size; } catch { size = 0; }
      if (size > 1000 && file === lastFile && size === lastSize) return file;
      lastFile = file;
      lastSize = size;
    }
    await sleep(250);
  }
  return null;
}

/** Chrome --remote-debugging-port=0 会把实际端口写进 user-data-dir/DevToolsActivePort。 */
async function readDevToolsPort(profileDir: string, timeoutMs: number): Promise<number | null> {
  const file = path.join(profileDir, 'DevToolsActivePort');
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const first = fs.readFileSync(file, 'utf8').split('\n')[0].trim();
      const port = Number(first);
      if (port > 0) return port;
    } catch { /* 文件还没写出来 */ }
    await sleep(200);
  }
  return null;
}

@Injectable()
export class ImagePdfService {
  get available(): boolean {
    return findBrowser() !== null;
  }

  /** 供测试直接构造导出页，不启动浏览器。 */
  buildHtml(payload: any): string {
    return buildImagePdfHtml(payload).html;
  }

  async render(payload: any): Promise<ImagePdfResult> {
    const browser = findBrowser();
    if (!browser) throw new NoBrowserError();

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-studio-imgpdf-'));
    const htmlPath = path.join(tmp, 'export.html');
    const downloadDir = path.join(tmp, 'downloads');
    const profileDir = path.join(tmp, 'chrome-profile');
    fs.mkdirSync(downloadDir, { recursive: true });
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(htmlPath, buildImagePdfHtml(payload).html, 'utf8');

    const child: ChildProcess = spawn(browser, [
      '--headless=new', '--no-sandbox', '--disable-gpu',
      '--no-first-run', '--no-default-browser-check',
      '--allow-file-access-from-files', '--disable-dev-shm-usage',
      '--remote-debugging-port=0',
      '--user-data-dir=' + profileDir,
      'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    // 必须消费 stderr，否则管道写满后 Chrome 会卡住
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});

    let ws: WebSocket | null = null;
    try {
      const port = await readDevToolsPort(profileDir, 15_000);
      if (!port) throw new Error('Chrome 调试端口未就绪');

      // 127.0.0.1 直连，不受系统代理影响
      let targets: any[] | null = null;
      for (let i = 0; i < 40 && !targets; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/json/list`);
          if (r.ok) targets = (await r.json()) as any[];
        } catch { /* 还没监听 */ }
        if (!targets) await sleep(250);
      }
      const page = targets?.find((t) => t.type === 'page');
      if (!page?.webSocketDebuggerUrl) throw new Error('Chrome 未暴露可用的页面调试会话');

      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise<void>((resolve, reject) => {
        ws!.onopen = () => resolve();
        ws!.onerror = () => reject(new Error('CDP WebSocket 连接失败'));
      });

      let msgId = 0;
      const pending = new Map<number, (m: any) => void>();
      ws.onmessage = (ev: MessageEvent) => {
        const m = JSON.parse(String(ev.data));
        if (m.id && pending.has(m.id)) {
          pending.get(m.id)!(m);
          pending.delete(m.id);
        }
      };
      const send = (method: string, params: Record<string, unknown> = {}) =>
        new Promise<any>((resolve) => {
          const n = ++msgId;
          pending.set(n, resolve);
          ws!.send(JSON.stringify({ id: n, method, params }));
        });
      /** 大对象绝不回传；轮询表达式必须只返回轻量值，否则 CDP 会超时。 */
      const evalJs = async (expr: string, timeoutMs = 5000): Promise<any> => {
        const r = await Promise.race([
          send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
          sleep(timeoutMs).then(() => null),
        ]);
        return r ? r.result?.result?.value : '__TIMEOUT__';
      };

      await send('Runtime.enable');
      await send('Page.enable');
      const dl = await send('Browser.setDownloadBehavior', {
        behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true,
      });
      if (dl?.error) {
        const fallback = await send('Page.setDownloadBehavior', {
          behavior: 'allow', downloadPath: downloadDir,
        });
        if (fallback?.error) throw new Error('Chrome 不允许设置下载目录：' + fallback.error.message);
      }
      await send('Page.navigate', { url: 'file://' + htmlPath.replace(/\\/g, '/') });

      let status = 'pending';
      const t0 = Date.now();
      while (Date.now() - t0 < 120_000) {
        await sleep(500);
        status = await evalJs('(window.__RESULT__||{}).status || "pending"');
        if (status === 'downloaded' || status === 'error') break;
      }
      if (status === 'error') {
        const err = await evalJs('(window.__RESULT__||{}).error || "未知错误"');
        throw new Error('图片版 PDF 生成失败：' + String(err).slice(0, 400));
      }
      if (status !== 'downloaded') {
        throw new Error('图片版 PDF 生成超时（120s），可改用矢量 PDF 或打印 / 另存为 PDF');
      }

      const info = await evalJs(
        '({pages:(window.__RESULT__||{}).pages||"",live:(window.__RESULT__||{}).live||null,paging:(window.__RESULT__||{}).paging||null})',
        10_000
      );
      const file = await waitForDownload(downloadDir, 60_000);
      if (!file) throw new Error('Chrome 未产出可下载的图片版 PDF');
      const buffer = fs.readFileSync(file);
      if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
        throw new Error('图片版导出产物不是合法 PDF');
      }
      const breaks = Array.isArray(info?.paging?.breaks) ? info.paging.breaks : [];
      return {
        buffer,
        pages: breaks.length > 1 ? breaks.length - 1 : Number(String(info?.pages || '').match(/\d+/)?.[0] || 1),
        live: info?.live || { w: 0, h: 0 },
        paging: info?.paging || null,
        pagesLabel: String(info?.pages || ''),
      };
    } finally {
      try { ws?.close(); } catch { /* ignore */ }
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      // 只删本次 mkdtemp 建的目录，绝不碰用户目录
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
    }
  }
}
