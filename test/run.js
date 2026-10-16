#!/usr/bin/env node
'use strict';
/* 简历编辑器核心逻辑测试运行器。
   在隔离 vm 上下文里加载 js/data.js + js/app.js（二者为全局脚本、无模块导出），
   用 DOM/浏览器桩替代浏览器 API，再执行 test/cases.js 中的断言。纯 Node、零依赖。

   注意：js/app.js 已被 IIFE 封装，仅 window.ResumeEditor 暴露到全局。
   因此本运行器先加载 data+app，把 ResumeEditor 上的内部符号桥接到 vm 全局，
   再运行 cases（cases 以裸函数名调用，等价于浏览器中通过 window.ResumeEditor 调用）。 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

/* ---------- 极简 DOM / 浏览器 桩 ---------- */
function makeEl() {
  const el = {
    innerHTML: '', textContent: '', value: '', disabled: false, checked: false,
    style: {}, dataset: {},
    files: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, removeChild() {}, remove() {}, click() {}, focus() {},
    querySelectorAll() { return []; }, querySelector() { return null; }, closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
    offsetWidth: 0, offsetHeight: 0,
    getContext() { return { drawImage() {} }; }, toDataURL() { return ''; },
  };
  return el;
}

const store = new Map();
const alertCalls = [];
let printCalls = 0;
const ctx = {
  console, JSON, Date, Math, Object, Array, String, Number, Boolean,
  isNaN, parseInt, parseFloat, RegExp, Error, Promise, setTimeout, clearTimeout, process,
  // 浏览器 API 桩
  localStorage: {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
  },
  location: { reload() {} },
  URL: { createObjectURL() { return ''; }, revokeObjectURL() {} },
  Blob: function () {},
  FileReader: function () {},
  html2canvas: undefined,
  addEventListener() {},
  removeEventListener() {},
  alert: (m) => { alertCalls.push(m); },
  confirmReturn: true,
  confirm: () => ctx.confirmReturn,
  alertCalls: alertCalls,
  // 静默 PDF 的降级目标：调用次数用于断言「无 fetch 时确实回退了打印」
  print: () => { printCalls++; },
  document: {
    title: '',
    body: makeEl(),
    fonts: { ready: Promise.resolve() },
    getElementById() { return makeEl(); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement() { return makeEl(); },
    createDocumentFragment() { return makeEl(); },
  },
  // 断言上报通道
  __results: [],
  __ok(name, cond) { ctx.__results.push({ name, pass: !!cond }); },
};
ctx.window = ctx; // 自引用，模拟全局

/* ---------- 内存版 indexedDB 桩（供 ResumeLibrary 测试用） ----------
   只实现 resume-library.js 用到的能力：open / objectStore(get|put|delete)、单 store、单库。 */
function makeIDB() {
  const dbStore = new Map(); // key -> value
  function makeRequest(ok, result, err) {
    const r = { result, error: err, onsuccess: null, onerror: null };
    setTimeout(() => { if (ok && r.onsuccess) r.onsuccess(); else if (!ok && r.onerror) r.onerror(); }, 0);
    return r;
  }
  function makeStore() {
    return {
      get(key) { return makeRequest(true, dbStore.has(key) ? dbStore.get(key) : undefined); },
      put(val, key) { dbStore.set(key, val); return makeRequest(true); },
      delete(key) { dbStore.delete(key); return makeRequest(true); },
    };
  }
  function makeTx() {
    return { objectStore() { return makeStore(); } };
  }
  function makeDB() {
    return {
      objectStoreNames: { contains() { return true; } },
      transaction() { return makeTx(); },
      close() {},
      createObjectStore() { return {}; },
    };
  }
  return {
    open(name, version) {
      const req = { result: makeDB(), onupgradeneeded: null, onsuccess: null, onerror: null };
      setTimeout(() => { if (req.onupgradeneeded) req.onupgradeneeded(); if (req.onsuccess) req.onsuccess(); }, 0);
      return req;
    },
  };
}
ctx.indexedDB = makeIDB();

/* ---------- 加载源码 ---------- */
const dataCode = fs.readFileSync(path.join(ROOT, 'js', 'data.js'), 'utf8');
const themeTmplCode = fs.readFileSync(path.join(ROOT, 'js', 'theme-templates.js'), 'utf8');
/* N3 分享与权限控制：纯逻辑模块，app.js 的 shareApi() 依赖它挂在 window.ResumeShare */
const libraryShareCode = fs.existsSync(path.join(ROOT, 'js', 'store', 'library-share.js'))
  ? fs.readFileSync(path.join(ROOT, 'js', 'store', 'library-share.js'), 'utf8') : '';
const appCode = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
/* 内容编辑区 schema：必须在 resume-render.js 之前加载（后者从这里取基础件） */
const editorSchemaCode = fs.readFileSync(path.join(ROOT, 'js', 'render', 'editor-schema.js'), 'utf8');
/* N9 个人官网：portfolio-view.js 提供板块 HTML 渲染（导出产物复用它，保证预览与导出一致），
   portfolio-html.js 提供脱敏 + 单文件官网 HTML 拼接。两者都必须进主 bundle，
   否则 app.js 的 exportPortfolioSite() 与「两处板块渲染一致性」断言都测不到。 */
const portfolioViewCode = fs.readFileSync(path.join(ROOT, 'js', 'views', 'portfolio-view.js'), 'utf8');
const portfolioHtmlCode = fs.existsSync(path.join(ROOT, 'js', 'render', 'portfolio-html.js'))
  ? fs.readFileSync(path.join(ROOT, 'js', 'render', 'portfolio-html.js'), 'utf8') : '';
const storeCode = fs.readFileSync(path.join(ROOT, 'js', 'store', 'resume-store.js'), 'utf8');
const renderCode = fs.readFileSync(path.join(ROOT, 'js', 'render', 'resume-render.js'), 'utf8');
const exportPdfCode = fs.existsSync(path.join(ROOT, 'js', 'export', 'export-pdf.js'))
  ? fs.readFileSync(path.join(ROOT, 'js', 'export', 'export-pdf.js'), 'utf8') : '';
const feishuSyncCode = fs.existsSync(path.join(ROOT, 'js', 'feishu', 'feishu-sync.js'))
  ? fs.readFileSync(path.join(ROOT, 'js', 'feishu', 'feishu-sync.js'), 'utf8') : '';
const caseCode = fs.readFileSync(path.join(ROOT, 'test', 'cases.js'), 'utf8');
const paneMobileCode = fs.existsSync(path.join(ROOT, 'js', 'ui', 'pane-mobile.js'))
  ? fs.readFileSync(path.join(ROOT, 'js', 'ui', 'pane-mobile.js'), 'utf8') : '';

const cssCode = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
const htmlCode = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const settingsViewCode = fs.readFileSync(path.join(ROOT, 'js', 'views', 'settings-view.js'), 'utf8');
const historyViewCode = fs.readFileSync(path.join(ROOT, 'js', 'views', 'history-view.js'), 'utf8');
const nativeBridgeCode = fs.readFileSync(path.join(ROOT, 'js', 'store', 'native-bridge.js'), 'utf8');
const layoutCssCode = fs.readFileSync(path.join(ROOT, 'css', 'layout.css'), 'utf8');
const serveCode = fs.readFileSync(path.join(ROOT, 'tools', 'serve.js'), 'utf8');
const feishuSyncToolCode = fs.readFileSync(path.join(ROOT, 'tools', 'feishu-sync.js'), 'utf8');
const menuActionsCode = fs.readFileSync(path.join(ROOT, 'js', 'ui', 'menu-actions.js'), 'utf8');

vm.createContext(ctx);

/* 文件级结果收集 */
const fileResults = [];
const F = (name, cond) => fileResults.push({ name, pass: !!cond });

/* ---------- 第一步：加载 data + resume-store + app（app 依赖前两者，仅挂 window.ResumeEditor）----------
   注意：resume-store.js 是零依赖 IIFE，挂 window.ResumeStore；app.js 的 pushRepo 会引用它，
   测试里必须按真实 index.html 的加载顺序先加载 store，否则防抖保存的 setTimeout 触发时会 ReferenceError。 */
try {
  vm.runInContext(dataCode + '\n' + themeTmplCode + '\n' + libraryShareCode + '\n' + portfolioViewCode + '\n' + editorSchemaCode + '\n' + renderCode + '\n' + portfolioHtmlCode + '\n' + exportPdfCode + '\n' + feishuSyncCode + '\n' + paneMobileCode + '\n' + storeCode + '\n' + appCode, ctx, { filename: 'resume-bundle.js' });
} catch (e) {
  fileResults.push({ name: '加载期异常: ' + (e && e.message ? e.message : e), pass: false });
}

/* ---------- 统一入口清单（js/ui/menu-actions.js）----------
   桌面工具菜单与手机 sync-pane 的按钮都由这份清单渲染，index.html 里已不再手写按钮。
   因此「某个入口是否存在」必须问**渲染结果**，不能再拿 index.html 做正则 ——
   那正是「只匹配文本、从不运行」的老毛病（serve.js 的 P0 就是那么漏掉的）。
   这里提前加载，供下方所有入口类断言使用。 */
let menuDesktop = '';
let menuMobile = '';
try {
  vm.runInContext(menuActionsCode, ctx, { filename: 'menu-actions.js' });
  menuDesktop = ctx.ResumeMenu.htmlFor('desktop');
  menuMobile = ctx.ResumeMenu.htmlFor('mobile');
} catch (e) {
  fileResults.push({ name: '加载期异常（js/ui/menu-actions.js）: ' + (e && e.message ? e.message : e), pass: false });
}

/* ---------- 封装回归断言（必须在桥接前检查“未泄漏”）---------- */
F('封装生效：内部函数未泄漏到全局（blankSection）', typeof ctx.blankSection === 'undefined');
F('封装生效：仅 window.ResumeEditor 暴露 API', !!(ctx.ResumeEditor && typeof ctx.ResumeEditor.blankSection === 'function'));
F('封装生效：HTML 入口函数已暴露（toggleGuides）', !!(ctx.ResumeEditor && typeof ctx.ResumeEditor.toggleGuides === 'function'));

/* ---------- 桥接：把 ResumeEditor 上的内部符号映射到 vm 全局，供 cases 裸名调用 ---------- */
if (ctx.ResumeEditor) Object.assign(ctx, ctx.ResumeEditor);

/* ---------- 第二步：运行用例 ---------- */
try {
  vm.runInContext(caseCode, ctx, { filename: 'cases.js' });
} catch (e) {
  fileResults.push({ name: '运行期异常: ' + (e && e.message ? e.message : e), pass: false });
}

/* ---------- 第三步：js/store/resume-library.js 的多简历仓库用例 ----------
   与 audit 同构：CommonJS 由 Node 侧 require，断言走 ctx.assert。
   ResumeLibrary 依赖 indexedDB，上面已注入内存桩。 */
try {
  const libCode = fs.readFileSync(path.join(ROOT, 'js', 'store', 'resume-library.js'), 'utf8');
  vm.runInContext(libCode, ctx, { filename: 'resume-library.js' });
} catch (e) {
  fileResults.push({ name: '加载期异常（js/store/resume-library.js）: ' + (e && e.message ? e.message : e), pass: false });
}

const libCases = require(path.join(ROOT, 'test', 'cases-library.js'));
const libCtx = {
  ResumeLibrary: ctx.ResumeLibrary,
  pickResumeSource: (ctx.ResumeEditor && ctx.ResumeEditor.pickResumeSource) || null,
  assert(cond, msg) { fileResults.push({ name: 'library › ' + msg, pass: !!cond }); },
};
let libChain = Promise.resolve();
for (const c of libCases) {
  libChain = libChain.then(() => c.fn(libCtx))
    .catch((e) => { fileResults.push({ name: 'library › ' + c.name + '（抛错: ' + (e && e.message ? e.message : e) + '）', pass: false }); });
}

/* ---------- N11 本地版本历史：加载 local-history.js 到 vm ctx（复用已加载的 ResumeLibrary 内存后端） ----------
   纯函数（applyRetention / genVersionId / estimateBytes）由 cases 内部 require 模块导出直接测；
   完整链路（append→list→restore→隔离→removeAll）走 vm ctx 里的 ResumeLocalHistory。 */
try {
  const lhCode = fs.readFileSync(path.join(ROOT, 'js', 'store', 'local-history.js'), 'utf8');
  vm.runInContext(lhCode, ctx, { filename: 'local-history.js' });
} catch (e) {
  fileResults.push({ name: '加载期异常（js/store/local-history.js）: ' + (e && e.message ? e.message : e), pass: false });
}

const lhCases = require(path.join(ROOT, 'test', 'cases-local-history.js'));
const lhCtx = {
  ResumeLocalHistory: ctx.ResumeLocalHistory,
  ResumeLibrary: ctx.ResumeLibrary,
  ResumeEditor: ctx.ResumeEditor,
  assert(cond, msg) { fileResults.push({ name: 'local-history › ' + msg, pass: !!cond }); },
};
let lhChain = Promise.resolve();
for (const c of lhCases) {
  lhChain = lhChain.then(() => c.fn(lhCtx))
    .catch((e) => { fileResults.push({ name: 'local-history › ' + c.name + '（抛错: ' + (e && e.message ? e.message : e) + '）', pass: false }); });
}

/* ---------- 第四步：js/store/datasource.js 的注册表用例（M4）----------
   在 vm 上下文加载（和浏览器同路径），每个用例前 _reset 保证隔离。 */
try {
  const dsCode = fs.readFileSync(path.join(ROOT, 'js', 'store', 'datasource.js'), 'utf8');
  vm.runInContext(dsCode, ctx, { filename: 'datasource.js' });
} catch (e) {
  fileResults.push({ name: '加载期异常（js/store/datasource.js）: ' + (e && e.message ? e.message : e), pass: false });
}

const dsCases = require(path.join(ROOT, 'test', 'cases-datasource.js'));
const dsCtx = {
  Registry: ctx.ResumeDataSourceRegistry,
  assert(cond, msg) { fileResults.push({ name: 'datasource › ' + msg, pass: !!cond }); },
};
for (const c of dsCases) {
  if (ctx.ResumeDataSourceRegistry) ctx.ResumeDataSourceRegistry._reset();
  try { c.fn(dsCtx); }
  catch (e) { fileResults.push({ name: 'datasource › ' + c.name + '（抛错: ' + (e && e.message ? e.message : e) + '）', pass: false }); }
}
if (ctx.ResumeDataSourceRegistry) ctx.ResumeDataSourceRegistry._reset();

/* ---------- 第四步：tools/feishu-sync.js 的一键绑定默认项用例（M3）----------
   feishu-sync.js 是纯 Node CommonJS 模块（module.exports），可直接 require；
   buildProbeDefaults 是纯函数（不触发网络），其余函数惰性依赖 https/fs，require 时安全。 */
const feishuSync = require(path.join(ROOT, 'tools', 'feishu-sync.js'));
const feishuCases = require(path.join(ROOT, 'test', 'cases-feishu.js'));
const feishuCtx = {
  buildProbeDefaults: feishuSync.buildProbeDefaults,
  authStateKey: feishuSync.authStateKey,
  assert(cond, msg) { fileResults.push({ name: 'feishu › ' + msg, pass: !!cond }); },
};
for (const c of feishuCases) {
  try { c.fn(feishuCtx); }
  catch (e) { fileResults.push({ name: 'feishu › ' + c.name + '（抛错: ' + (e && e.message ? e.message : e) + '）', pass: false }); }
}

/* ---------- PDF 解析：extractName/extractContact/buildResumeData 纯函数用例 ----------
   pdf-parse.js 是纯 Node CommonJS 模块；其纯函数不触发 pdf.js 加载，require 时安全。
   （parsePdfToResume/extractText 才需要 vendor/pdf.min.js，这里只测纯函数。） */
const pdfParse = require(path.join(ROOT, 'tools', 'pdf-parse.js'));
const pdfCases = require(path.join(ROOT, 'test', 'cases-pdfparse.js'));
const pdfCtx = {
  extractName: pdfParse.extractName,
  extractContact: pdfParse.extractContact,
  buildResumeData: pdfParse.buildResumeData,
  extractCareer: pdfParse.extractCareer,
  extractEducation: pdfParse.extractEducation,
  extractSkills: pdfParse.extractSkills,
  extractDateRange: pdfParse.extractDateRange,
  classifySectionLine: pdfParse.classifySectionLine,
  assert(cond, msg) { fileResults.push({ name: 'pdfparse › ' + msg, pass: !!cond }); },
};
for (const c of pdfCases) {
  try { c.fn(pdfCtx); }
  catch (e) { fileResults.push({ name: 'pdfparse › ' + c.name + '（抛错: ' + (e && e.message ? e.message : e) + '）', pass: false }); }
}

/* ---------- JSON Resume 适配器：fromJsonResume/toJsonResume 纯函数用例 ----------
   jsonresume-adapter.js 是双环境模块（IIFE + CommonJS），require 时安全、不触发 DOM。 */
const jsonResumeAdapter = require(path.join(ROOT, 'js', 'io', 'jsonresume-adapter.js'));
const jsonResumeCases = require(path.join(ROOT, 'test', 'cases-jsonresume.js'));
const jsonResumeCtx = {
  fromJsonResume: jsonResumeAdapter.fromJsonResume,
  toJsonResume: jsonResumeAdapter.toJsonResume,
  assert(cond, msg) { fileResults.push({ name: 'jsonresume › ' + msg, pass: !!cond }); },
};
for (const c of jsonResumeCases) {
  try { c.fn(jsonResumeCtx); }
  catch (e) { fileResults.push({ name: 'jsonresume › ' + c.name + '（抛错: ' + (e && e.message ? e.message : e) + '）', pass: false }); }
}

/* ---------- JD 派生版本：buildDerivedPayload 等纯函数用例 ----------
   jd-derive.js 是 IIFE + CommonJS 双环境模块，require 时安全、不触发 DOM。 */
const jdDerive = require(path.join(ROOT, 'js', 'jd-derive.js'));
const jdDeriveCases = require(path.join(ROOT, 'test', 'cases-jd-derive.js'));
const jdDeriveCtx = {
  buildDerivedPayload: jdDerive.buildDerivedPayload,
  fillGroupFor: jdDerive.fillGroupFor,
  suggestSentence: jdDerive.suggestSentence,
  deriveTitle: jdDerive.deriveTitle,
  assert(cond, msg) { fileResults.push({ name: 'jd-derive › ' + msg, pass: !!cond }); },
};
for (const c of jdDeriveCases) {
  try { c.fn(jdDeriveCtx); }
  catch (e) { fileResults.push({ name: 'jd-derive › ' + c.name + '（抛错: ' + (e && e.message ? e.message : e) + '）', pass: false }); }
}

/* ---------- 经历素材库：normalizeTags/matchSnippets/makeSnippet 纯函数用例 ----------
   snippet-library.js 是 IIFE + CommonJS 双环境模块，require 时安全（不触发 localStorage）。 */
const snippetLib = require(path.join(ROOT, 'js', 'store', 'snippet-library.js'));
const snippetCases = require(path.join(ROOT, 'test', 'cases-snippets.js'));
const snippetCtx = {
  normalizeTags: snippetLib.normalizeTags,
  matchSnippets: snippetLib.matchSnippets,
  makeSnippet: snippetLib.makeSnippet,
  assert(cond, msg) { fileResults.push({ name: 'snippets › ' + msg, pass: !!cond }); },
};
for (const c of snippetCases) {
  try { c.fn(snippetCtx); }
  catch (e) { fileResults.push({ name: 'snippets › ' + c.name + '（抛错: ' + (e && e.message ? e.message : e) + '）', pass: false }); }
}

/* ---------- 飞书扫码授权：buildAuthorizeUrl 纯函数用例 ----------
   feishu-oauth.js 是纯 Node CommonJS 模块；buildAuthorizeUrl 是纯函数（不触发网络）。
   测试里用临时 mock 覆盖 sync.config.json 读取，不依赖本机真实配置。 */
const feishuOauth = require(path.join(ROOT, 'tools', 'feishu-oauth.js'));
const oauthCases = require(path.join(ROOT, 'test', 'cases-oauth.js'));
const OAUTH_CFG_PATH = path.join(ROOT, 'sync.config.json');
function withMockConfig(mock, fn) {
  const orig = fs.readFileSync;
  fs.readFileSync = function (p, ...args) {
    if (path.resolve(p) === OAUTH_CFG_PATH) return JSON.stringify(mock);
    return orig.apply(fs, [p, ...args]);
  };
  try { return fn(); }
  finally { fs.readFileSync = orig; }
}
const oauthCtx = {
  buildAuthorizeUrl: (opts) => withMockConfig({ app_id: 'cli_test123', app_secret: 'secret' }, () => feishuOauth.buildAuthorizeUrl(opts)),
  // 无 app_id 且无配置时的抛错场景（mock 空配置，不依赖本机 sync.config.json）
  buildAuthorizeUrlWithoutConfig: function () {
    return withMockConfig({}, () => feishuOauth.buildAuthorizeUrl({}));
  },
  assert(cond, msg) { fileResults.push({ name: 'oauth › ' + msg, pass: !!cond }); },
};
for (const c of oauthCases) {
  try { c.fn(oauthCtx); }
  catch (e) { fileResults.push({ name: 'oauth › ' + c.name + '（抛错: ' + (e && e.message ? e.message : e) + '）', pass: false }); }
}

/* ---------- 飞书「个人应用」扫码注册：纯函数用例（Device Flow）----------
   feishu-register.js 是纯 Node CommonJS 模块；encodeAddons / mapPollStatus 是纯函数（不触发网络）。 */
const feishuRegister = require(path.join(ROOT, 'tools', 'feishu-register.js'));
const registerCases = require(path.join(ROOT, 'test', 'cases-feishu-register.js'));
const registerCtx = {
  feishuRegister: feishuRegister,
  assert(cond, msg) { fileResults.push({ name: 'feishu-register › ' + msg, pass: !!cond }); },
};
for (const c of registerCases) {
  try { c.fn(registerCtx); }
  catch (e) { fileResults.push({ name: 'feishu-register › ' + c.name + '（抛错: ' + (e && e.message ? e.message : e) + '）', pass: false }); }
}

/* ---------- 第四步：js/audit.js 的内容体检用例 ----------
   注意：test/cases-audit.js 此前**从未被执行过**——本运行器原先硬编码只读 cases.js。
   它是 CommonJS（module.exports = [{name, fn}]），由 Node 侧 require 后逐条跑，
   断言走 ctx.assert(cond, msg)，与上面的 __ok 通道不同名，故在此单独适配。 */
try {
  const auditCode = fs.readFileSync(path.join(ROOT, 'js', 'audit.js'), 'utf8');
  vm.runInContext(auditCode, ctx, { filename: 'audit.js' });
} catch (e) {
  fileResults.push({ name: '加载期异常（js/audit.js）: ' + (e && e.message ? e.message : e), pass: false });
}

const auditCases = require(path.join(ROOT, 'test', 'cases-audit.js'));
const auditCtx = {
  ResumeAudit: ctx.ResumeAudit,
  assert(cond, msg) { fileResults.push({ name: 'audit › ' + msg, pass: !!cond }); },
};
for (const c of auditCases) {
  try { c.fn(auditCtx); }
  catch (e) { fileResults.push({ name: 'audit › ' + c.name + '（抛错: ' + (e && e.message ? e.message : e) + '）', pass: false }); }
}

/* ---------- 第四步：js/export-extra.js 的导出用例（DOCX / 纯文本 / Markdown）----------
   与 audit 同构：CommonJS 由 Node 侧 require，断言走 ctx.assert。
   注意 export-extra.js 内部通过 typeof window 取全局，vm 里 window 即 ctx。 */
try {
  const exportCode = fs.readFileSync(path.join(ROOT, 'js', 'export-extra.js'), 'utf8');
  vm.runInContext(exportCode, ctx, { filename: 'export-extra.js' });
} catch (e) {
  fileResults.push({ name: '加载期异常（js/export-extra.js）: ' + (e && e.message ? e.message : e), pass: false });
}

const exportCases = require(path.join(ROOT, 'test', 'cases-export.js'));
const exportCtx = {
  ResumeExport: ctx.ResumeExport,
  global: ctx,
  get printCalls() { return printCalls; },
  assert(cond, msg) { fileResults.push({ name: 'export › ' + msg, pass: !!cond }); },
};
for (const c of exportCases) {
  try { c.fn(exportCtx); }
  catch (e) { fileResults.push({ name: 'export › ' + c.name + '（抛错: ' + (e && e.message ? e.message : e) + '）', pass: false }); }
}

/* ---------- 文件级冒烟断言（打印样式 / 入口接线，不依赖浏览器）---------- */
F('打印样式存在 @media print', /@media\s+print/.test(cssCode));
F('打印时隐藏编辑区与侧边面板', /@media\s+print[\s\S]*?\.side-rail,\.side-panel[^;]*display\s*:\s*none/.test(cssCode));
/* 2026-09-22 改：打印侧不再用块级「整体不许断开」（break-inside:avoid / break-after:avoid）——
   图片版 PDF 是按「等分 + 切口吸附行间空白」切片的，表达不了块级避让，
   一旦打印侧开了它，Chrome 会把整块推到下一页，页数比图片版多一页（实测 4 vs 3）。
   现在的契约：打印侧把分页规则压平成「每页尽量填满、断点只落在行框顶端」，
   只保留数据里的强制换页。 */
F('打印侧不再使用块级 break-inside:avoid（两条导出路径分页必须一致）',
  !/break-inside\s*:\s*avoid/.test(cssCode));
F('打印侧把 break-inside / orphans / widows 压平为「尽量填满」',
  /\.resume\s*\*\{[^}]*break-inside\s*:\s*auto[^}]*orphans\s*:\s*1[^}]*widows\s*:\s*1/.test(cssCode));
