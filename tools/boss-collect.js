#!/usr/bin/env node
/**
 * boss-collect.js —— 从「已登录 BOSS 直聘的 Chrome」采集 IM 聊天记录
 *
 * 原理：Chrome 以 --remote-debugging-port=9222 启动（使用你自己的登录档案）后，
 * 通过 Chrome DevTools Protocol（CDP）连接，读取聊天页 DOM 并抽取消息气泡。
 * Node 22+ 自带全局 WebSocket，零额外依赖。
 *
 * 用法：
 *   node tools/boss-collect.js --port 9222 --company "平安银行"
 *   node tools/boss-collect.js --selftest          # 仅验证 CDP 连通性
 *
 * 输出：stdout 打印 JSON —— { ok, messages:[{role,name,timeText,text}], hint, title, url }
 *
 * 前提（重要）：需要在「你自己的登录档案」上开远程调试端口。若你的 Chrome 已在运行，
 * 需先完全退出，再用如下方式启动（macOS）：
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-boss-profile"
 * 首次会要求扫码登录 BOSS；之后每次聊天即可被采集。
 */
'use strict';

const http = require('http');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

const PORT = Number(arg('port', process.env.CDP_PORT || 9222));
const COMPANY = (arg('company', '') || '').toString();
const SELFTEST = !!arg('selftest', false);
const URL_ARG = (arg('url', '') || '').toString(); // 调试用：直接指定要抽取的页面
const TIMEOUT_MS = Number(arg('timeout', 15000));

function httpJson(pathname, method) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: pathname, method: method || 'GET',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(buf ? JSON.parse(buf) : null); }
        catch (e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => { req.destroy(new Error('connect timeout')); });
    req.end();
  });
}

/* 建立到某个 target 的 CDP 会话，返回 send(method, params) */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(wsUrl); }
    catch (e) { return reject(e); }

    let seq = 0;
    const pending = new Map();
    const timer = setTimeout(() => {
      try { ws.close(); } catch (e) {}
      reject(new Error('CDP 连接超时'));
    }, TIMEOUT_MS);

    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({
        send(method, params) {
          return new Promise((res, rej) => {
            const id = ++seq;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params: params || {} }));
          });
        },
        close() { try { ws.close(); } catch (e) {} }
      });
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); }
      catch (e) { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message || 'CDP error'));
        else p.res(msg.result);
      }
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP WebSocket 错误')); });
  });
}

/* 页面内执行的抽取函数（字符串，交给 Runtime.evaluate） */
const EXTRACT_FN = `(function(){
  function clean(s){ return (s||'').replace(/\\s+/g,' ').trim(); }
  var sels = [
    '.chat-message-list li', '.message-list li', '.chat-content .item',
    '[class*="message-item"]', '[class*="chat-item"]', '[class*="msg-item"]',
    '.dialog-list li', '[class*="message"][class*="list"] > *'
  ];
  var nodes = [];
  for (var i=0;i<sels.length;i++){
    var ns = document.querySelectorAll(sels[i]);
    if (ns && ns.length) { nodes = [].slice.call(ns); break; }
  }
  if (!nodes.length) {
    return { messages: [], hint: 'no-message-nodes', title: document.title, url: location.href };
  }
  var out = [];
  nodes.forEach(function(el){
    var cls = ((el.className||'') + ' ' + ((el.parentElement&&el.parentElement.className)||'')).toString();
    var self = /self|myself|right|mine|\\bme\\b/i.test(cls) && !/friend|other|left|them/i.test(cls);
    var nameEl = el.querySelector('[class*="name"],[class*="nick"],[class*="title"]');
    var timeEl = el.querySelector('[class*="time"],[class*="date"]');
    var bodyEl = el.querySelector('[class*="content"],[class*="text"],[class*="bubble"]') || el;
    var text = clean(bodyEl.innerText);
    if (!text) return;
    out.push({
      role: self ? 'me' : 'hr',
      name: nameEl ? clean(nameEl.innerText) : '',
      timeText: timeEl ? clean(timeEl.innerText) : '',
      text: text
    });
  });
  return { messages: out, hint: out.length ? 'ok' : 'empty', title: document.title, url: location.href };
})()`;

