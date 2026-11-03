#!/usr/bin/env node
/**
 * 简历编辑器 · 本地写服务（零依赖）
 *
 * 纯前端浏览器无法向磁盘写文件，因此「实时保存回 data/resume.json」需要一个能接收
 * 写入请求的本地服务。本文件既是静态文件服务器，又暴露一个写接口：
 *
 *   GET  /                       → index.html（编辑器）
 *   GET  /<任意静态资源>          → 项目内文件（含 data/resume.json）
 *   POST /api/resume             → 把请求体 JSON 落盘为 data/resume.json（实时保存）
 *   POST /api/pdf                → 静默导出「可选中文字」的 PDF（复用 render-resume.js 渲染管线
 *                                  + 本机 Chrome/Edge 的 headless 打印，不经系统打印对话框）
 *
 * 启动：node tools/serve.js   或   npm start   （默认端口 8000，可用 PORT 环境变量覆盖）
 *
 * 注意：data/ 已被 .gitignore 忽略，所以写回的 resume.json 是「本机私有、不进公开仓库」的。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 8000;
const DATA_FILE = path.join(ROOT, 'data', 'resume.json');

/* 飞书「个人应用」扫码注册的设备流会话表：begin 时建、poll 时查；纯内存不落盘，
   凭证仅在 poll 成功瞬间写入 sync.config.json（gitignored）。 */
const registerSessions = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'text/plain; charset=utf-8' });
  if (Buffer.isBuffer(body) || typeof body === 'string') res.end(body);
  else res.end(JSON.stringify(body));
}

/* =============================================================
 * 静默 PDF：本机 Chrome / Edge 的 headless 打印
 * -------------------------------------------------------------
 * 为什么这么做：纯前端无法在不弹打印对话框的前提下产出「可选中文字」的 PDF
 * （html2canvas 是截图；jsPDF 要内嵌中文字体，体积与许可都不划算）。而本机
 * 几乎都装了 Chrome/Edge，用它的 headless 打印即可拿到矢量文字 PDF。
 * 失败时前端自动回退到 window.print()，不影响任何既有用法。
 * ============================================================= */
/* 探测本机可用的 Chromium 系浏览器；可用 CHROME_PATH 环境变量强制指定 */
function findBrowser() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const c = [];
  if (process.platform === 'darwin') {
    c.push(
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
    c.push(
      path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe')
    );
  } else {
    c.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
      '/usr/bin/chromium-browser', '/snap/bin/chromium', '/opt/google/chrome/chrome');
  }
  for (const p of c) { try { if (p && fs.existsSync(p)) return p; } catch (e) { /* 忽略无权限路径 */ } }
  return null;
}

/* 跑一个子进程并收集输出（不抛异常，失败以 code/err 返回，交由调用方决定降级） */
function runCmd(cmd, args, timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done) { done = true; resolve(r); } };
    let p;
    try { p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return finish({ code: -1, out: '', err: String(e && e.message || e) }); }
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => finish({ code: -1, out: out, err: String(e && e.message || e) }));
    p.on('close', code => finish({ code: code, out: out, err: err }));
    const t = setTimeout(() => { try { p.kill(); } catch (e) { } finish({ code: -1, out: out, err: '超时（' + (timeoutMs || 60000) + 'ms）' }); }, timeoutMs || 60000);
    if (t.unref) t.unref();
  });
}

/* 用项目真实渲染管线把 payload 渲染成独立 A4 HTML（复用 tools/render-resume.js） */
async function renderA4Html(payload, baseName) {
  // 临时文件放 dist/（gitignored）：让 HTML 里的相对资源路径（如 vendor/xxx.png）仍能解析
  const dist = path.join(ROOT, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const jsonPath = path.join(dist, baseName + '.json');
  const htmlPath = path.join(dist, baseName + '.html');
  fs.writeFileSync(jsonPath, JSON.stringify(payload), 'utf8');
  const r = await runCmd(process.execPath, [path.join(__dirname, 'render-resume.js'), jsonPath, htmlPath], 60000);
  if (r.code !== 0 || !fs.existsSync(htmlPath)) {
    throw new Error('渲染简历 HTML 失败：' + (r.err || r.out || '未知错误').toString().slice(0, 300));
  }
  return htmlPath;
}

/* 等待某个文件「写完」：连续两次 stat 到的体积一致且非空即认为完成 */
function waitForFile(file, timeoutMs) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let last = -1;
    const tick = () => {
      let size = 0;
      try { size = fs.statSync(file).size; } catch (e) { size = 0; }
      if (size > 1000 && size === last) return resolve(true);   // 体积稳定 → 写完
      last = size;
      if (Date.now() - t0 > timeoutMs) return resolve(size > 1000);
      setTimeout(tick, 250);
    };
    setTimeout(tick, 400);
  });
}

/* headless 打印 HTML → PDF；返回 PDF 字节
 * 注意：部分 macOS 环境下 Chrome 打印完成后**不会自行退出**（实测挂起，stderr 反复刷
 * CVDisplayLink 错误）。所以这里不能等进程 close，而是「轮询等待产物 + 主动收尾」。 */
