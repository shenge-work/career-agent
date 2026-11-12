/* =============================================================
 * 服务端「渲染引擎孤岛」—— 复用 v1 真实渲染管线，一行不改
 * -------------------------------------------------------------
 * 为什么放服务端 vm 沙箱，而不是在 React 里挂 v1 引擎：
 *   · renderResumeInner / computePageBreaks / makeCaptureClone 是几十轮迭代
 *     调出来的资产，改成受控组件会让 PDF 分页契约全部作废；
 *   · React 与命令式 DOM 抢同一个节点是最容易出诡异 bug 的组合；
 *   · 隔离成「输入 payload → 输出独立 A4 HTML」纯函数后，预览 iframe 与
 *     PDF 打印共用同一份 HTML，两者永远一致，且天然可单测。
 *
 * 单一真相源：直接读仓库里 v1 的 js/ 与 css/ 源文件，不复制一份到 v2，
 * 避免两份渲染引擎各自演化。LEGACY_ROOT 可指向另一份检出。
 *
 * ⚠️ 每次渲染必须新建 vm context：v1 的 data / currentFonts 是脚本顶层
 * let 全局变量，复用 context 会让 A 用户的简历串进 B 用户的渲染结果。
 * ============================================================= */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/** 按 index.html 的加载顺序（tools/render-resume.js 已验证过的最小依赖闭包） */
export const LEGACY_MODULES = [
  'js/store/resume-store.js',
  'js/data.js',
  'js/render/editor-schema.js',
  'js/render/resume-render.js',
  'js/export/export-pdf.js',
  'js/feishu/feishu-sync.js',
  'js/ui/pane-mobile.js',
  'js/app.js',
] as const;

const CSS_FILE = 'css/style.css';

/** 图片版导出专用：v1 本地 vendor（离线可用，不让 headless 去公网拉库） */
export const VENDOR_FILES = [
  'vendor/html2canvas.min.js',
  'vendor/jspdf.umd.min.js',
] as const;

export interface StandaloneRender {
  /** 完整独立 A4 HTML（可直接 iframe 加载 / Ctrl+P / headless 打印） */
  html: string;
  /** 只含 .resume 的片段，便于测试比对 */
  resumeHtml: string;
  legacyRoot: string;
}

/** 找到 legacy 渲染资产根（v2/legacy，向上逐级探测；LEGACY_ROOT 可显式覆盖指向 legacy 目录） */
export function findLegacyRoot(explicit?: string): string {
  if (explicit) {
    const r = path.resolve(explicit);
    if (fs.existsSync(path.join(r, 'js/render/resume-render.js'))) return r;
    throw new Error(`LEGACY_ROOT 指向的目录缺少 js/render/resume-render.js：${r}`);
  }
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const cand = path.join(dir, 'legacy');
    if (fs.existsSync(path.join(cand, 'js/render/resume-render.js'))) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    '未找到渲染引擎资产（legacy/js/render/resume-render.js）。请设置 LEGACY_ROOT 指向项目内 legacy/ 目录。'
  );
}

/** 源码只读一次；渲染本身每次新建 context。 */
const sourceCache = new Map<string, { bundle: string; css: string }>();
/** 编译产物缓存：vm.Script 只编译一次，避免每次渲染重复 parse 8 个 v1 JS。 */
const scriptCache = new Map<string, vm.Script>();
export function loadSources(root: string): { bundle: string; css: string } {
  const hit = sourceCache.get(root);
  if (hit) return hit;
  const missing = LEGACY_MODULES.filter((m) => !fs.existsSync(path.join(root, m)));
  if (missing.length) throw new Error('v1 渲染引擎源码缺失: ' + missing.join(', '));
  const cssPath = path.join(root, CSS_FILE);
  if (!fs.existsSync(cssPath)) throw new Error('v1 样式缺失: ' + CSS_FILE);
  const loaded = {
    bundle: LEGACY_MODULES.map((m) => fs.readFileSync(path.join(root, m), 'utf8')).join('\n'),
    css: fs.readFileSync(cssPath, 'utf8'),
  };
  sourceCache.set(root, loaded);
  return loaded;
}

/** 编译 v1 bundle（缓存 Script，隔离只发生在每次新建的 context 上）。 */
function compiledBundle(root: string): vm.Script {
  const hit = scriptCache.get(root);
  if (hit) return hit;
  const { bundle } = loadSources(root);
  const script = new vm.Script(bundle, { filename: 'resume-legacy-bundle.js' });
  scriptCache.set(root, script);
  return script;
}

/** vendor 单独缓存、单独校验：预览渲染不依赖它们，缺文件不该让 preview 500。 */
const vendorCache = new Map<string, string[]>();
export function loadVendor(root: string): string[] {
  const hit = vendorCache.get(root);
  if (hit) return hit;
  const missing = VENDOR_FILES.filter((m) => !fs.existsSync(path.join(root, m)));
  if (missing.length) throw new Error('v1 导出依赖缺失: ' + missing.join(', '));
  const scripts = VENDOR_FILES.map((m) => fs.readFileSync(path.join(root, m), 'utf8'));
  vendorCache.set(root, scripts);
  return scripts;
}

/* ---------- 极简 DOM 桩（同 tools/render-resume.js，零第三方依赖） ---------- */
function makeEl(): any {
  return {
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    checked: false,
    style: { cssText: '', setProperty() {} },
    dataset: {},
    files: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    removeChild() {},
    remove() {},
    click() {},
    focus() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
    offsetWidth: 0,
    offsetHeight: 0,
    getContext() { return { drawImage() {} }; },
    toDataURL() { return ''; },
  };
}