F('打印侧保留数据里的强制换页 break-before:page', /\.page-break-before\{[^}]*break-before\s*:\s*page/.test(cssCode));
F('打印纸张为 A4', /@page\{[^}]*size\s*:\s*A4/.test(cssCode));
/* —— 两条导出路径的版面几何必须同源（2026-09-22 修）——
   历史 bug：分页/预览用 contentW*297/210 当内容区高度（比真实值少 11mm/页），
   图片版 PDF 因此每页少装一行半内容、且把内容纵向拉伸 4.5%，与矢量版对不上。 */
F('分页几何用真实 A4 内容区高度（297 - 上下边距）',
  /contentHmm\s*=\s*Math\.max\(1,\s*297\s*-\s*safeMm\(m\.top/.test(renderCode));
/* 负向断言只认「赋值语句」形态，避免命中讲解历史 bug 的注释文本 */
F('分页几何已弃用 contentW * 297/210 的错算式',
  !/(const|let|var)\s+\w+\s*=\s*[^;\n]*\*\s*297\s*\/\s*210/.test(renderCode));
F('导出侧按 getPageMetrics 同源换算 px→mm',
  /RB\.getPageMetrics\(cap\.clone\)/.test(exportPdfCode)
  && /const pageHpx\s*=\s*metrics\s*\?\s*metrics\.pageH/.test(exportPdfCode)
  && !/(const|let|var)\s+pageHpx\s*=\s*contentWpx\s*\*\s*297\s*\/\s*210/.test(exportPdfCode));
F('app.js 桥出 RB.getPageMetrics', /RB\.getPageMetrics\s*=\s*getPageMetrics/.test(appCode));
/* —— ↑↓ 排序按钮必须完全不参与布局流 ——
   历史 bug：它是 inline-flex 实体盒子，在 .job/.project 里各撑出一整行空白（本简历 8 处 = 153px），
   而 @media print 又把它 display:none —— 于是「预览 / 图片版」比「矢量版」高出 153px，分页必然错位。 */
F('↑↓ 按钮绝对定位（不占布局高度）', /\.resume \.reorder-btns\{position:absolute/.test(cssCode));
F('↑↓ 按钮锚定块已设 position:relative',
  /\.resume \.job,\.resume \.project,\.resume \.section-title,\.resume \.skill-group,\.resume \.adv-li\{position:relative;\}/.test(cssCode));
F('↑↓ 按钮不再用 margin-left:auto 留在标题行里', !/\.section-title \.reorder-btns\{margin-left:auto\}/.test(cssCode));
F('打印时仍显式隐藏 ↑↓ 按钮', /@media print\{ \.resume \.reorder-btns\{display:none !important;\} \}/.test(cssCode));
/* 入口类断言统一问「清单渲染出了什么」，不再问 index.html 里写了什么 */
F('工具菜单面板含 PDF 预览按钮', /ResumeEditor\.exportPDF\(\)/.test(menuDesktop));
F('工具菜单面板含导出图片版按钮', /ResumeEditor\.exportLongImage\(\)/.test(menuDesktop));
F('工具菜单面板含导出单文件 HTML 按钮', /ResumeEditor\.exportSingleFileHTML\(\)/.test(menuDesktop));
F('工具菜单面板含文件名输入框', /id="filenameBase"/.test(menuDesktop));
F('导出预览弹层存在（exportModal）', /id="exportModal"/.test(htmlCode));
F('导出预览弹层含下载按钮 closeExportModal', /ResumeEditor\.closeExportModal\(\)/.test(htmlCode));
F('图片版导出按钮标注为「导出（图片版）"', /导出（图片版）/.test(menuDesktop));
F('入口已接入 ResumeEditor 命名空间（toggleGuides）', /onclick="ResumeEditor\.toggleGuides\(\)"/.test(menuDesktop));
F('入口已接入 ResumeEditor 命名空间（exportPDF）', /onclick="ResumeEditor\.exportPDF\(\)"/.test(menuDesktop));

/* ---------- 文件级冒烟断言：T7 投递链路的接线（防「写了但没接」）----------
   源 index.html 常被外部编辑器注入 data-page-node-id，断言前先剥离，避免误判。 */
const htmlClean = htmlCode.replace(/\s+data-page-node-id="[^"]*"/g, '');
F('index.html 引入 js/export-extra.js', /<script src="js\/export-extra\.js"><\/script>/.test(htmlClean));
F('index.html 引入 js/audit.js', /<script src="js\/audit\.js"><\/script>/.test(htmlClean));
F('T7 模块排在 app.js 之后（依赖其暴露的 getData）',
  htmlClean.indexOf('js/app.js') < htmlClean.indexOf('js/export-extra.js') &&
  htmlClean.indexOf('js/app.js') < htmlClean.indexOf('js/audit.js'));
F('工具栏含投递体检入口', /ResumeAudit\.toggle\(\)/.test(menuDesktop));
F('导出菜单含 Word（.docx）', /ResumeExport\.exportDocx\(\)/.test(menuDesktop));
F('导出菜单含纯文本', /ResumeExport\.exportTxt\(\)/.test(menuDesktop));
F('导出菜单含 Markdown', /ResumeExport\.exportMarkdown\(\)/.test(menuDesktop));
F('导出菜单含静默 PDF', /ResumeExport\.exportPdfSilent\(\)/.test(menuDesktop));
F('体检面板容器存在（#auditBody）', /id="auditBody"/.test(htmlClean));
/* N9 个人官网导出：入口在「统一清单」里，因此两端同时生效（不该只在一端出现） */
F('工具菜单含导出个人官网入口（桌面 + 手机同源）',
  /ResumeEditor\.exportPortfolioSite\(\)/.test(menuDesktop) && /ResumeEditor\.exportPortfolioSite\(\)/.test(menuMobile));
F('app.js 暴露官网导出的整条链路（入口 / 生成 / 预览 / 下载 / 复制附言）',
  /exportPortfolioSite: exportPortfolioSite/.test(appCode) &&
  /runPortfolioExport: runPortfolioExport/.test(appCode) &&
  /previewPortfolio: previewPortfolio/.test(appCode) &&
  /downloadPortfolio: downloadPortfolio/.test(appCode) &&
  /copyPortfolioPitch: copyPortfolioPitch/.test(appCode));

/* ---------- 文件级冒烟断言：打印 / 静默导出的页边距跟随「页面边距」设置（7d）----------
   这三条是「防回归」：动态 @page 一旦被重构丢掉，打印就会悄悄退回硬编码的 14mm，
   而界面上完全看不出来，所以必须在测试里钉住。 */
const renderResumeCode = fs.readFileSync(path.join(ROOT, 'tools', 'render-resume.js'), 'utf8');
F('app.js 定义并调用 syncPrintPageMargin（浏览器打印路径）',
  /function syncPrintPageMargin\(\)/.test(appCode + renderCode) && /syncPrintPageMargin\(\);/.test(appCode + renderCode));

/* ---------- 右缘标签互斥（多选一）：浮动面板 ↔ 编辑面板，展开任一方即收起另一方 ---------- */
F('互斥：浮动面板展开时收起编辑面板（setSidePanelOpen→setPaneCollapsed(true)）',
  /if \(open\) \{[\s\S]{0,200}setPaneCollapsed\(true, persist\)/.test(appCode + paneMobileCode));
F('互斥：编辑面板展开时收起浮动面板（setPaneCollapsed→close .side-panel.open）',
  /if \(!collapsed\) \{[\s\S]{0,160}\.side-panel\.open[\s\S]{0,120}setSidePanelOpen\(p\.id, false, persist\)/.test(appCode + paneMobileCode));
/* ---------- 右缘面板与编辑面板同款推展（不是居中浮动小卡片）---------- */
F('工具菜单已移出 preview-pane、与编辑面板同级（.app 的 flex 兄弟列）',
  (() => {
    const iPrev = htmlClean.indexOf('class="preview-pane"');
    const iEdit = htmlClean.indexOf('class="editor-pane"');
    const iPanel = htmlClean.indexOf('id="toolsPanel"');
    return iPrev > -1 && iEdit > iPrev && iPanel > iEdit &&
      htmlClean.slice(iPrev, iEdit).indexOf('id="toolsPanel"') === -1;
  })());
F('右缘面板为 flex 推展列（width:0→460），不再 position:absolute 浮动',
  /\.side-panel\{[^}]*flex-shrink:0;width:0;[^}]*\}[\s\S]{0,140}\.side-panel\.open\{width:460px/.test(cssCode) &&
  !/\.side-panel\{[^}]*position:absolute/.test(cssCode));
F('右缘面板高度通栏（无 top:50% 居中定位残留）',
  !/\.side-panel\.open\{[^}]*translateY\(-50%\)/.test(cssCode) && !/\.side-panel\{[^}]*top:50%/.test(cssCode));
F('app.js 空值不被当成 0mm（null / undefined / 空串显式回退）',
  /v === null \|\| v === undefined \|\| v === ''/.test(appCode + renderCode));
F('render-resume.js 注入动态 @page（静默导出路径）', /pageMarginRule/.test(renderResumeCode));
F('css/style.css 保留 A4 默认 @page（无 JS 环境下的兜底）', /@page\{\s*size:A4/.test(cssCode));

/* ---------- 文件级冒烟断言：M1/M2 多简历接线（防「写了但没接」）---------- */
F('index.html 引入 js/store/resume-library.js', /<script src="js\/store\/resume-library\.js"><\/script>/.test(htmlClean));
F('resume-library.js 排在 app.js 之前（app 依赖其暴露的 ResumeLibrary）',
  htmlClean.indexOf('js/store/resume-library.js') < htmlClean.indexOf('js/app.js'));
/* N3：分享/权限纯逻辑模块必须被引入且排在 app.js 之前（app 的 shareApi() 直接读它） */
F('index.html 引入 js/store/library-share.js', /<script src="js\/store\/library-share\.js"><\/script>/.test(htmlClean));
F('library-share.js 排在 app.js 之前（app 依赖其暴露的 ResumeShare）',
  htmlClean.indexOf('js/store/library-share.js') < htmlClean.indexOf('<script src="js/app.js"></script>'));

/* ---------- 文件级冒烟断言：N9 个人官网导出的接线（防「写了但没接」）----------
   失效面：官网渲染模块没被引入 / 引入顺序错（app 或导出模块取不到它）、
   确认弹层被删（脱敏开关失效 → 悄悄把手机号写进公开网页）、
   单文件构建漏打包（双击打开的单文件版导出官网直接报错）。 */
F('index.html 引入 js/render/portfolio-html.js',
  /<script src="js\/render\/portfolio-html\.js"><\/script>/.test(htmlClean));
F('portfolio-html.js 排在 app.js 之前（app 的 exportPortfolioSite 直接读它）',
  htmlClean.indexOf('js/render/portfolio-html.js') < htmlClean.indexOf('<script src="js/app.js"></script>'));
F('官网渲染依赖的 portfolio-view.js 也在 app.js 之前',
  htmlClean.indexOf('js/views/portfolio-view.js') < htmlClean.indexOf('<script src="js/app.js"></script>'));
F('index.html 含官网导出确认弹层（#portfolioModal + 三步勾选 + 两步容器）',
  /id="portfolioModal"/.test(htmlClean) && /id="pfStepConfirm"/.test(htmlClean) && /id="pfStepDone"/.test(htmlClean) &&
  /id="pfHideSensitive"/.test(htmlClean) && /id="pfMaskEmail"/.test(htmlClean) && /id="pfEmbedFull"/.test(htmlClean));
F('脱敏开关默认勾选「隐藏敏感信息」（安全侧：默认不泄露）',
  /id="pfHideSensitive"\s+checked/.test(htmlClean));
F('官网弹层排在导出预览弹层之前（预览才能盖在它之上，关掉预览仍能看到部署指引）',
  htmlClean.indexOf('id="portfolioModal"') < htmlClean.indexOf('id="exportModal"'));
F('build-single.js 也内联 portfolio-html.js（单文件版可用）',
  /js\/render\/portfolio-html\.js/.test(fs.readFileSync(path.join(ROOT, 'tools', 'build-single.js'), 'utf8')));
F('css 含官网板块在 A4 视图下的降级样式（.kpi-band / .card-metrics / .evidence）',
  /\.resume \.kpi-band\{/.test(cssCode) && /\.resume \.card-metrics\{/.test(cssCode) && /\.resume \.evidence\{/.test(cssCode));
F('css 含官网导出弹层样式（.pf-opt / .pf-deploy / .pf-pitch）',
  /\.pf-opt\{/.test(cssCode) && /\.pf-deploy\{/.test(cssCode) && /\.pf-pitch\{/.test(cssCode));

F('index.html 含简历抽屉容器（#resumeDrawer）', /id="resumeDrawer"/.test(htmlClean));F('index.html 抽屉默认常驻（class 含 open）', /class="resume-drawer open"/.test(htmlClean));
F('index.html 含抽屉折叠/展开把手', /id="resumeDrawerCollapse"/.test(htmlClean) && /id="resumeDrawerExpand"/.test(htmlClean));
F('打印时隐藏简历抽屉与展开把手', /\.resume-drawer,\.resume-drawer-expand\{display\s*:\s*none/.test(cssCode));

/* ---------- 文件级冒烟断言：卡片操作收进「⋯」菜单（防平铺按钮回归）----------
   失效面：重命名 / 复制 / 删除一旦又被平铺在卡片上，鼠标扫过卡片就会误点（尤其删除），
   而界面上看不出「本该收在菜单里」，所以必须钉住。
   同时钉住「点 ⋯ 不冒泡」——这是本次改动的核心意图：点更多按钮不能顺带打开简历。 */
F('卡片含「⋯」更多操作入口', /class="resume-item-more"/.test(appCode));
F('「⋯」点击不冒泡（不会顺带打开/切换简历）',
  /event\.stopPropagation\(\);ResumeEditor\.toggleResumeItemMenu\(/.test(appCode));
F('「⋯」按键不冒泡（焦点在按钮上按回车不触发卡片打开）',
  /onkeydown="event\.stopPropagation\(\)"/.test(appCode));
F('操作菜单开关已定义',
  /function toggleResumeItemMenu\(/.test(appCode) && /function closeResumeItemMenu\(/.test(appCode));
F('操作菜单已暴露给 HTML 入口',
  /toggleResumeItemMenu: toggleResumeItemMenu/.test(appCode) &&
  /closeResumeItemMenu: closeResumeItemMenu/.test(appCode));
F('卡片上不再平铺操作按钮（resume-item-actions 已移除）',
  !/resume-item-actions/.test(appCode) && !/resume-item-actions/.test(cssCode));
F('操作菜单样式存在（.resume-item-menu.show 可见）',
  /\.resume-item-menu\.show\{display\s*:\s*flex/.test(cssCode));

/* ---------- 文件级冒烟断言：右缘重复的「简历」把手已移除 ----------
   失效面：railResumeTab 是抽屉收展的第二个入口，与抽屉自身的折叠按钮 / 左缘把手重复；
   删掉后必须保证抽屉自身的两个入口还在，否则抽屉再也收不起来（不可逆的可用性事故）。 */
F('右缘不再有重复的「简历」把手（railResumeTab / railResumeArrow 已移除）',
  !/railResumeTab/.test(htmlClean) && !/railResumeArrow/.test(appCode));
F('抽屉仍保留自身的收展入口',
  /class="resume-drawer-collapse"/.test(htmlClean) &&
  /resume-drawer-expand"/.test(htmlClean) &&
  /onclick="ResumeEditor\.toggleResumeDrawer\(\)"/.test(htmlClean));

/* ---------- 文件级冒烟断言：飞书「个人应用」扫码注册（Device Flow）----------
   失效面：把"手动填 app_id/app_secret"误改回旧形态，或扫码注册函数没接进 UI/路由。 */
F('index.html 引入 vendor/qrcode-generator.js（二维码渲染）',
  /<script src="vendor\/qrcode-generator\.js"><\/script>/.test(htmlClean));
F('build-single.js 也将 qrcode-generator.js 内联（单文件版可用）',
  /vendor\/qrcode-generator\.js/.test(fs.readFileSync(path.join(ROOT, 'tools', 'build-single.js'), 'utf8')));
F('飞书设置页含「连接飞书」合并入口（oauthStartBtn + revokeOauthBtn，注册/授权合一）',
  /id="oauthStartBtn"/.test(settingsViewCode) && /id="revokeOauthBtn"/.test(settingsViewCode) &&
  !/id="regStartBtn"/.test(settingsViewCode));
F('飞书设置页含高级设置折叠项（fs-advanced）与二维码/状态容器（regQr/regStatus/regResult）',
  /class="fs-card fs-advanced"/.test(settingsViewCode) && /id="regQr"/.test(settingsViewCode) &&
  /id="regStatus"/.test(settingsViewCode) && /id="regResult"/.test(settingsViewCode));
F('app.js 暴露 startFeishuRegister / cancelFeishuRegister（接入 UI）',
  /startFeishuRegister: startFeishuRegister/.test(appCode) &&
  /cancelFeishuRegister: cancelFeishuRegister/.test(appCode));
F('serve.js 提供注册设备流路由 begin/poll/cancel',
  /\/api\/feishu\/register\/begin/.test(serveCode) &&
  /\/api\/feishu\/register\/poll/.test(serveCode) &&
  /\/api\/feishu\/register\/cancel/.test(serveCode));
F('serve.js 注册成功后把凭证写入 sync.config.json（writeConfig）',
  /feishuSync\.writeConfig\(\{ app_id: r\.client_id, app_secret: r\.client_secret \}\)/.test(serveCode));

/* ---------- 文件级冒烟断言：飞书同步加固（多文件上传 / 同步拉取 / 进度 / 隔离）---------- */
F('上传文件选择器支持多选（multiple）',
  /id="resumeImportFile"[^>]*multiple/.test(htmlClean));
F('抽屉内含批量上传进度面板（#uploadProgress）',
  /id="uploadProgress"/.test(htmlClean) && /id="uploadProgressFill"/.test(htmlClean));
F('feishu-sync.js 多文件导入按 files 循环处理（非 files[0]）',
  /Array\.prototype\.slice\.call\(\(input && input\.files\)/.test(feishuSyncCode));
F('上传走 XHR 上传进度（upload.onprogress）',
  /xhr\.upload\.onprogress/.test(feishuSyncCode));
F('设置页含「拉取最新」入口（setPullBtn）',
  /id="setPullBtn"/.test(settingsViewCode) && /ResumeEditor\.pullFromFeishu\(\)/.test(settingsViewCode));
F('移动端同步面板含拉取 / 历史 / 消息通知入口',
  /ResumeEditor\.pullFromFeishu\(\)/.test(menuMobile) &&
  /ResumeRouter\.navigate\('\/history'\)/.test(menuMobile) &&
  /ResumeNotifier\.togglePanel\(\)/.test(menuMobile));
F('app.js 暴露 pullFromFeishu / startAutoSync 并在启动后调用',
  /pullFromFeishu: pullFromFeishu/.test(appCode) &&
  /startAutoSync\(\)/.test(appCode));
F('历史版本页按激活简历 id 拉版本、恢复中按钮置灰',
  /listVersions\(resumeId\)/.test(historyViewCode) && /恢复中/.test(historyViewCode));
F('历史版本页含加载 spinner',
  /<span class="spinner"><\/span>/.test(historyViewCode) && /正在加载版本历史/.test(historyViewCode));
/* N11：锁定简历只读——恢复本地版本必须先过 isActiveLocked 守卫（浏览历史/手动快照不受限）。
   ⚠️ 窗口限定 400 字符：[\s\S]*? 会跨出函数体匹配到后面 isActiveLocked 的定义处（变异验证踩过）。 */
F('N11 restoreLocalVersion 带锁定守卫（N3 互补：锁定态拒绝覆盖正文）',
  /async function restoreLocalVersion\(versionId\)\{[\s\S]{0,400}isActiveLocked\(\)/.test(appCode));
F('serve.js 恢复接口透传 resumeId（getVersion(versionId, body.resumeId)）',
  /getVersion\(versionId, body\.resumeId \|\| 'default'\)/.test(serveCode));
F('serve.js 静态服务屏蔽敏感文件（sync.config/oauth/state）',
  /SENSITIVE_BASENAMES/.test(serveCode) && /sync\.config\.json/.test(serveCode));
F('后端 getVersion 接收 resumeId 参数（修复 ReferenceError）',
  /async function getVersion\(versionId, resumeId\)/.test(feishuSyncToolCode));
F('后端版本列表改从云盘文件 file_token 取（不再用 docx obj_type）',
  /stateKeyFor\('file_token'/.test(feishuSyncToolCode) &&
  !/versions\?obj_type=docx/.test(feishuSyncToolCode));
F('原生桥按简历分键（file_token_<id>）',
  /stateKey\('file_token', resumeId\)/.test(nativeBridgeCode));
F('CSS 含 spinner / 上传进度条 / 通知面板样式',
  /\.spinner/.test(layoutCssCode) && /\.upload-progress-fill/.test(layoutCssCode) &&
  /\.notif-panel/.test(layoutCssCode) && /\.notif-badge/.test(layoutCssCode));

/* ---------- 文件级冒烟断言：自动双向同步 + 消息通知中心 ---------- */
F('index.html 引入 js/ui/notifier.js（消息通知中心）',
  /<script src="js\/ui\/notifier\.js"><\/script>/.test(htmlClean));
F('工具面板头含通知铃铛（#notifBell）',
  /id="notifBell"/.test(htmlClean));
F('自动同步引擎存在（startAutoSync / autoSyncTick）',
  /function startAutoSync\(\)/.test(feishuSyncCode) && /function autoSyncTick\(\)/.test(feishuSyncCode));
F('自动同步按内容哈希去重（stableHash）',
  /function stableHash\(/.test(feishuSyncCode) && /localHash !== cur\.lastPushedHash/.test(feishuSyncCode));
F('自动同步把异常送消息通知（ResumeNotifier.notify error）',
  /safeNotify\('error'/.test(feishuSyncCode) && /ResumeNotifier/.test(feishuSyncCode));
F('通知模块暴露 notify / unreadCount / togglePanel',
  /notify: notify/.test(fs.readFileSync(path.join(ROOT, 'js', 'ui', 'notifier.js'), 'utf8')) &&
  /unreadCount: unreadCount/.test(fs.readFileSync(path.join(ROOT, 'js', 'ui', 'notifier.js'), 'utf8')));

/* ---------- 统一入口清单（js/ui/menu-actions.js）----------
   在 vm 里按浏览器同路径加载。它的 render() 在加载时就会跑一次（沙箱 document 是桩，
   getElementById 返回临时元素，赋值 innerHTML 无副作用），所以这里只测纯函数 htmlFor()。 */
const menuCases = require(path.join(ROOT, 'test', 'cases-menu.js'));
const menuCtx = {
  ResumeMenu: ctx.ResumeMenu,
  /* N3：分享门禁判定要读「当前激活简历 + 简历库 meta」，这里把两者交给用例，
     用例得以用桩造出各场景（无激活简历 / 未开启分享 / 已开启 / 取值抛错），
     而不是依赖运行器里漂移的 app 状态。 */
  ResumeEditor: ctx.ResumeEditor,
  ResumeLibrary: ctx.ResumeLibrary,
  assert(cond, msg) { fileResults.push({ name: 'menu › ' + msg, pass: !!cond }); },
};
let menuChain = Promise.resolve();
for (const c of menuCases) {
  menuChain = menuChain.then(() => c.fn(menuCtx))
    .catch((e) => { fileResults.push({ name: 'menu › ' + c.name + '（抛错: ' + (e && e.message ? e.message : e) + '）', pass: false }); });
}

/* ---------- 撤销栈按简历隔离（#7）+ 输入框放行原生撤销 ----------
   走 ResumeEditor 公共 API（js/app.js 已暴露 undo/redo/recordHistory/setActiveResumeId/getData/isEditableTarget）。 */
const undoCases = require(path.join(ROOT, 'test', 'cases-undo.js'));
const undoCtx = {
  ResumeEditor: ctx.ResumeEditor,
  assert(cond, msg) { fileResults.push({ name: 'undo › ' + msg, pass: !!cond }); },
};
let undoChain = Promise.resolve();
for (const c of undoCases) {
  undoChain = undoChain.then(() => c.fn(undoCtx))
    .catch((e) => { fileResults.push({ name: 'undo › ' + c.name + '（抛错: ' + (e && e.message ? e.message : e) + '）', pass: false }); });
}

/* ---------- 预览内 ↑↓ 排序（#8 触屏替代拖拽）----------
   纯逻辑 reorderWithin / 渲染 reorderBtns / renderResumeInner 都挂在主 vm 全局，直接调用即可。 */
const reorderCases = require(path.join(ROOT, 'test', 'cases-reorder.js'));
const reorderCtx = {
  ResumeEditor: ctx.ResumeEditor,
  ResumeRender: ctx.ResumeRender,
  assert(cond, msg) { fileResults.push({ name: 'reorder › ' + msg, pass: !!cond }); },
};
let reorderChain = Promise.resolve();
for (const c of reorderCases) {
  reorderChain = reorderChain.then(() => c.fn(reorderCtx))
    .catch((e) => { fileResults.push({ name: 'reorder › ' + c.name + '（抛错: ' + (e && e.message ? e.message : e) + '）', pass: false }); });
}

/* ---------- 性能回归（#9）：分页线 rAF 合并，防每键同步重画 ---------- */
const perfCases = require(path.join(ROOT, 'test', 'cases-perf.js'));
const perfCtx = {
  ResumeRender: ctx.ResumeRender,
  global: ctx,
  assert(cond, msg) { fileResults.push({ name: 'perf › ' + msg, pass: !!cond }); },
};
let perfChain = Promise.resolve();
for (const c of perfCases) {
  perfChain = perfChain.then(() => c.fn(perfCtx))
    .catch((e) => { fileResults.push({ name: 'perf › ' + c.name + '（抛错: ' + (e && e.message ? e.message : e) + '）', pass: false }); });
}

/* ---------- 倒数第二步：保存状态条（保存三态 + 存储降级通知）----------
   在 vm 里按浏览器同路径加载；用例既测状态机纯逻辑，也**真的**把演示 fetch 换成
   必然失败的实现，验证「写盘失败 → 降级通知」这条唯一可感知通道确实发出。 */
try {
  const ssCode = fs.readFileSync(path.join(ROOT, 'js', 'ui', 'save-status.js'), 'utf8');
  vm.runInContext(ssCode, ctx, { filename: 'save-status.js' });
} catch (e) {
  fileResults.push({ name: '加载期异常（js/ui/save-status.js）: ' + (e && e.message ? e.message : e), pass: false });
}

const ssCases = require(path.join(ROOT, 'test', 'cases-save-status.js'));
const ssCtx = {
  SaveStatus: ctx.ResumeSaveStatus,
  ResumeLibrary: ctx.ResumeLibrary,
  vmGlobal: ctx,   // 用于注入「必然失败的 fetch」以走通降级分支
  assert(cond, msg) { fileResults.push({ name: 'savestatus › ' + msg, pass: !!cond }); },
};
let ssChain = Promise.resolve();
for (const c of ssCases) {
  ssChain = ssChain.then(() => c.fn(ssCtx))
    .catch((e) => { fileResults.push({ name: 'savestatus › ' + c.name + '（抛错: ' + (e && e.message ? e.message : e) + '）', pass: false }); });
}

/* ---------- 末步：本地写服务的 HTTP 冒烟测试（真起子进程）----------
   这是整个 run.js 里**唯一真正执行 serve.js** 的用例：其它关于 serve.js 的断言都只是把源码
   读成字符串做正则匹配，于是「一次普通 GET 请求就把服务进程杀掉」这种缺陷能一路逃过全绿。
   本组用例起随机端口的子进程打真实请求，并断言服务在该请求后仍存活、各接口状态码分类正确。 */
/* ---------- 倒数第一步：JD 匹配分析（js/jd-match.js）----------
   在主 vm 里按浏览器同路径加载（它只读 ResumeEditor.getData()，不写数据，不污染其它用例）。
   用例既测纯逻辑（术语抽取 / 词边界 / 分桶），也钉住「JD 原文不进简历数据」这条隐私边界。 */
try {
  const jdCode = fs.readFileSync(path.join(ROOT, 'js', 'jd-match.js'), 'utf8');
  vm.runInContext(jdCode, ctx, { filename: 'jd-match.js' });
} catch (e) {
  fileResults.push({ name: '加载期异常（js/jd-match.js）: ' + (e && e.message ? e.message : e), pass: false });
}

const jdCases = require(path.join(ROOT, 'test', 'cases-jd.js'));
const jdCtx = {
  ResumeJd: ctx.ResumeJd,
  ResumeMenu: ctx.ResumeMenu,   // JD 入口在两端清单里是否都在，由 menu-actions 的清单说话
  vmGlobal: ctx,   // 用例需要临时替换 document.getElementById 来喂 textarea
  assert(cond, msg) { fileResults.push({ name: 'jd › ' + msg, pass: !!cond }); },
};
let jdChain = Promise.resolve();
for (const c of jdCases) {
  jdChain = jdChain.then(() => c.fn(jdCtx))
    .catch((e) => { fileResults.push({ name: 'jd › ' + c.name + '（抛错: ' + (e && e.message ? e.message : e) + '）', pass: false }); });
}

/* ---------- App 导出落盘（原生分流）----------
   自建隔离 vm 沙箱桩 __TAURI__，验证 native-bridge 挂载 saveFile/printPage 及字节 base64 编码；
   源码级断言 export-extra / export-pdf 复用统一 downloadBlob 落盘、fallback 走 printPage。 */
const nativeExportCases = require(path.join(ROOT, 'test', 'cases-native-export.js'));
const nativeExportCtx = {
  assert(cond, msg) { fileResults.push({ name: 'native-export › ' + msg, pass: !!cond }); },
};
let nativeExportChain = Promise.resolve();
for (const c of nativeExportCases) {
  nativeExportChain = nativeExportChain.then(() => c.fn(nativeExportCtx))
    .catch((e) => { fileResults.push({ name: 'native-export › ' + c.name + '（抛错: ' + (e && e.message ? e.message : e) + '）', pass: false }); });
}

/* ---------- 保存防抖 + 切换取消 pending（性能债第 1 层 + 跨简历污染防护）----------
   自建隔离 vm 沙箱（桩 contentHash / ResumeStore.save 计数），验证：
   · 连续 saveState 只在防抖结束算一次 contentHash（每键全量哈希 → 防抖后一次）；
   · cancelPendingSave 取消 pending 保存，避免旧份数据写进新份。 */
const saveDebounceCases = require(path.join(ROOT, 'test', 'cases-save-debounce.js'));
const saveDebounceCtx = {
  assert(cond, msg) { fileResults.push({ name: 'save-debounce › ' + msg, pass: !!cond }); },
};
let saveDebounceChain = Promise.resolve();
for (const c of saveDebounceCases) {
  saveDebounceChain = saveDebounceChain.then(() => c.fn(saveDebounceCtx))
    .catch((e) => { fileResults.push({ name: 'save-debounce › ' + c.name + '（抛错: ' + (e && e.message ? e.message : e) + '）', pass: false }); });
}

const httpCases = require(path.join(ROOT, 'test', 'cases-serve-http.js'));
const httpCtx = {
  assert(cond, msg) { fileResults.push({ name: 'http › ' + msg, pass: !!cond }); },
};
let httpChain = Promise.resolve();
for (const c of httpCases) {
  httpChain = httpChain.then(() => c.fn(httpCtx))
    .catch((e) => { fileResults.push({ name: 'http › ' + c.name + '（抛错: ' + (e && e.message ? e.message : e) + '）', pass: false }); });
}

/* ---------- N4 F1 暗色模式：js/theme.js 纯逻辑用例 ----------
   主题模块是浏览器 IIFE（window.ResumeTheme），不在主 bundle 里，
   且无 CommonJS 导出。这里自建一个隔离 vm 沙箱，注入 documentElement /
   localStorage / matchMedia 桩，按浏览器同路径加载 theme.js，再跑用例。
   这样「auto 解析 / 纸张跟随例外 / 导出强制白纸 / DOM 落地」都有失效面钉住。 */
const themeStore = new Map();
const themeAttrs = {};
const themeDocumentElement = {
  setAttribute(k, v) { themeAttrs[k] = String(v); },
  removeAttribute(k) { delete themeAttrs[k]; },
  getAttribute(k) { return (k in themeAttrs) ? themeAttrs[k] : null; },
};
let themeMqMatches = false;
const themeMatchMedia = (q) => ({
  matches: themeMqMatches, media: q,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});
const themeDoc = {
  documentElement: themeDocumentElement,
  getElementById() { return null; },
  querySelector() { return null; },
  addEventListener() {},
  readyState: 'complete',
};
const themeCtx = {
  console, JSON, Date, Math, Object, Array, String, Number, Boolean,
  isNaN, parseInt, parseFloat, RegExp, Error, Promise, setTimeout, clearTimeout,
  document: themeDoc,
  localStorage: {
    getItem(k) { return themeStore.has(k) ? themeStore.get(k) : null; },
    setItem(k, v) { themeStore.set(k, String(v)); },
    removeItem(k) { themeStore.delete(k); },
  },
  matchMedia: themeMatchMedia,
  addEventListener() {},
  getComputedStyle() { return { getPropertyValue() { return ''; } }; },
};
themeCtx.window = themeCtx;
vm.createContext(themeCtx);
try {
  const themeCode = fs.readFileSync(path.join(ROOT, 'js', 'theme.js'), 'utf8');
  vm.runInContext(themeCode, themeCtx, { filename: 'theme.js' });
} catch (e) {
  fileResults.push({ name: '加载期异常（js/theme.js）: ' + (e && e.message ? e.message : e), pass: false });
}
const themeCases = require(path.join(ROOT, 'test', 'cases-theme.js'));
const themeCaseCtx = {
  ResumeTheme: themeCtx.ResumeTheme,
  store: {
    get(k) { return themeStore.has(k) ? themeStore.get(k) : null; },
    set(k, v) { themeStore.set(k, String(v)); },
    clear() { themeStore.clear(); },
  },
  attrs: {
    get(k) { return (k in themeAttrs) ? themeAttrs[k] : null; },
    has(k) { return k in themeAttrs; },
  },
  mq: {
    setDark(b) { themeMqMatches = !!b; },
    isDark() { return themeMqMatches; },
  },
  assert(cond, msg) { fileResults.push({ name: 'theme › ' + msg, pass: !!cond }); },
};
let themeChain = Promise.resolve();
for (const c of themeCases) {
  themeChain = themeChain.then(() => c.fn(themeCaseCtx))
    .catch((e) => { fileResults.push({ name: 'theme › ' + c.name + '（抛错: ' + (e && e.message ? e.message : e) + '）', pass: false }); });
}

/* ---------- N3 分享与权限控制：js/store/library-share.js 纯逻辑用例 ----------
   该模块已在主 bundle 里加载（app.js 的 shareApi() 读它），这里直接取出断言。 */
const shareCases = fs.existsSync(path.join(ROOT, 'test', 'cases-share.js'))
  ? require(path.join(ROOT, 'test', 'cases-share.js')) : [];
const shareCtx = {
  ResumeShare: ctx.ResumeShare,
  assert(cond, msg) { fileResults.push({ name: 'share › ' + msg, pass: !!cond }); },
};
let shareChain = Promise.resolve();
for (const c of shareCases) {
  shareChain = shareChain.then(() => c.fn(shareCtx))
    .catch((e) => { fileResults.push({ name: 'share › ' + c.name + '（抛错: ' + (e && e.message ? e.message : e) + '）', pass: false }); });
}

/* ---------- N9 导出为个人官网：脱敏 + 单文件官网渲染 + 两种官网板块 ----------
   模块已在主 bundle 里加载（portfolio-view.js 提供板块 HTML，portfolio-html.js 提供脱敏与拼装）。 */
const pfCases = fs.existsSync(path.join(ROOT, 'test', 'cases-portfolio.js'))
  ? require(path.join(ROOT, 'test', 'cases-portfolio.js')) : [];
const pfCtx = {
  ResumePortfolio: ctx.ResumePortfolio,
  PortfolioView: ctx.PortfolioView,
  ResumeEditorSchema: ctx.ResumeEditorSchema,
  ResumeRender: ctx.ResumeRender,
  ResumeEditor: ctx.ResumeEditor,
  ResumeExport: ctx.ResumeExport,
  ResumeMenu: ctx.ResumeMenu,
  assert(cond, msg) { fileResults.push({ name: 'portfolio › ' + msg, pass: !!cond }); },
};
let pfChain = Promise.resolve();
for (const c of pfCases) {
  pfChain = pfChain.then(() => c.fn(pfCtx))
    .catch((e) => { fileResults.push({ name: 'portfolio › ' + c.name + '（抛错: ' + (e && e.message ? e.message : e) + '）', pass: false }); });
}

/* ---------- 报告（等异步的 library 用例跑完再输出） ---------- */
libChain.then(() => lhChain).then(() => ssChain).then(() => jdChain).then(() => nativeExportChain).then(() => menuChain).then(() => undoChain).then(() => reorderChain).then(() => perfChain).then(() => saveDebounceChain).then(() => themeChain).then(() => shareChain).then(() => pfChain).then(() => httpChain).then(() => {
  const all = ctx.__results.concat(fileResults);
  let pass = 0, fail = 0;
  for (const r of all) {
    if (r.pass) { pass++; console.log('  ✓ ' + r.name); }
    else { fail++; console.log('  ✗ ' + r.name); }
  }
  console.log('\n结果: pass=' + pass + ' fail=' + fail + ' total=' + all.length);
  process.exit(fail > 0 ? 1 : 0);
});
