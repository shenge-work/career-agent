/* =============================================================
 * headless Chrome 静默打印 PDF —— 移植自 v1 tools/serve.js 的成熟链路
 * -------------------------------------------------------------
 * 输出「文字可选中」的矢量 PDF：浏览器原生 CSS 分页 + @page 页边距，
 * 与 preview 用的是同一份 HTML，版面天然一致。
 *
 * ⚠️ 与 v1 图片版导出（html2canvas + jsPDF + computePageBreaks 吸附）的区别：
 * 那条链路依赖实时预览 DOM 与 makeCaptureClone 三条铁律，属于 P4b 的范畴；
 * 本轮先交付矢量打印版，不假装已经把图片版分页契约搬过来。
 * ============================================================= */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Injectable } from '@nestjs/common';

export class NoBrowserError extends Error {
  readonly code = 'NO_BROWSER';
  constructor() {
    super('未找到 Chrome / Chromium / Edge，无法静默导出 PDF');
  }
}

/** 探测本机 Chromium 系浏览器；CHROME_PATH 可强制指定。 */
export function findBrowser(): string | null {
  const forced = process.env.CHROME_PATH;
  if (forced && fs.existsSync(forced)) return forced;
  const candidates: string[] = [];
  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
    );
  } else if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || '';
    candidates.push(
      path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe')
    );
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
      '/usr/bin/chromium-browser', '/snap/bin/chromium', '/opt/google/chrome/chrome');
  }
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* 无权限路径忽略 */ }
  }
  return null;
}

/** 等待产物写完：连续两次体积一致且非空即认为完成。 */
function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let last = -1;
    const tick = () => {
      let size = 0;
      try { size = fs.statSync(file).size; } catch { size = 0; }
      if (size > 1000 && size === last) return resolve(true);
      last = size;
      if (Date.now() - t0 > timeoutMs) return resolve(size > 1000);
      setTimeout(tick, 250);
    };
    setTimeout(tick, 400);
  });
}

@Injectable()
export class PdfService {
  /** 供测试判断是否需要跳过真实打印。 */
  get available(): boolean {
    return findBrowser() !== null;
  }

  /**
   * 打印 HTML → PDF 字节。
   * 部分 macOS 环境下 Chrome 打印完不会自行退出（stderr 反复刷 CVDisplayLink），
   * 因此不等进程 close，而是「轮询产物 + 主动 SIGKILL 收尾」。
   */
  async printHtml(html: string): Promise<Buffer> {
    const browser = findBrowser();
    if (!browser) throw new NoBrowserError();

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-studio-pdf-'));
    const htmlPath = path.join(tmp, 'resume.html');
    const pdfPath = path.join(tmp, 'resume.pdf');
    const userDir = path.join(tmp, 'chrome-profile');
    fs.writeFileSync(htmlPath, html, 'utf8');

    const baseArgs = [
      '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + userDir,
      '--no-pdf-header-footer',
      '--print-to-pdf-no-header',
      '--virtual-time-budget=8000',
      'file://' + htmlPath.replace(/\\/g, '/'),
    ];

    const runOnce = async (headlessFlag: string, waitMs: number): Promise<boolean> => {
      try { fs.rmSync(pdfPath, { force: true }); } catch { /* ignore */ }
      let child;
      try {
        child = spawn(browser, [headlessFlag, '--print-to-pdf=' + pdfPath].concat(baseArgs), {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        return false;
      }
      // 必须消费 stderr，否则管道写满后 Chrome 会卡住
      child.stdout?.on('data', () => {});
      child.stderr?.on('data', () => {});
      const ok = await waitForFile(pdfPath, waitMs);
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      return ok;
    };

    try {
      let produced = await runOnce('--headless=new', 45_000);
      if (!produced) produced = await runOnce('--headless', 45_000);
      if (!produced || !fs.existsSync(pdfPath)) {
        throw new Error('浏览器未在超时内产出 PDF，可改用「打印 / 另存为 PDF」');
      }
      const buf = fs.readFileSync(pdfPath);
      if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
        throw new Error('打印产物不是合法 PDF');
      }
      return buf;
    } finally {
      // 只删本次 mkdtemp 建的临时目录，绝不碰用户目录
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
    }
  }

  /**
   * 把一张固定宽度 HTML（如简报图片版）截成 PNG（§10.3）。
   * `--screenshot` 默认截视口全高；HTML 里 body 固定 width:720px 即出固定宽度长图。
   * 浏览器缺失时抛 NoBrowserError，由调用方诚实降级 501。
   */
  async screenshotHtml(html: string): Promise<Buffer> {
    const browser = findBrowser();
    if (!browser) throw new NoBrowserError();

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'career-agent-shot-'));
    const htmlPath = path.join(tmp, 'brief.html');
    const pngPath = path.join(tmp, 'brief.png');
    const userDir = path.join(tmp, 'chrome-profile');
    fs.writeFileSync(htmlPath, html, 'utf8');

    const runOnce = async (headlessFlag: string, waitMs: number): Promise<boolean> => {
      try { fs.rmSync(pngPath, { force: true }); } catch { /* ignore */ }
      let child;
      try {
        child = spawn(
          browser,
          [
            headlessFlag,
            '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
            '--user-data-dir=' + userDir,
            '--hide-scrollbars',
            '--force-device-scale-factor=2',
            '--virtual-time-budget=8000',
            '--window-size=720,1200',
            '--screenshot=' + pngPath,
            'file://' + htmlPath.replace(/\\/g, '/'),
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] }
        );
      } catch {
        return false;
      }
      child.stdout?.on('data', () => {});
      child.stderr?.on('data', () => {});
      const ok = await waitForFile(pngPath, waitMs);
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      return ok;
    };

    try {
      let produced = await runOnce('--headless=new', 45_000);
      if (!produced) produced = await runOnce('--headless', 45_000);
      if (!produced || !fs.existsSync(pngPath)) {
        throw new Error('浏览器未在超时内产出图片，请重试');
      }
      const buf = fs.readFileSync(pngPath);
      if (buf.subarray(1, 4).toString('latin1') !== 'PNG') {
        throw new Error('截图产物不是合法 PNG');
      }
      return buf;
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}