function makeContext(): any {
  const store = new Map<string, string>();
  const els: Record<string, any> = {};
  const ctx: any = {
    console,
    JSON,
    Date,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    isNaN,
    parseInt,
    parseFloat,
    RegExp,
    Error,
    Promise,
    // 定时器只提供成套 no-op：v1 的数据写回防抖会调 clearTimeout（缺了会抛错），
    // 但服务端静态渲染不需要真的调度 —— 真定时器会在 context 销毁后访问浏览器对象。
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    queueMicrotask: (fn: () => void) => Promise.resolve().then(fn),
    localStorage: {
      getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
      setItem(k: string, v: string) { store.set(k, String(v)); },
      removeItem(k: string) { store.delete(k); },
    },
    location: { reload() {} },
    URL: { createObjectURL() { return ''; }, revokeObjectURL() {} },
    Blob: function () {},
    FileReader: function () {},
    html2canvas: undefined,
    addEventListener() {},
    removeEventListener() {},
    alert: () => {},
    confirm: () => true,
    matchMedia: () => ({ matches: false, addListener() {}, removeListener() {} }),
    document: {
      title: '',
      body: makeEl(),
      fonts: { ready: Promise.resolve() },
      getElementById(id: string) { return els[id] || (els[id] = makeEl()); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
      createElement() { return makeEl(); },
      createDocumentFragment() { return makeEl(); },
    },
    __els: els,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return ctx;
}

/** HTML 转义：payload 来自请求体，name 进 <title> 前必须转义。 */
export function escapeHtml(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** null / '' 必须显式回退：Number(null) === 0 会把「没设边距」变成 0mm。 */
export function mmNum(v: unknown, d: number): number {
  if (v === null || v === undefined || v === '') return d;
  const n = Number(v);
  return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : d;
}

/** 打印页边距跟随 payload.data.pageMargins，与 index.html 动态维护的 @page 同源。 */
export function buildPageMarginRule(payload: any): string {
  const pm = (payload?.data && payload.data.pageMargins) || {};
  return (
    '@media print{@page{size:A4;margin:' +
    mmNum(pm.top, 14) + 'mm ' + mmNum(pm.right, 14) + 'mm ' +
    mmNum(pm.bottom, 14) + 'mm ' + mmNum(pm.left, 14) + 'mm;}}'
  );
}

/** 把 .resume 片段包成独立 A4 HTML（CSS 内联，无外部资源，可直接打印）。 */
export function buildStandaloneHtml(resumeHtml: string, payload: any): string {
  const root = findLegacyRoot(process.env.LEGACY_ROOT);
  const { css } = loadSources(root);
  const title = escapeHtml(payload?.data?.name || '简历') + ' · 简历';
  const override = `
  ${buildPageMarginRule(payload)}
  html,body{height:auto;overflow:visible;background:#e9e9e9;}
  @media print{ html{background:#fff;} }
  body{padding:22px 0;font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Source Han Sans SC",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1a1a1a;}
  .resume{margin:0 auto;}
  @media print{ body{background:#fff;padding:0;} .resume{box-shadow:none;} }
`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<!-- payload 不可信：显式禁止任何脚本执行，即便未来有人漏了转义也不会变成 XSS -->
<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>${title}</title>
<style>
${css}
${override}
</style>
</head>
<body>
${resumeHtml}
</body>
</html>
`;
}

/**
 * 走 v1 真实「导入 → 迁移 → 渲染」管线，产出独立 A4 HTML。
 * 输入必须是 v1 的完整 payload（data / fonts / spacing / v / savedAt）。
 */
export function renderResume(payload: any, explicitRoot?: string): StandaloneRender {
  if (!payload || !payload.data || !Array.isArray(payload.data.sections)) {
    throw new Error('JSON 缺少 data.sections，无法渲染');
  }
  const root = findLegacyRoot(explicitRoot || process.env.LEGACY_ROOT);
  compiledBundle(root);

  // 每次新建 context：v1 的顶层 let data 是全局态，复用会跨用户串数据。
  const ctx = makeContext();
  vm.createContext(ctx);
  compiledBundle(root).runInContext(ctx, { timeout: 10_000 });

  if (!ctx.ResumeEditor || typeof ctx.ResumeEditor.applyImported !== 'function') {
    throw new Error('未能从 v1 app.js 暴露 ResumeEditor.applyImported（渲染管线封装异常）');
  }
  ctx.ResumeEditor.applyImported(payload);

  let resumeHtml: string = (ctx.__els['preview'] && ctx.__els['preview'].innerHTML) || '';
  if (!/class="resume"/.test(resumeHtml)) {
    // 兜底：直接调 renderResumeInner 拼 .resume 外壳（与 v1 脚本一致）
    const varStr = Object.keys(payload.fonts || {})
      .map((k) => '--font-' + escapeHtml(k) + ':' + (payload.fonts[k]?.val ?? 0) + 'px')
      .join(';') + ';';
    resumeHtml = '<div class="resume" style="' + varStr + '">' + ctx.ResumeEditor.renderResumeInner() + '</div>';
  }
  if (!resumeHtml || resumeHtml.length < 50) throw new Error('渲染输出为空，v1 渲染管线可能异常');

  return { html: buildStandaloneHtml(resumeHtml, payload), resumeHtml, legacyRoot: root };
}