async function main() {
  // 1) 探测远程调试端口
  let list;
  try {
    list = await httpJson('/json/list');
  } catch (e) {
    return output({
      ok: false,
      messages: [],
      hint: '无法连接 127.0.0.1:' + PORT + '。请用你的登录档案启动 Chrome 并加 --remote-debugging-port=' + PORT + '（详见脚本顶部说明）。'
    });
  }
  if (!Array.isArray(list)) {
    return output({ ok: false, messages: [], hint: '远程调试端口未返回目标列表（可能启动方式不正确）。' });
  }

  if (SELFTEST) {
    return output({ ok: true, messages: [], hint: 'CDP 已连通，共 ' + list.length + ' 个标签页。' });
  }

  // 2) 选一个 BOSS 聊天标签页；没有则尝试新开
  const pages = list.filter((t) => t.type === 'page' && t.url);
  let target;
  if (URL_ARG) {
    // 调试：定位（或新开）指定页面
    target = pages.filter((t) => t.url.indexOf(URL_ARG) >= 0)[0];
    if (!target) {
      try { target = await httpJson('/json/new?' + encodeURIComponent(URL_ARG), 'PUT'); } catch (e) {}
    }
  } else {
    target = pages.filter((t) => /zhipin\.com/.test(t.url))[0];
    if (!target) {
      // 打开 BOSS 聊天页
      const openUrl = 'https://www.zhipin.com/web/geek/chat';
      try { target = await httpJson('/json/new?' + encodeURIComponent(openUrl), 'PUT'); } catch (e) {}
    }
  }
  if (!target) {
    return output({
      ok: false, messages: [],
      hint: URL_ARG
        ? '无法定位/新开指定页面：' + URL_ARG
        : '未找到 BOSS 直聘标签页，且无法自动新开。请先在 Chrome 中打开 BOSS 聊天页。'
    });
  }
  if (!target.webSocketDebuggerUrl) {
    return output({ ok: false, messages: [], hint: '目标标签页不可调试（webSocketDebuggerUrl 缺失）。' });
  }

  // 3) 连接并抽取
  const conn = await connect(target.webSocketDebuggerUrl);
  try {
    await conn.send('Runtime.enable');
    const r = await conn.send('Runtime.evaluate', {
      expression: EXTRACT_FN,
      returnByValue: true,
      awaitPromise: true
    });
    const val = (r && r.result && r.result.value) || { messages: [], hint: 'no-result' };
    const messages = Array.isArray(val.messages) ? val.messages : [];
    let hint = val.hint || '';
    if (val.hint === 'no-message-nodes') {
      hint = '已连接页面但未识别到聊天消息节点（页面结构可能已变，或当前不是聊天详情页）。可把聊天截图发我，我帮你整理。';
    } else if (val.hint === 'empty') {
      hint = '聊天区为空。请先在 Chrome 中打开与该公司 HR 的对话。';
    }
    output({
      ok: messages.length > 0,
      messages: messages,
      hint: hint,
      title: val.title || '',
      url: val.url || target.url || '',
      company: COMPANY
    });
  } finally {
    conn.close();
  }
}

function output(obj) {
  process.stdout.write(JSON.stringify(obj));
}

const hardTimer = setTimeout(() => {
  output({ ok: false, messages: [], hint: '采集超时（' + TIMEOUT_MS + 'ms）。' });
  process.exit(0);
}, TIMEOUT_MS + 4000);

main().then(() => { clearTimeout(hardTimer); process.exit(0); })
  .catch((e) => {
    clearTimeout(hardTimer);
    output({ ok: false, messages: [], hint: '采集异常：' + (e && e.message ? e.message : e) });
    process.exit(0);
  });