async function printToPdf(htmlPath, pdfPath) {
  const browser = findBrowser();
  if (!browser) {
    const e = new Error('未找到 Chrome / Chromium / Edge，无法静默导出 PDF');
    e.code = 'NO_BROWSER';
    throw e;
  }
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-pdf-'));
  const baseArgs = [
    '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + userDir,
    '--no-pdf-header-footer',            // 去掉页眉页脚（日期 / URL / 页码）
    '--print-to-pdf-no-header',
    '--virtual-time-budget=8000',        // 等字体与图片就绪
    'file://' + htmlPath.replace(/\\/g, '/')
  ];
  let stderr = '';
  const runOnce = async (headlessFlag, waitMs) => {
    // 开始前先清掉上一轮可能的残留产物，避免把旧文件误判成本轮结果
    try { fs.rmSync(pdfPath, { force: true }); } catch (e) { }
    let child;
    try { child = spawn(browser, [headlessFlag, '--print-to-pdf=' + pdfPath].concat(baseArgs), { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { stderr += String(e && e.message || e); return false; }
    child.stdout.on('data', () => { });
    child.stderr.on('data', d => { if (stderr.length < 4000) stderr += d; });
    const ok = await waitForFile(pdfPath, waitMs);
    // 无论成功与否都收尾：Chrome 可能打印完不退出（见上方注释）
    try { child.kill('SIGKILL'); } catch (e) { }
    return ok;
  };

  let produced = await runOnce('--headless=new', 45000);
  if (!produced) produced = await runOnce('--headless', 45000);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结果 */ }

  if (!produced || !fs.existsSync(pdfPath)) {
    throw new Error('PDF 生成失败：' + (stderr || '浏览器未产出文件').toString().slice(0, 300));
  }
  const buf = fs.readFileSync(pdfPath);
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') throw new Error('产出的文件不是合法 PDF');
  return buf;
}

/* 请求入口守卫：本服务持有简历 PII 与各类凭证，只应被「经 npm start 打开的本机页面」访问。
   1) Host 校验 —— 防 DNS rebinding：恶意域名先把 JS 送达浏览器、再把 DNS 重绑到 127.0.0.1，
      若不校验 Host，攻击者页面即可同源读取 /data/resume.json 与全部 /api 响应；
   2) /api/* 的 Origin / Sec-Fetch-Site 校验 —— 防跨站 CSRF：POST 表单/凑内容型 fetch 属
      「简单请求」免预检即可达服务器，校验 Origin 白名单可整链掐断；
   3) 畸形 URL 容错 —— decodeURIComponent 对非法百分号编码（如 /%zz）抛 URIError，
      不捕获会让整个进程退出（单个 <img src=...> 就能反复杀掉本地服务、中断实时保存）。 */
const HOST_ALLOW = new Set([
  '127.0.0.1:' + PORT,
  'localhost:' + PORT,
  '[::1]:' + PORT
]);
const ORIGIN_ALLOW = new Set([
  'http://127.0.0.1:' + PORT,
  'http://localhost:' + PORT,
  'http://[::1]:' + PORT
]);

/* 进程级兜底：请求处理链里任何未捕获的异常都不允许再穿透到进程。
   曾经的教训——/api/library/doc 里一处 ReferenceError 让整个服务静默退出，前端随即
   永久降级到 localStorage，用户以为已保存、磁盘上却什么都没有（静默数据丢失）。
   这里只做「不杀进程 + 记日志 + 尽力给当前请求一个 500」，不掩盖问题：日志保留完整堆栈，
   且测试会断言各接口返回预期状态码——真走了兜底就会返回 500，测试当场变红。 */
let _activeRes = null;
process.on('uncaughtException', (e) => {
  console.error('[未捕获异常] ' + ((e && e.stack) || e));
  if (_activeRes && !_activeRes.headersSent) {
    try {
      _activeRes.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      _activeRes.end(JSON.stringify({ error: '内部错误（详见服务端日志）' }));
    } catch (_) { /* 响应已不可写，忽略 */ }
  }
});
process.on('unhandledRejection', (e) => {
  console.error('[未处理的 Promise 拒绝] ' + ((e && e.stack) || e));
});

const server = http.createServer((req, res) => {
  _activeRes = res; // 兜底用：异常发生时把 500 回给当前请求，避免连接静默挂起

  // 1) Host 必须是本机回环（浏览器请求一定带 Host；rebinding 域名会暴露自己）
  const host = String(req.headers.host || '').toLowerCase();
  if (!HOST_ALLOW.has(host)) return send(res, 403, { error: 'Forbidden: invalid Host' });

  // 2) /api/* 只接受本机同源页面发起的请求（curl 等无 Origin 的非浏览器调用不受影响）
  if (String(req.url).startsWith('/api/')) {
    const origin = req.headers.origin;
    if (origin !== undefined && !ORIGIN_ALLOW.has(String(origin))) {
      return send(res, 403, { error: 'Forbidden: invalid Origin' });
    }
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && String(site).toLowerCase() === 'cross-site') {
      return send(res, 403, { error: 'Forbidden: cross-site request' });
    }
  }

  // 3) URL 解析容错：解析失败按 400 处理，绝不让异常穿透到进程
  // ⚠️ u 必须在 try 之外声明：下面多处接口（/api/library/doc、/api/feishu/register/poll、
  //    /api/feishu/register/cancel）是在 try 块以外读它的。此前写成块内 const，
  //    导致一次普通的 GET 请求就抛 ReferenceError 并直接杀掉整个服务进程。
  let pathname, u;
  try {
    u = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(u.pathname);
  } catch (e) {
    return send(res, 400, { error: 'Bad Request: malformed URL' });
  }

  // 3.5) favicon：项目根目录无 favicon.ico，浏览器每次加载都会请求它得到 404，
  //   在控制台 / 网络面板制造噪音（BUG-05）。这里返回一个内存 SVG 图标（200），
  //   无需新增文件、不影响其它路由。
  if (pathname === '/favicon.ico') {
    const ico = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
      + '<rect width="16" height="16" rx="3" fill="#2f6fed"/>'
      + '<text x="8" y="12" font-size="10" font-family="sans-serif" text-anchor="middle" fill="#fff">简</text>'
      + '</svg>';
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'no-store'
    });
    return res.end(ico);
  }

  // —— 写接口：把当前编辑器数据落盘为 data/resume.json ——
  if (req.method === 'POST' && pathname === '/api/resume') {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 20 * 1024 * 1024) { req.destroy(); } // 体积兜底，防止恶意超大请求
    });
    req.on('end', () => {
      let obj;
      try { obj = JSON.parse(buf); }
      catch (e) { return send(res, 400, { error: 'JSON 解析失败: ' + e.message }); }
      if (!obj || !obj.data || !Array.isArray(obj.data.sections)) {
        return send(res, 400, { error: '格式不正确（缺少 data.sections）' });
      }
      try {
        fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
        fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2) + '\n', 'utf8');
        return send(res, 200, { ok: true });
      } catch (e) {
        return send(res, 500, { error: '写入失败: ' + e.message });
      }
    });
    return;
  }

  // —— 简历库接口（统一分文件模型：index.json + <id>.json）——
  // 浏览器开发模式（npm start）与桌面端（Tauri 命令）共用同一份 ResumeLibrary 代码，
  // 只是落盘位置不同：这里读写 data/resumes/，桌面端读写 app_data_dir()/resumes/。
  // 目录结构：index.json（清单+激活态+内容指纹） + <id>.json（每份简历一个文件）。
  const LIB_DIR = path.join(ROOT, 'data', 'resumes');
  const LIB_INDEX = path.join(LIB_DIR, 'index.json');
  const sanitizeResumeId = (id) => /^[A-Za-z0-9_-]{1,128}$/.test(id || '') ? id : null;
  const readJsonFile = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
  const writeJsonFile = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8'); };

  if (req.method === 'GET' && pathname === '/api/library/index') {
    return send(res, 200, { index: readJsonFile(LIB_INDEX) });
  }
  if (req.method === 'POST' && pathname === '/api/library/index') {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      let idx;
      try { idx = JSON.parse(buf); } catch (e) { return send(res, 400, { error: 'JSON 解析失败: ' + e.message }); }
      if (!idx || typeof idx !== 'object') return send(res, 400, { error: 'index 必须是对象' });
      const items = Array.isArray(idx.items) ? idx.items : [];
      for (const it of items) {
        if (!it || !sanitizeResumeId(it.id)) return send(res, 400, { error: 'index 含非法简历 id' });
      }
      try { writeJsonFile(LIB_INDEX, idx); return send(res, 200, { ok: true }); }
      catch (e) { return send(res, 500, { error: '写入 index.json 失败: ' + e.message }); }
    });
    return;
  }
  if ((req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE') && pathname === '/api/library/doc') {
    const id = sanitizeResumeId(u.searchParams.get('id'));
    if (!id) return send(res, 400, { error: '非法简历 id' });
    const fp = path.join(LIB_DIR, id + '.json');
    if (req.method === 'GET') return send(res, 200, { doc: readJsonFile(fp) });
    if (req.method === 'DELETE') {
      try { fs.rmSync(fp, { force: true }); } catch (e) {}
      return send(res, 200, { ok: true });
    }
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 20 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      let doc;
      try { doc = JSON.parse(buf); } catch (e) { return send(res, 400, { error: 'JSON 解析失败: ' + e.message }); }
      if (!doc || typeof doc !== 'object' || !doc.data) return send(res, 400, { error: '简历载荷非法（缺少 data）' });
      try { writeJsonFile(fp, doc); return send(res, 200, { ok: true }); }
      catch (e) { return send(res, 500, { error: '写入简历文件失败: ' + e.message }); }
    });
    return;
  }

  // —— 数据体检：把「我的简历到底存在哪、有几份、最后一次写盘是什么时候」如实报给页面 ——
  // 仅面向本机回环页面（上面的 Host / Origin 校验已保证），返回本机绝对路径便于用户自行核对。
  if (req.method === 'GET' && pathname === '/api/library/info') {
    const legacyFile = path.join(ROOT, 'data', 'resume.json');
    let dirExists = false, indexExists = false, docCount = 0, lastWriteAt = 0;
    try {
      dirExists = fs.existsSync(LIB_DIR);
      indexExists = fs.existsSync(LIB_INDEX);
      if (indexExists) {
        const idx = readJsonFile(LIB_INDEX);
        const items = (idx && Array.isArray(idx.items)) ? idx.items : [];
        docCount = items.length;
        for (const it of items) {
          const t = Number(it && it.updatedAt) || 0;
          if (t > lastWriteAt) lastWriteAt = t;
        }
      }
    } catch (e) { /* 目录不可读时按空库上报，不因此报 500 */ }
    return send(res, 200, {
      ok: true,
      base: LIB_DIR,
      indexPath: LIB_INDEX,
      dirExists: dirExists,
      indexExists: indexExists,
      docCount: docCount,
      lastWriteAt: lastWriteAt || null,
      legacyFile: legacyFile,
      legacyExists: fs.existsSync(legacyFile)
    });
  }

  // —— 公司调研数据（整集合落盘 data/companies/companies.json）——
  // 与简历库同一思路：npm start 时写文件（持久、跨刷新不丢），离线 / 双击打开时前端自动降级 localStorage。
  const COMPANY_DIR = path.join(ROOT, 'data', 'companies');
  const COMPANY_FILE = path.join(COMPANY_DIR, 'companies.json');
  if (req.method === 'GET' && pathname === '/api/companies') {
    return send(res, 200, { companies: readJsonFile(COMPANY_FILE) || [] });
  }
  if (req.method === 'POST' && pathname === '/api/companies') {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 5 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      let arr;
      try { arr = JSON.parse(buf); } catch (e) { return send(res, 400, { error: 'JSON 解析失败: ' + e.message }); }
      if (!Array.isArray(arr)) return send(res, 400, { error: 'companies 必须是数组' });
      try { writeJsonFile(COMPANY_FILE, arr); return send(res, 200, { ok: true }); }
      catch (e) { return send(res, 500, { error: '写入公司数据失败: ' + e.message }); }
    });
    return;
  }

  // —— 投递聊天的「种子包」：把截图整理好的聊天记录落盘，前端按版本号一次性并入 ——
  // 投递记录本身仍存浏览器 localStorage（避免覆盖用户已有数据），
  // 这里只提供只读的种子文件（data/tracker/seed.json），前端用 SEED_KEY 记住已并入的版本。
  const SEED_FILE = path.join(ROOT, 'data', 'tracker', 'seed.json');
  if (req.method === 'GET' && pathname === '/api/tracker-seed') {
    const seed = readJsonFile(SEED_FILE);
    if (!seed || !Array.isArray(seed.records)) return send(res, 200, { version: 0, records: [] });
    return send(res, 200, seed);
  }

  // —— IM 聊天采集：驱动「已登录 BOSS 直聘的 Chrome」（远程调试端口）抽取聊天记录 ——
  // 依赖本机 Chrome 以 --remote-debugging-port 启动；未开启时返回 hint 引导用户。
  if (req.method === 'POST' && pathname === '/api/collect-chat') {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(buf || '{}'); } catch (e) {}
      const company = String(body.company || '');
      const port = String(process.env.CDP_PORT || body.port || 9222);
      const script = path.join(ROOT, 'tools', 'boss-collect.js');
      let out = '';
      let done = false;
      const finish = (obj) => {
        if (done) return;
        done = true;
        return send(res, 200, obj);
      };
      let child;
      try {
        child = spawn(process.execPath, [script, '--port', port, '--company', company], {
          cwd: ROOT, env: process.env
        });
      } catch (e) {
        return finish({ ok: false, messages: [], hint: '无法启动采集脚本：' + e.message });
      }
      const killer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (e) {}
        finish({ ok: false, messages: [], hint: '采集超时（20s）。请确认 Chrome 远程调试端口可用。' });
      }, 20000);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', () => {
        clearTimeout(killer);
        let obj = null;
        try { obj = JSON.parse(out); } catch (e) {}
        if (!obj) return finish({ ok: false, messages: [], hint: '采集脚本无有效输出。' });
        return finish(obj);
      });
      child.on('error', (e) => {
        clearTimeout(killer);
        finish({ ok: false, messages: [], hint: '采集脚本运行失败：' + e.message });
      });
    });
    return;
  }

  // —— 静默 PDF：请求体是完整数据 payload，返回 application/pdf 直接下载 ——
  if (req.method === 'POST' && pathname === '/api/pdf') {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 20 * 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(buf); } catch (e) { return send(res, 400, { error: 'JSON 解析失败: ' + e.message }); }
      if (!payload || !payload.data || !Array.isArray(payload.data.sections)) {
        return send(res, 400, { error: '格式不正确（缺少 data.sections）' });
      }
      const stamp = 'print-tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      const dist = path.join(ROOT, 'dist');
      let htmlPath = '', pdfPath = path.join(dist, stamp + '.pdf');
      try {
        htmlPath = await renderA4Html(payload, stamp);
        const pdf = await printToPdf(htmlPath, pdfPath);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': pdf.length,
          'Cache-Control': 'no-store'
        });
        return res.end(pdf);
      } catch (e) {
        return send(res, e && e.code === 'NO_BROWSER' ? 501 : 500, {
          error: (e && e.message) || 'PDF 生成失败',
          hint: e && e.code === 'NO_BROWSER'
            ? '请安装 Chrome / Edge，或用 CHROME_PATH 指定浏览器路径；也可改用「打印 / 另存为 PDF」'
            : '可改用工具栏「打印 / 另存为 PDF」'
        });
      } finally {
        try { if (htmlPath) fs.unlinkSync(htmlPath); } catch (e) { }
        try { fs.unlinkSync(path.join(dist, stamp + '.json')); } catch (e) { }
        try { fs.unlinkSync(pdfPath); } catch (e) { }
      }
    });
    return;
  }

  // —— 飞书同步接口（上报 / 版本列表 / 恢复）——
  // 凭证由本地服务持有，浏览器只与本服务通信，凭证绝不进浏览器。
  const feishuSync = (() => { try { return require('./feishu-sync.js'); } catch (e) { return null; } })();
  if (req.method === 'POST' && pathname === '/api/sync') {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 20 * 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      if (!feishuSync) return send(res, 500, { error: 'feishu-sync.js 未找到' });
      if (!feishuSync.enabled()) return send(res, 400, { error: '飞书未配置：请在 sync.config.json 填入 app_id / app_secret（参考 sync.config.json.example）' });
      try {
        const obj = JSON.parse(buf);
        const r = await feishuSync.report(obj);
        return send(res, 200, { ok: true, docUrl: r.docUrl, fileUrl: r.fileUrl, size: r.size, dryRun: !!r.dryRun, authMode: r.authMode });
      } catch (e) { return send(res, 502, { error: e.message }); }
    });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/sync/versions') {
    (async () => {
      if (!feishuSync) return send(res, 500, { error: 'feishu-sync.js 未找到' });
      if (!feishuSync.enabled()) return send(res, 400, { error: '飞书未配置' });
      try { const vs = await feishuSync.listVersions(new URL(req.url,'http://localhost').searchParams.get('resumeId')); return send(res, 200, { versions: vs }); }
      catch (e) { return send(res, 502, { error: e.message }); }
    })();
    return;
  }
  if (req.method === 'POST' && pathname === '/api/sync/restore') {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      if (!feishuSync) return send(res, 500, { error: 'feishu-sync.js 未找到' });
      if (!feishuSync.enabled()) return send(res, 400, { error: '飞书未配置' });
      try {
        const body = JSON.parse(buf);
        const { versionId } = body;
        if (!versionId) return send(res, 400, { error: '缺少 versionId' });
        // resumeId 决定从哪份简历的云盘文件取版本（缺省 'default'，兼容单份简历）
        const txt = await feishuSync.getVersion(versionId, body.resumeId || 'default');
        return send(res, 200, { json: txt });
      } catch (e) { return send(res, 502, { error: e.message }); }
    });
    return;
  }

  // —— 飞书配置表单接口（读取时永不回传 app_secret 明文，只回传是否已设置的标记）——
  // —— 飞书一键绑定：验证凭证 + 自动建「简历数据」文件夹 + 回填默认项（M3）——
  if (req.method === 'POST' && pathname === '/api/sync/probe') {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      if (!feishuSync) return send(res, 500, { error: 'feishu-sync.js 未找到' });
      let body;
      try { body = JSON.parse(buf); } catch (e) { return send(res, 400, { error: 'JSON 解析失败' }); }
      // 表单留空时回退用已保存的 sync.config.json 凭证（扫码注册后表单 Secret 本就为空，但仍可探测）
      const saved = feishuSync.readConfig() || {};
      const appId = String(body.app_id || '').trim() || saved.app_id || '';
      const appSecret = String(body.app_secret || '').trim() || saved.app_secret || '';
      if (!appId || !appSecret) return send(res, 400, { error: 'App ID 与 App Secret 均必填（或先在配置中保存过凭证）' });
      try {
        const r = await feishuSync.probe(appId, appSecret);
        return send(res, 200, { ok: true, ...r });
      } catch (e) { return send(res, 502, { error: e.message }); }
    });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/sync/config') {
    if (!feishuSync) return send(res, 500, { error: 'feishu-sync.js 未找到' });
    const c = feishuSync.readConfig() || {};
    return send(res, 200, {
      configured: !!(c.app_id && c.app_secret),
      config: {
        app_id: c.app_id || '',
        domain: c.domain || '',
        folder_token: c.folder_token || '',
        doc_title: c.doc_title || '',
        file_name: c.file_name || '',
        dryRun: !!c.dryRun,
        hasSecret: !!c.app_secret
      }
    });
  }
  if (req.method === 'POST' && pathname === '/api/sync/config') {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      if (!feishuSync) return send(res, 500, { error: 'feishu-sync.js 未找到' });
      let body;
      try { body = JSON.parse(buf); } catch (e) { return send(res, 400, { error: 'JSON 解析失败' }); }
      const cur = feishuSync.readConfig() || {};
      const patch = {
        app_id: String(body.app_id || '').trim(),
        domain: String(body.domain || '').trim(),
        folder_token: String(body.folder_token || '').trim(),
        doc_title: String(body.doc_title || '').trim(),
        file_name: String(body.file_name || '').trim()
      };
      // Secret 为空表示「不修改」：保留已有值，避免每次保存都得重填
      const secret = String(body.app_secret || '').trim();
      if (secret) patch.app_secret = secret;
      if (!patch.app_id) return send(res, 400, { error: 'App ID 不能为空' });
      if (!patch.app_secret) {
        if (cur.app_secret) patch.app_secret = cur.app_secret; // 留空 = 沿用已保存的 Secret
        else return send(res, 400, { error: 'App Secret 不能为空（首次配置必填）' });
      }
      if (body.dryRun === true || body.dryRun === false) patch.dryRun = body.dryRun;
      try {
        feishuSync.writeConfig(patch);
        return send(res, 200, { ok: true, configured: !!(patch.app_id && patch.app_secret) });
      } catch (e) { return send(res, 500, { error: '写入 sync.config.json 失败: ' + e.message }); }
    });
    return;
  }

  // —— 飞书扫码授权（OAuth 授权码模式）——
  // 扫码拿到的是 user_access_token（带 drive/docx scope），以「用户身份」读写用户自己的云盘/文档。
  // 凭证只存本机 sync.oauth.json（gitignored），绝不进浏览器；浏览器只与本服务通信。
  const feishuOauth = (() => { try { return require('./feishu-oauth.js'); } catch (e) { return null; } })();
  if (req.method === 'POST' && pathname === '/api/feishu/oauth/start') {
    let discarded = 0; // 本接口不再接收 body，只丢弃
    req.on('data', (c) => { discarded += c.length; if (discarded > 1024) req.destroy(); });
    req.on('end', () => {
      if (!feishuOauth) return send(res, 500, { error: 'feishu-oauth.js 未找到' });
      try {
        const r = feishuOauth.buildAuthorizeUrl({ redirect_uri: undefined });
        return send(res, 200, { ok: true, authorizeUrl: r.url, state: r.state, redirect_uri: r.redirect_uri });
      } catch (e) { return send(res, 400, { error: e.message }); }
    });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/feishu/oauth/callback') {
    // 飞书授权成功后的回调：收 code，换 user_access_token 存本机，然后回一个可自动关闭的页面
    const u = new URL(req.url, 'http://localhost');
    const code = u.searchParams.get('code') || '';
    const state = u.searchParams.get('state') || '';
    const redirectUri = 'http://127.0.0.1:' + PORT + '/api/feishu/oauth/callback';
    (async () => {
      if (!feishuOauth) return send(res, 500, { error: 'feishu-oauth.js 未找到' });
      if (!code) {
        const err = u.searchParams.get('error') || '未收到授权码';
        return send(res, 400, { error: '授权失败：' + err });
      }
      try {
        await feishuOauth.exchangeCode(code, redirectUri);
        // 回调页：极简、自动提示成功（凭证已落本机，页面不展示任何 token）
        return send(res, 200,
          '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>授权成功</title></head>' +
          '<body style="font-family:sans-serif;background:#fff;color:#1a1a1a;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">' +
          '<div style="text-align:center;"><h2 style="margin:0 0 8px;">✓ 飞书授权成功</h2>' +
          '<p style="color:#6b6b6b;margin:0 0 16px;">已绑定你的飞书账号，可关闭本页返回编辑器。</p>' +
          '<script>setTimeout(function(){try{window.close();}catch(e){}} ,1500);<\/script>' +
          '</div></body></html>', 'text/html; charset=utf-8');
      } catch (e) {
        return send(res, 502, { error: '换取用户凭证失败：' + e.message });
      }
    })();
    return;
  }
  if (req.method === 'GET' && pathname === '/api/feishu/oauth/status') {
    if (!feishuOauth) return send(res, 500, { error: 'feishu-oauth.js 未找到' });
    return send(res, 200, { status: feishuOauth.status() });
  }
  // 解除扫码授权：删除本机 sync.oauth.json，同步链路回退应用身份（tenant token）
  if (req.method === 'POST' && pathname === '/api/feishu/oauth/revoke') {
    if (!feishuOauth) return send(res, 500, { error: 'feishu-oauth.js 未找到' });
    feishuOauth.clearOauth();
    return send(res, 200, { ok: true });
  }

  // —— 飞书「个人应用」扫码注册（Device Flow）——
  // 用户用手机飞书扫码 → 飞书为其创建一个 PersonalAgent（个人应用）并授权 →
  // 本服务轮询拿到 client_id / client_secret（即 app_id / app_secret）自动写入 sync.config.json。
  // 与 OAuth 授权码模式（拿到 user_access_token）不同，这里拿到的是「应用身份」凭证，
  // 同步链路 getAuth() 在无非 user OAuth 时即回退到该 tenant token。
  const feishuRegister = (() => { try { return require('./feishu-register.js'); } catch (e) { return null; } })();
  // begin：发起设备授权，建会话，返回二维码 URL + user_code
  if (req.method === 'POST' && pathname === '/api/feishu/register/begin') {
    req.on('data', (c) => { if (c.length > 1024) req.destroy(); }); // 本接口不读 body
    req.on('end', async () => {
      if (!feishuRegister) return send(res, 500, { error: 'feishu-register.js 未找到' });
      try {
        const r = await feishuRegister.beginRegistration({});
        const token = crypto.randomBytes(16).toString('hex');
        registerSessions.set(token, {
          device_code: r.device_code,
          domain: r.domain,
          larkDomain: r.larkDomain,
          domainSwitched: false,
          interval: r.interval,           // 秒
          expires_in: r.expires_in,       // 秒
          createdAt: Date.now(),
          lastPollAt: 0,
          lastResult: { status: 'waiting' }
        });
        return send(res, 200, { ok: true, token, qrUrl: r.qrUrl, userCode: r.user_code, expireIn: r.expires_in });
      } catch (e) { return send(res, 502, { error: e.message }); }
    });
    return;
  }
  // poll：用 token 轮询扫码终态；成功时把 app_id / app_secret 写入 sync.config.json 并自动探测绑定
  if (req.method === 'GET' && pathname === '/api/feishu/register/poll') {
    if (!feishuRegister) return send(res, 500, { error: 'feishu-register.js 未找到' });
    const token = u.searchParams.get('token') || '';
    const sess = registerSessions.get(token);
    if (!sess) return send(res, 404, { error: '会话不存在或已过期，请重新发起扫码' });
    // 过期判定：超出 expires_in + 60s 缓冲即视为过期
    if (Date.now() - sess.createdAt > (sess.expires_in + 60) * 1000) {
      registerSessions.delete(token);
      return send(res, 200, { status: 'expired' });
    }
    // 节流：尊重飞书返回的 interval（min），避免前端快轮询把飞书打爆；slow_down 时 interval 已 +5s
    const minGap = Math.max(sess.interval - 1, 1) * 1000;
    if (sess.lastResult.status === 'success' || sess.lastResult.status === 'failed' || sess.lastResult.status === 'expired') {
      return send(res, 200, sess.lastResult); // 终态直接返回缓存，不再打飞书
    }
    if (Date.now() - sess.lastPollAt < minGap) {
      return send(res, 200, sess.lastResult); // 未到间隔，返回上次结果
    }
    (async () => {
      try {
        const r = await feishuRegister.pollRegistration(sess.device_code, sess);
        sess.lastPollAt = Date.now();
        if (r.status === 'slow_down') { sess.interval += 5; sess.lastResult = { status: 'waiting' }; return send(res, 200, { status: 'waiting' }); }
        if (r.status === 'waiting') { sess.lastResult = r; return send(res, 200, r); }
        if (r.status === 'success') {
          sess.lastResult = { status: 'success', appId: r.client_id, appSecret: r.client_secret };
          registerSessions.delete(token); // 凭证已落盘，会话作废
          // 1) 写入应用身份凭证（合并进 sync.config.json，不覆盖其它字段）
          if (feishuSync) feishuSync.writeConfig({ app_id: r.client_id, app_secret: r.client_secret });
          // 2) 自动探测绑定：验证凭证 + 建默认文件夹 + 回填 domain/doc 默认值（失败不致命，可手动重试）
          let probe = null;
          if (feishuSync) {
            try { probe = await feishuSync.probe(r.client_id, r.client_secret); }
            catch (e) { probe = { error: e.message }; }
          }
          return send(res, 200, {
            status: 'success',
            appId: r.client_id,
            appSecret: r.client_secret,
            probe: probe
          });
        }
        // failed / expired
        sess.lastResult = r;
        registerSessions.delete(token);
        return send(res, 200, r);
      } catch (e) {
        return send(res, 502, { error: e.message });
      }
    })();
    return;
  }
  // cancel：提前作废会话（用户主动关闭二维码）
  if (req.method === 'POST' && pathname === '/api/feishu/register/cancel') {
    const token = u.searchParams.get('token') || '';
    if (token) registerSessions.delete(token);
    return send(res, 200, { ok: true });
  }

  // —— PDF 简历解析：接收 PDF 字节（base64），用 vendored pdf.js 提取文本并尽力结构化 ——
  if (req.method === 'POST' && pathname === '/api/pdf/parse') {
    const pdfParse = (() => { try { return require('./pdf-parse.js'); } catch (e) { return null; } })();
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 30 * 1024 * 1024) req.destroy(); }); // PDF 上限 30MB
    req.on('end', async () => {
      if (!pdfParse) return send(res, 500, { error: 'pdf-parse.js 未找到' });
      let body;
      try { body = JSON.parse(buf); } catch (e) { return send(res, 400, { error: 'JSON 解析失败' }); }
      const b64 = body && (body.base64 || body.data);
      if (!b64) return send(res, 400, { error: '缺少 base64 PDF 数据' });
      let bytes;
      try { bytes = Buffer.from(b64, 'base64'); } catch (e) { return send(res, 400, { error: 'base64 解码失败' }); }
      if (bytes.slice(0, 5).toString('latin1') !== '%PDF-') {
        return send(res, 400, { error: '文件不是合法的 PDF' });
      }
      try {
        const r = await pdfParse.parsePdfToResume(bytes);
        return send(res, 200, {
          ok: true,
          resume: r.resume,
          pageCount: r.pdf.pageCount,
          textLength: (r.pdf.text || '').length
        });
      } catch (e) {
        return send(res, 502, { error: 'PDF 解析失败：' + (e.message || e).toString().slice(0, 300) });
      }
    });
    return;
  }

  // —— AI 转发层（SSE 透传 OpenAI 兼容协议；Key 只在本服务内存与 ai.config.json，不进浏览器）——
  const aiProxy = (() => { try { return require('./ai-proxy.js'); } catch (e) { return null; } })();
  if (req.method === 'GET' && pathname === '/api/ai/status') {
    if (!aiProxy) return send(res, 500, { error: 'ai-proxy.js 未找到' });
    return send(res, 200, aiProxy.status());
  }
  if (req.method === 'POST' && pathname === '/api/ai/test') {
    if (!aiProxy) return send(res, 500, { error: 'ai-proxy.js 未找到' });
    (async () => {
      try { const r = await aiProxy.test(); return send(res, 200, r); }
      catch (e) { return send(res, 502, { ok: false, error: e.message }); }
    })();
    return;
  }
  if (req.method === 'POST' && pathname === '/api/ai/chat') {
    if (!aiProxy) return send(res, 500, { error: 'ai-proxy.js 未找到' });
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 2 * 1024 * 1024) req.destroy(); }); // AI 请求体上限 2MB
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(buf); } catch (e) { return send(res, 400, { error: 'JSON 解析失败' }); }
      try { await aiProxy.chat(req, res, body); }
      catch (e) {
        if (!res.headersSent) return send(res, 502, { error: e.message });
        try { res.end(); } catch (_) {}
      }
    });
    return;
  }

  // —— 静态文件（GET / HEAD）——
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { error: 'Method Not Allowed' });
  }
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(ROOT, rel));
  // 路径穿越防护：解析后的绝对路径必须仍在 ROOT 之内
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    return send(res, 403, { error: 'Forbidden' });
  }
  /* 数据隔离加固：本服务既是静态服务器又持有敏感文件，必须拒绝把它们当静态资源吐出去。
     仅本机回环可访问时普通网页读不到响应体，但本机其他进程 / 页面仍可 fetch 到，
     因此凭证类文件（sync.config.json / sync.oauth.json / sync.state.json / ai.config.json）
     一律 403；隐藏文件（.git / .workbuddy / 各类 dotfile）也拒绝。
     data/resume.json 是编辑器实时读写的私有数据源，保留可访问（gitignored、不进公开仓库）。 */
  const SENSITIVE_BASENAMES = new Set(['sync.config.json', 'sync.state.json', 'sync.oauth.json', 'ai.config.json', 'keystore.properties']);
  /* 敏感「目录」级拦截：android-signing/ 存放 Android 签名密钥库与明文口令文件，
     目录名不带点、单个文件名也难穷举，按 basename 黑名单拦不住，必须整目录拒绝。 */
  const SENSITIVE_DIRS = new Set(['android-signing']);
  const relPath = path.relative(ROOT, filePath);
  const relNorm = relPath.split(path.sep).join('/');
  if (SENSITIVE_BASENAMES.has(path.basename(relNorm))) {
    return send(res, 403, { error: 'Forbidden' });
  }
  if (SENSITIVE_DIRS.has(relNorm.split('/')[0])) {
    return send(res, 403, { error: 'Forbidden' });
  }
  if (relNorm.split('/').some(seg => seg.startsWith('.'))) {
    return send(res, 403, { error: 'Forbidden' });
  }
  fs.readFile(filePath, (err, content) => {
    if (err) return send(res, 404, { error: 'Not Found' });
    const ext = path.extname(filePath).toLowerCase();
    /* 静态资源一律禁用缓存：本机开发服务器没有性能顾虑，但没有 Cache-Control / ETag 时
       浏览器会命中启发式缓存，导致「代码改了、刷新后界面没变」，让人误判改动没落地。
       加上 no-store 后，改完 css/js 普通刷新即可生效（无需强制刷新）。 */
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0'
    };
    if (req.method === 'HEAD') { res.writeHead(200, headers); return res.end(); }
    res.writeHead(200, headers);
    res.end(content);
  });
});

// 仅监听本机回环地址，避免同网段可读到 data/resume.json / 飞书凭证（修复原先监听 0.0.0.0 的隐患）
server.listen(PORT, '127.0.0.1', () => {
  console.log('简历编辑器已启动 → http://localhost:' + PORT);
  console.log('· 编辑器内的每次编辑会自动写回 data/resume.json（实时保存，刷新不丢）');
  console.log('· 若用 file:// 或 python -m http.server 打开，浏览器无法写回，编辑仅存本浏览器本地');
  console.log('· 飞书同步：工具栏「飞书同步」菜单 → 上报 / 恢复 / 同步配置（配置表单写入 sync.config.json）');
});
