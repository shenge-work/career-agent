/* =============================================================
 * 飞书同步 / 扫码授权 / 个人应用注册 / 简历文件导入
 * -------------------------------------------------------------
 * 从 js/app.js 物理拆分。经 window.RB 桥接回 app.js 的内部函数与状态；
 * 依赖全局 ResumeStore / ResumeLibrary / qrcode（vendor）与全局 data。
 * 挂 window.ResumeFeishu 供 app.js 解构复用。
 * ============================================================= */
(function(global){
"use strict";

/* ============ 飞书同步：上报 / 同步拉取 / 从飞书恢复版本 ============ */
function showFeishuStatus(msg){
  const el = document.getElementById('feishuStatus');
  if (el) el.textContent = msg;
  const m = document.getElementById('feishuStatusMobile');
  if (m) m.textContent = msg;
}
/* 当前激活简历 id（'default' 兼容旧单份简历） */
function activeResumeId(){
  return (typeof ResumeEditor.getActiveResumeId === 'function') ? (ResumeEditor.getActiveResumeId() || 'default') : 'default';
}
/* 忙碌态按钮组：批量置灰 + 文案，完成/失败后还原 */
const SYNC_BUTTON_IDS = ['feishuReportBtn', 'setReportBtn', 'feishuPullBtn', 'setPullBtn', 'feishuPullBtnMobile'];
function setSyncButtonsBusy(busy, busyText){
  const t = busyText || '处理中…';
  SYNC_BUTTON_IDS.forEach(id => {
    const el = document.getElementById(id);
    if(!el) return;
    el.disabled = busy;
    el.classList.toggle('busy', busy);
    if(busy) el.setAttribute('data-idle-text', el.textContent);
    el.textContent = busy ? t : (el.getAttribute('data-idle-text') || el.textContent);
  });
}
/* 手动上报：把当前 {data,fonts,spacing,v} 推送到飞书（文档 docx + 云盘文件 resume.json，双写） */
async function reportToFeishu(){
  setSyncButtonsBusy(true, '上报中…');
  showFeishuStatus('正在上报到飞书…');
  try {
    const payload = RB.currentPayload();
    // 注入简历 id 和姓名，后端按此分文件存储
    payload.id = activeResumeId();
    payload.name = (payload.data && payload.data.name) ? payload.data.name : '简历';
    const j = await ResumeStore.push(payload);
    const when = new Date().toLocaleTimeString();
    const tail = j.dryRun ? '（dry-run，未真实写入）' : (j.docUrl ? (' · ' + j.docUrl) : '');
    const idTag = j.authMode === 'user' ? '（扫码授权 · 用户身份）' : '（应用身份）';
    showFeishuStatus('✓ 已上报到飞书' + idTag + ' · ' + when + tail);
    // 手动推送成功后，把本地 hash 记入基线，避免自动同步下一轮立即重复推送
    // （口径必须是 contentHash：只看内容，剔除 savedAt/id/name）
    try {
      const aid = activeResumeId();
      const st = await loadAutoSyncState();
      if (!st[aid]) st[aid] = {};
      st[aid].lastPushedHash = contentHash(payload);
      st[aid].skipNextPull = true;
      saveAutoSyncState(st);
    } catch (e) {}
  } catch (e) {
    showFeishuStatus('✗ 上报失败：' + e.message);
  } finally {
    setSyncButtonsBusy(false);
  }
}
/* 同步拉取：把飞书云端最新版本拉下来，覆盖当前编辑器内容（可撤销） */
async function pullFromFeishu(){
  const id = activeResumeId();
  if(!confirm('将从飞书拉取「' + (id === 'default' ? '默认简历' : '当前简历') + '」的最新版本，覆盖当前编辑器内容（可用撤销 Ctrl/Cmd+Z 回退），确定继续？')) return;
  setSyncButtonsBusy(true, '拉取中…');
  showFeishuStatus('正在从飞书拉取最新版本…');
  try {
    const obj = await ResumeStore.pull(id);
    RB.recordHistory('action', '从飞书恢复');
    RB.applyDataPayload(obj);
    showFeishuStatus('✓ 已从飞书拉取最新版本');
    await markManualPullBaseline(obj);
  } catch (e) {
    showFeishuStatus('✗ 拉取失败：' + e.message);
    safeNotify('error', '拉取失败', e.message);
  } finally {
    setSyncButtonsBusy(false);
  }
}
/* 恢复指定飞书版本：下载该版本 JSON 并覆盖式应用（可撤销） */
async function restoreFromFeishu(versionId){
  if(!confirm('将从飞书恢复该版本，覆盖当前编辑器内容（可用撤销 Ctrl/Cmd+Z 回退），确定继续？')) return;
  const id = activeResumeId();
  showFeishuStatus('正在从飞书恢复…');
  try {
    const obj = await ResumeStore.restore(versionId, id);
    RB.recordHistory('action', '从飞书恢复');
    RB.applyDataPayload(obj);
    showFeishuStatus('✓ 已从飞书恢复该版本');
    await markManualPullBaseline(obj);
    return true;
  } catch (e) {
    showFeishuStatus('✗ 恢复失败：' + e.message);
    safeNotify('error', '恢复失败', e.message);
    return false;
  }
}

/* ============ 工具栏菜单 / 飞书配置表单 ============ */
/* 菜单按钮：悬停即展开（CSS :hover）；点击可固定展开，点其他区域收起 */
function toggleMenu(btn){
  const m = btn.closest('.menu');
  const wasOpen = m.classList.contains('open');
  document.querySelectorAll('.toolbar .menu.open').forEach(x => x.classList.remove('open'));
  if (!wasOpen) m.classList.add('open');
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.toolbar .menu')) {
    document.querySelectorAll('.toolbar .menu.open').forEach(x => x.classList.remove('open'));
  }
});

/* 打开飞书配置表单：回填现有配置（Secret 永不回传，只提示「已设置」） */
async function openFeishuConfig(){
  try {
    const cfg = await ResumeStore.loadConfig();
    const c = cfg || {};
    document.getElementById('cfgAppId').value = c.app_id || '';
    const secretInput = document.getElementById('cfgAppSecret');
    secretInput.value = '';
    secretInput.placeholder = c.hasSecret ? '已设置，留空表示不修改' : '首次配置必填';
    document.getElementById('cfgDomain').value = c.domain || '';
    document.getElementById('cfgFolder').value = c.folder_token || '';
    document.getElementById('cfgDocTitle').value = c.doc_title || '';
    document.getElementById('cfgFileName').value = c.file_name || '';
    document.getElementById('cfgDryRun').checked = !!c.dryRun;
  } catch (e) { /* 非本地服务打开（file:// 等）或原生桥异常，表单留空即可 */ }
  /* 配置表单已内联到设置页（#/settings），无需再显示 modal */
  checkFeishuOauthStatus();
}
function closeFeishuConfig(){ /* modal 已内联到设置页，无需关闭 */ }
/* 保存配置：经本地服务写入 sync.config.json（凭证不进 localStorage / 简历数据） */
async function saveFeishuConfig(){
  const btn = document.getElementById('cfgSaveBtn');
  if (btn){ btn.disabled = true; btn.textContent = '保存中…'; }
  try {
    const body = {
      app_id: document.getElementById('cfgAppId').value,
      app_secret: document.getElementById('cfgAppSecret').value,
      domain: document.getElementById('cfgDomain').value,
      folder_token: document.getElementById('cfgFolder').value,
      doc_title: document.getElementById('cfgDocTitle').value,
      file_name: document.getElementById('cfgFileName').value,
      dryRun: document.getElementById('cfgDryRun').checked
    };
    const j = await ResumeStore.saveConfig(body);
    closeFeishuConfig();
    showFeishuStatus(j.configured ? '✓ 飞书配置已保存，可以「上报到飞书」了' : '✓ 配置已保存（未完整配置，仅 dry-run 可用）');
  } catch (e) {
    showFeishuStatus('✗ 配置保存失败：' + e.message);
  } finally {
    if (btn){ btn.disabled = false; btn.textContent = '保存配置'; }
  }
}

/* 一键绑定：验证凭证 + 自动建「简历数据」文件夹 + 回填默认项（M3）
   只读表单里的 app_id + app_secret，其余全部由后端 probe 自动探测回填。 */
async function probeFeishuConfig(){
  const btn = document.getElementById('cfgProbeBtn');
  const status = document.getElementById('cfgProbeStatus');
  let appId = document.getElementById('cfgAppId').value.trim();
  let appSecret = document.getElementById('cfgAppSecret').value.trim();
  // 表单留空时回退用已保存凭证（扫码注册后表单 Secret 为空，但仍可走探测绑定）
  if(!appId || !appSecret){
    try{
      const cfg = await ResumeStore.loadConfig();
      if(!appId) appId = (cfg && cfg.app_id) || '';
      if(!appSecret) appSecret = (cfg && cfg.hasSecret) ? '__USE_SAVED__' : '';
    }catch(e){}
  }
  const show = (ok, msg) => {
    if (!status) return;
    status.style.display = 'block';
    status.style.background = ok ? '#eef7ee' : '#fdeeee';
    status.style.border = '1px solid ' + (ok ? '#cde6cd' : '#f3cccc');
    status.style.color = ok ? '#1a6b1a' : '#a33';
    status.textContent = msg;
  };
  if (!appId || !appSecret) {
    show(false, '请先填写 App ID 和 App Secret，或先「扫码注册个人应用」自动保存凭证后再探测。');
    return;
  }
  if (btn){ btn.disabled = true; btn.textContent = '探测中…'; }
  show(true, '正在验证凭证并创建「简历数据」文件夹…');
  try {
    const r = await ResumeStore.probe({ app_id: appId, app_secret: appSecret === '__USE_SAVED__' ? '' : appSecret });
    // 回填默认项到表单
    if (r.folder_token) document.getElementById('cfgFolder').value = r.folder_token;
    if (r.doc_title) document.getElementById('cfgDocTitle').value = r.doc_title;
    if (r.file_name) document.getElementById('cfgFileName').value = r.file_name;
    if (r.domain) document.getElementById('cfgDomain').value = r.domain;
    show(true, '✓ 凭证有效，已自动创建「简历数据」文件夹并回填默认项。检查无误后点「保存配置」完成绑定。');
  } catch (e) {
    show(false, '✗ 探测失败：' + (e && e.message ? e.message : e) + '（请核对 App ID / App Secret 与应用权限）');
  } finally {
    if (btn){ btn.disabled = false; btn.textContent = '自动探测并绑定'; }
  }
}

/* ============ 飞书连接（合并：扫码授权 OAuth + 扫码注册个人应用） ============
   单一入口「连接飞书」：
       1) 直接调 /api/feishu/oauth/start 发起扫码授权（应用凭证已配置时，只扫一个码）
       2) 若后端提示缺少应用凭证 → 自动先走「扫码注册个人应用」，
          注册成功（后端已自动保存 app_id/app_secret 并探测绑定）后再发起扫码授权，
          一条流程、两个二维码、零表单，一气呵成。
   授权：用户扫码 → 飞书回调本地 /api/feishu/oauth/callback 存 user_access_token
        → 前端轮询 /api/feishu/oauth/status 检测到 authorized 即成功。
   凭证只存本机 sync.oauth.json / sync.config.json（gitignored），绝不进浏览器。 */
/* 本地服务 API 薄封装（浏览器模式；file:// 或非 npm start 打开时 fetch 失败，友好提示） */
function localApi(method, path, body){
  if(typeof fetch !== 'function') return Promise.reject(new Error('当前环境不支持网络请求，请用 npm start 打开'));
  return fetch(path, {
    method: method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(r => r.json().then(j => {
    if(!r.ok) throw new Error(j && j.error ? j.error : ('HTTP ' + r.status));
    return j;
  }));
}
/* 打开设置页时检查连接状态，回显 */
async function checkFeishuOauthStatus(){
  try{
    const j = await localApi('GET', '/api/feishu/oauth/status');
    renderOauthStatus(j && j.status);
  }catch(e){ /* 未连本地服务时静默，状态留空 */ }
}
function renderOauthStatus(st){
  const el = document.getElementById('oauthStatus');
  const connectBtn = document.getElementById('oauthStartBtn');
  const revokeBtn = document.getElementById('revokeOauthBtn');
  if(el){
    if(st && st.authorized){
      const t = st.updated_at ? new Date(st.updated_at).toLocaleString() : '';
      el.innerHTML = '✓ 已连接飞书（用户身份）' + (t ? ' · ' + t : '') + '，可直接「上报到飞书」读写你的云盘/文档';
      el.style.color = '#1a6b1a';
    } else {
      el.textContent = '尚未连接飞书。点击「连接飞书」，扫码完成应用注册与授权（一气呵成，无需填写任何配置）。';
      el.style.color = '#6b6b6b';
    }
  }
  if(connectBtn) connectBtn.style.display = (st && st.authorized) ? 'none' : 'inline-block';
  if(revokeBtn) revokeBtn.style.display = (st && st.authorized) ? 'inline-block' : 'none';
}
/* 发起「连接飞书」：应用凭证缺失时先扫码注册个人应用，成功后自动继续扫码授权（一气呵成） */
async function startFeishuOauth(){
  const btn = document.getElementById('oauthStartBtn');
  const el = document.getElementById('oauthStatus');
  if(btn){ btn.disabled = true; btn.textContent = '连接中…'; }
  if(el){ el.textContent = '正在准备授权…'; el.style.color = '#6b6b6b'; }
  try{
    let j;
    try{
      j = await localApi('POST', '/api/feishu/oauth/start', {});
    }catch(e0){
      const msg = e0 && e0.message ? e0.message : String(e0);
      // 缺少应用凭证 → 先扫码注册个人应用（后端自动保存并探测绑定），成功后继续授权
      if(!/尚未配置|缺少 App ID/.test(msg)) throw e0;
      if(el){ el.textContent = '检测到尚未配置飞书应用，先扫码创建个人应用（第 1 步）…'; }
      feishuRegAutoOauth = true;
      const registered = await startFeishuRegister();
      if(!registered) return; // 注册失败 / 已取消，状态已在卡片中展示
      j = await localApi('POST', '/api/feishu/oauth/start', {});
    }
    if(el){ el.textContent = '第 2 步：请在飞书授权页用手机扫码，并点「允许」授权'; }
    // 新窗口打开飞书授权页（页内自带二维码）；授权后飞书会回调本地存凭证
    const w = window.open(j.authorizeUrl, '_blank', 'width=480,height=640');
    if(!w){
      // 弹窗被拦截：退化为同页跳转（授权完成后返回本页即自动识别）
      window.location.href = j.authorizeUrl;
    }
    // 开始轮询授权状态（授权完成后回调页存好凭证，这里轮询到即更新）
    pollOauthUntilDone();
  }catch(e){
    if(el){ el.textContent = '✗ 连接失败：' + (e && e.message ? e.message : e); el.style.color = '#a33'; }
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = '连接飞书'; }
  }
}
/* 轮询授权状态，最多 3 分钟（授权页用户操作需要时间） */
function pollOauthUntilDone(){
  const el = document.getElementById('oauthStatus');
  let tries = 0;
  const timer = setInterval(async () => {
    tries++;
    try{
      const j = await localApi('GET', '/api/feishu/oauth/status');
      if(j && j.status && j.status.authorized){
        clearInterval(timer);
        renderOauthStatus(j.status);
        return;
      }
    }catch(e){ /* 静默 */ }
    if(tries >= 90){ // 90 × 2s = 3 分钟
      clearInterval(timer);
      if(el){ el.textContent = '尚未检测到授权（可完成扫码后稍候，或重新点「连接飞书」）'; el.style.color = '#6b6b6b'; }
    }
  }, 2000);
}
/* 手动刷新授权状态（保留接口，界面已不放置该按钮） */
async function refreshFeishuOauth(){
  const el = document.getElementById('oauthStatus');
  if(el){ el.textContent = '正在检查…'; el.style.color = '#6b6b6b'; }
  try{
    const j = await localApi('GET', '/api/feishu/oauth/status');
    renderOauthStatus(j && j.status);
  }catch(e){
    if(el){ el.textContent = '✗ 检查失败：' + (e && e.message ? e.message : e); el.style.color = '#a33'; }
  }
}
/* 断开连接：删除本机 sync.oauth.json，同步链路回退应用身份 */
async function revokeFeishuOauth(){
  if(!confirm('确定断开飞书连接吗？断开后「上报到飞书」将回退到应用身份（App Secret 方式）读写。')) return;
  try{
    await localApi('POST', '/api/feishu/oauth/revoke', {});
    renderOauthStatus(null);
    showFeishuStatus('✓ 已断开飞书连接');
  }catch(e){
    showFeishuStatus('✗ 断开失败：' + (e && e.message ? e.message : e));
  }
}

/* ============ 飞书「个人应用」扫码注册（Device Flow，拿到 app_id / app_secret） ============
   由「连接飞书」在缺少应用凭证时自动触发，也可独立调用：
       后端 /api/feishu/register/begin 发起设备授权，返回二维码 URL
       → 浏览器用 qrcode-generator 把 URL 渲染成二维码
       → 用户手机飞书扫码并确认 → 飞书后台创建 PersonalAgent（个人应用）
       → 前端轮询 /api/feishu/register/poll → 成功即拿到 app_id/app_secret，后端已自动保存并探测绑定。
   凭证只在本地 serve.js 写 sync.config.json，绝不进浏览器。
   通过 Promise 完成回调供「连接飞书」串联：注册成功后自动继续扫码授权。 */
let feishuRegToken = null;
let feishuRegTimer = null;
let feishuRegResolve = null;     // 注册流程 Promise 完成回调（true=成功，false=失败/取消）
let feishuRegAutoOauth = false;  // 是否由「连接飞书」自动触发（注册成功即继续授权）

function finishFeishuRegister(ok){
  feishuRegAutoOauth = false;
  if(feishuRegResolve){ const r = feishuRegResolve; feishuRegResolve = null; r(!!ok); }
}

/* 把二维码 URL 渲染成图片；qrcode-generator 的 qrcode 全局由 vendor/qrcode-generator.js 提供。
   渲染失败（库未加载）时降级为可点击链接，仍可完成扫码/确认。 */
function renderRegisterQr(qrUrl){
  const wrap = document.getElementById('regQrWrap');
  const box = document.getElementById('regQr');
  if(!wrap || !box) return;
  wrap.style.display = 'block';
  box.innerHTML = '';
  try {
    const qr = qrcode(0, 'M');            // 0 = 自动选版本；M = 中等纠错
    qr.addData(qrUrl);
    qr.make();
    box.innerHTML = qr.createImgTag(4, 8); // cell 4px，边距 8 单元
  } catch (e) {
    const a = document.createElement('a');
    a.href = qrUrl; a.target = '_blank'; a.rel = 'noopener';
    a.style.cssText = 'display:inline-block;max-width:260px;word-break:break-all;font-size:12px;color:#1a6b9a;text-decoration:underline;';
    a.textContent = qrUrl;
    box.appendChild(a);
  }
}
function stopFeishuRegisterPoll(){ if(feishuRegTimer){ clearInterval(feishuRegTimer); feishuRegTimer = null; } }
function resetRegButtons(){
  const wrap = document.getElementById('regQrWrap');
  const cancelBtn = document.getElementById('regCancelBtn');
  if(wrap) wrap.style.display = 'none';
  if(cancelBtn) cancelBtn.style.display = 'none';
}

/* 发起扫码注册：调后端 begin 拿二维码，启动轮询；返回 Promise（true=注册成功） */
function startFeishuRegister(){
  return new Promise(function(resolve){
    feishuRegResolve = resolve;
    const statusEl = document.getElementById('regStatus');
    const resultEl = document.getElementById('regResult');
    if(resultEl){ resultEl.style.display = 'none'; }
    const fail = (msg) => {
      if(statusEl){ statusEl.textContent = '✗ ' + msg; statusEl.style.color = '#a33'; }
      resetRegButtons();
      finishFeishuRegister(false);
    };
    localApi('POST', '/api/feishu/register/begin', {}).then(function(j){
      feishuRegToken = j.token;
      renderRegisterQr(j.qrUrl);
      if(statusEl){ statusEl.textContent = '等待扫码…（' + (j.expireIn || 600) + 's 内有效）'; statusEl.style.color = '#6b6b6b'; }
      const cancelBtn = document.getElementById('regCancelBtn');
      if(cancelBtn){ cancelBtn.style.display = 'inline-block'; }
      pollFeishuRegisterUntilDone();
    }).catch(function(e){
      fail('发起失败：' + (e && e.message ? e.message : e));
    });
  });
}
/* 取消当前扫码注册会话 */
async function cancelFeishuRegister(){
  stopFeishuRegisterPoll();
  if(feishuRegToken){
    try { await localApi('POST', '/api/feishu/register/cancel?token=' + encodeURIComponent(feishuRegToken), {}); } catch(e){}
    feishuRegToken = null;
  }
  resetRegButtons();
  const statusEl = document.getElementById('regStatus');
  if(statusEl){ statusEl.textContent = '已取消'; statusEl.style.color = '#6b6b6b'; }
  finishFeishuRegister(false);
}
/* 轮询扫码终态：waiting / success / failed / expired */
function pollFeishuRegisterUntilDone(){
  stopFeishuRegisterPoll();
  const statusEl = document.getElementById('regStatus');
  const resultEl = document.getElementById('regResult');
  let tries = 0;
  feishuRegTimer = setInterval(async () => {
    tries++;
    if(!feishuRegToken){ stopFeishuRegisterPoll(); return; }
    try{
      const j = await localApi('GET', '/api/feishu/register/poll?token=' + encodeURIComponent(feishuRegToken));
      const st = j && j.status;
      if(st === 'waiting'){
        if(statusEl){ statusEl.textContent = '等待扫码 / 确认…'; statusEl.style.color = '#6b6b6b'; }
      } else if(st === 'success'){
        stopFeishuRegisterPoll();
        feishuRegToken = null;
        const appId = j.appId || '';
        let msg = '✓ 已创建个人应用并自动保存凭证（App ID：' + (appId || '—') + '）';
        if(j.probe && j.probe.error){
          msg += '；自动探测绑定失败：' + j.probe.error + '（可稍后在「高级设置」点「自动探测并绑定」重试）';
        } else if(j.probe && j.probe.folder_token){
          msg += '，已自动创建「简历数据」文件夹并绑定。';
        }
        msg += feishuRegAutoOauth ? ' 正在发起扫码授权…' : ' 现在可以「上报到飞书」了。';
        if(resultEl){ resultEl.style.display = 'block'; resultEl.style.background = '#eef7ee'; resultEl.style.border = '1px solid #cde6cd'; resultEl.style.color = '#1a6b1a'; resultEl.textContent = msg; }
        if(statusEl){ statusEl.textContent = '完成'; statusEl.style.color = '#1a6b1a'; }
        const cfgAppId = document.getElementById('cfgAppId');
        if(cfgAppId && appId) cfgAppId.value = appId;
        resetRegButtons();
        showFeishuStatus('✓ 飞书个人应用已注册并绑定');
        finishFeishuRegister(true);
      } else if(st === 'failed'){
        stopFeishuRegisterPoll();
        if(resultEl){ resultEl.style.display = 'block'; resultEl.style.background = '#fdeeee'; resultEl.style.border = '1px solid #f3cccc'; resultEl.style.color = '#a33'; resultEl.textContent = '✗ 注册失败：' + (j.error_description || j.error || '未知错误'); }
        if(statusEl){ statusEl.textContent = '失败'; statusEl.style.color = '#a33'; }
        resetRegButtons();
        finishFeishuRegister(false);
      } else if(st === 'expired'){
        stopFeishuRegisterPoll();
        if(resultEl){ resultEl.style.display = 'block'; resultEl.style.background = '#fdeeee'; resultEl.style.border = '1px solid #f3cccc'; resultEl.style.color = '#a33'; resultEl.textContent = '✗ 二维码已过期，请重新点击「连接飞书」。'; }
        if(statusEl){ statusEl.textContent = '已过期'; statusEl.style.color = '#a33'; }
        resetRegButtons();
        finishFeishuRegister(false);
      }
    }catch(e){
      if(tries >= 150){ // 150 × 2s = 5 分钟兜底
        stopFeishuRegisterPoll();
        if(statusEl){ statusEl.textContent = '✗ 轮询中断：' + (e && e.message ? e.message : e); statusEl.style.color = '#a33'; }
        resetRegButtons();
        finishFeishuRegister(false);
      }
    }
  }, 2000);
}

/* ============ 上传简历（PDF / JSON，支持多选）到简历库 ============
   入口：抽屉顶部「上传」按钮 → #resumeImportFile（accept .pdf/.json，multiple）。
   JSON：校验后直接作为新简历入库；
   PDF：读为 base64 → POST /api/pdf/parse（本地服务用 vendored pdf.js 提取文本并尽力结构化）
        → 结果作为新简历入库，用户在编辑器里校对整理。
   批量导入时在抽屉内显示聚合进度条 + 逐文件状态，全部完成后激活最后成功的一份。 */

/* —— 上传进度面板（index.html 抽屉内 #uploadProgress） —— */
function uploadPanel(){
  return {
    wrap: document.getElementById('uploadProgress'),
    title: document.getElementById('uploadProgressTitle'),
    count: document.getElementById('uploadProgressCount'),
    fill: document.getElementById('uploadProgressFill'),
    list: document.getElementById('uploadProgressList')
  };
}
function resetUploadPanel(){
  const p = uploadPanel();
  if(p.wrap) p.wrap.hidden = true;
  if(p.list) p.list.innerHTML = '';
  if(p.fill) p.fill.style.width = '0%';
  if(p.count) p.count.textContent = '';
}
function setUploadProgress(p, opts){
  const done = opts.done || 0;
  const total = opts.total || 1;
  const frac = Math.max(0, Math.min(1, opts.fraction || 0));
  const pct = Math.min(100, Math.round((done + frac) / total * 100));
  if(p.fill) p.fill.style.width = pct + '%';
  if(p.count) p.count.textContent = done + ' / ' + total;
  if(p.title) p.title.textContent = opts.label || '正在导入…';
}
function addUploadRow(name, stateText, cls){
  const p = uploadPanel();
  if(!p.list) return null;
  const row = document.createElement('div');
  row.className = 'upload-progress-row' + (cls ? ' ' + cls : '');
  const nameEl = document.createElement('span');
  nameEl.className = 'upload-progress-name';
  nameEl.textContent = name;
  nameEl.title = name;
  const stateEl = document.createElement('span');
  stateEl.className = 'upload-progress-state';
  stateEl.textContent = stateText || '';
  row.appendChild(nameEl);
  row.appendChild(stateEl);
  p.list.appendChild(row);
  return { row: row, state: stateEl };
}
function setRowState(entry, text, cls){
  if(!entry) return;
  if(entry.state) entry.state.textContent = text;
  if(entry.row) entry.row.className = 'upload-progress-row' + (cls ? ' ' + cls : '');
}

/* 读文件为 base64，带读取进度回调（PDF 解析用） */
function readFileAsBase64(file, onProgress){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = e => {
      if(onProgress && e.lengthComputable && file.size) onProgress(e.loaded / file.size);
    };
    reader.onload = e => {
      const result = e.target.result;
      // result 形如 "data:application/pdf;base64,xxxx"，取逗号后部分
      const idx = String(result).indexOf(',');
      resolve(idx >= 0 ? String(result).slice(idx + 1) : String(result));
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}
/* 读文件为文本（JSON 导入用） */
function readFileAsText(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsText(file);
  });
}
/* POST JSON，带上传进度回调（XHR 的 upload.onprogress；无 XHR 时回退 fetch，无进度） */
function postJsonWithProgress(path, obj, onProgress){
  return new Promise((resolve, reject) => {
    if(typeof XMLHttpRequest === 'function'){
      let xhr;
      try{ xhr = new XMLHttpRequest(); }catch(e){ xhr = null; }
      if(xhr){
        xhr.open('POST', path, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.upload.onprogress = e => {
          if(onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
        };
        xhr.onload = () => {
          let j = null;
          try{ j = JSON.parse(xhr.responseText); }catch(e2){}
          if(xhr.status >= 200 && xhr.status < 300) resolve(j);
          else reject(new Error((j && j.error) || ('HTTP ' + xhr.status)));
        };
        xhr.onerror = () => reject(new Error('网络请求失败'));
        xhr.send(JSON.stringify(obj));
        return;
      }
    }
    // 兜底：无 XHR（个别 WebView / 测试环境）走 fetch，无上传进度
    fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(obj)
    }).then(r => r.json().then(j => {
      if(!r.ok) throw new Error(j && j.error ? j.error : ('HTTP ' + r.status));
      return j;
    })).then(resolve, reject);
  });
}

/* 把一份 {data,fonts,spacing,v} 载荷作为新简历加入 ResumeLibrary。
   opts.activate === false 时不切换激活（批量导入用，最后统一激活） */
async function importResumePayload(payload, title, opts){
  opts = opts || {};
  if(!RB.getLibraryReady() || typeof global.ResumeLibrary !== 'object' || !global.ResumeLibrary){
    throw new Error('多简历库未就绪，无法导入');
  }
  // 补全缺失字段，确保结构完整（缺 savedAt 用当前时间）
  if(!payload.savedAt) payload.savedAt = Date.now();
  if(!payload.v) payload.v = RB.getSaveVersion();
  if(!payload.fonts) payload.fonts = JSON.parse(JSON.stringify(defaultFonts));
  if(!payload.spacing) payload.spacing = JSON.parse(JSON.stringify(defaultSpacing));
  const meta = await global.ResumeLibrary.create({ title: title || '未命名简历', payload: payload });
  if(opts.activate === false) return meta;
  RB.setActiveResumeId(meta.id);
  RB.setOpenTabs([meta.id]);   // 导入后单开该份
  RB.applyPayloadWithoutSave(payload);
  await global.ResumeLibrary.setActive(meta.id);
  RB.renderResumeTabs(); RB.renderResumeDrawer();
  return meta;
}

/* 多文件导入主流程：顺序处理，聚合进度 + 逐文件状态，失败不中断后续文件 */
async function importResumeFile(input){
  const files = Array.prototype.slice.call((input && input.files) || []);
  if(!files.length) return;
  const uploadBtn = document.getElementById('resumeUploadBtn');
  if(uploadBtn) uploadBtn.disabled = true;
  const panel = uploadPanel();
  if(panel.wrap) panel.wrap.hidden = false;
  if(panel.list) panel.list.innerHTML = '';
  if(panel.fill) panel.fill.style.width = '0%';

  const N = files.length;
  let okCount = 0;
  let lastMeta = null;
  const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0) || 1;
  let doneBytes = 0;
  try {
    for(let i = 0; i < N; i++){
      const file = files[i];
      const label = file.name || ('文件 ' + (i + 1));
      const entry = addUploadRow(label, '排队中…');
      const overall = (frac) => setUploadProgress(panel, {
        done: doneBytes / totalBytes, total: 1, fraction: frac,
        label: '正在导入 ' + (i + 1) + '/' + N + ' · ' + label
      });
      try {
        const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
        let payload, title;
        if(isPdf){
          // PDF：读字节（50%）→ 上传解析（40%）→ 入库（10%）
          setRowState(entry, '读取中…');
          const b64 = await readFileAsBase64(file, f => overall(f * 0.5));
          setRowState(entry, '上传解析中…');
          const j = await postJsonWithProgress('/api/pdf/parse', { base64: b64 }, f => overall(0.5 + f * 0.4));
          if(!j || !j.resume) throw new Error('解析结果为空');
          payload = j.resume;
          title = (payload.data && payload.data.name) || label.replace(/\.pdf$/i, '');
        } else {
          // JSON：读取 + 校验 + 入库
          setRowState(entry, '读取中…');
          const text = await readFileAsText(file);
          overall(0.6);
          let obj;
          try{ obj = JSON.parse(text); }catch(e){ throw new Error('文件不是有效的 JSON'); }
          if(!obj || !obj.data || !Array.isArray(obj.data.sections)) throw new Error('JSON 格式不正确（缺少 data.sections）');
          payload = obj;
          title = (payload.data && payload.data.name) || label.replace(/\.json$/i, '');
        }
        setRowState(entry, '导入中…');
        overall(0.9);
        const meta = await importResumePayload(payload, title, { activate: false });
        lastMeta = meta;
        okCount++;
        setRowState(entry, '✓ 已导入', 'ok');
      } catch (e) {
        setRowState(entry, '✗ ' + (e && e.message ? e.message : e), 'err');
      }
      overall(1);
      doneBytes += file.size || 0;
    }

    // 全部完成后激活最后成功导入的一份（批量时不逐个打断编辑状态）
    if(lastMeta){
      try{
        RB.setActiveResumeId(lastMeta.id);
        RB.setOpenTabs([lastMeta.id]);
        const doc = await global.ResumeLibrary.load(lastMeta.id);
        if(doc && doc.data) RB.applyPayloadWithoutSave(doc);
        await global.ResumeLibrary.setActive(lastMeta.id);
        RB.renderResumeTabs(); RB.renderResumeDrawer();
      }catch(e){ /* 激活失败不致命 */ }
    }

    setUploadProgress(panel, {
      done: 1, total: 1, fraction: 0,
      label: okCount === N ? '全部导入完成' : ('导入完成（' + okCount + '/' + N + ' 成功）')
    });
    showFeishuStatus(okCount === N
      ? '✓ 已导入 ' + N + ' 份简历'
      : (okCount > 0 ? '✓ 已导入 ' + okCount + ' 份（' + (N - okCount) + ' 份失败）' : '✗ 导入失败：所有文件均未通过'));
  } finally {
    if(uploadBtn) uploadBtn.disabled = false;
    // 结果停留展示后自动收起进度面板
    setTimeout(resetUploadPanel, 6000);
    if(input) input.value = '';
  }
}

/* ============ 自动双向同步（绑定飞书后开机即跑） ============
   每 60s 一轮，按「内容哈希」去重：
     1) 本地内容 hash ≠ 上次已推送 hash → 本地有改动，推到飞书；
     2) 本地无改动、远端最新版本指纹变了 → 拉取覆盖本地；
     3) 本地无改动、远端也无变化 → 本轮静默，不发请求；
     4) 本地有改动且远端也变了 → 推本地新版本（飞书版本化，旧版仍在历史，不丢）。
   所有异常走 ResumeNotifier.error 通知，不弹窗、不打断编辑。
   状态不再存 localStorage（P0 存储统一）：改存 ResumeLibrary 索引项
   （index.json 的 items[].lastPushedHash / lastRemoteFp / skipNextPull /
   lastPushNotifyAt），随简历走、按 id 分键、落盘持久化——
   与「简历数据分文件存储」保持一致，重启后继续生效。 */
const AUTO_SYNC_INTERVAL_MS = 60 * 1000;
const PUSH_NOTIFY_THROTTLE_MS = 5 * 60 * 1000;
let _autoSyncTimer = null;
let _autoSyncBusy = false;
let _autoSyncStarted = false;
const _autoSyncState = {};   // id → {lastPushedHash,lastRemoteFp,skipNextPull,lastPushNotifyAt}（内存缓存）

function libraryApi() {
  return (typeof global.ResumeLibrary === 'object' && global.ResumeLibrary && typeof global.ResumeLibrary.list === 'function') ? global.ResumeLibrary : null;
}
/* 从 ResumeLibrary 索引项加载同步状态（异步；失败回退内存缓存/空） */
async function loadAutoSyncState() {
  const Lib = libraryApi();
  if (!Lib) return _autoSyncState;
  try {
    const items = await Lib.list();
    Object.keys(_autoSyncState).forEach(function (k) { delete _autoSyncState[k]; });
    (items || []).forEach(function (it) {
      if (!it || !it.id) return;
      _autoSyncState[it.id] = {
        lastPushedHash: it.lastPushedHash || '',
        lastRemoteFp: it.lastRemoteFp || '',
        skipNextPull: !!it.skipNextPull,
        lastPushNotifyAt: it.lastPushNotifyAt || 0
      };
    });
  } catch (e) { /* 静默 */ }
  return _autoSyncState;
}
/* 写回 ResumeLibrary 索引项（异步 fire-and-forget，失败吞掉） */
function saveAutoSyncState(all) {
  const Lib = libraryApi();
  if (!Lib || !all || typeof all !== 'object') return;
  try {
    Object.keys(all).forEach(function (id) {
      const s = all[id];
      if (!s || typeof s !== 'object') return;
      try { Lib.patchMeta(id, { lastPushedHash: s.lastPushedHash, lastRemoteFp: s.lastRemoteFp, skipNextPull: !!s.skipNextPull, lastPushNotifyAt: s.lastPushNotifyAt || 0 }); } catch (e) {}
    });
  } catch (e) { /* 静默 */ }
}
/* 同步读某份简历的同步状态（依赖内存缓存；未加载时返回空记录） */
function curAutoSyncState(id) {
  if (!_autoSyncState[id]) _autoSyncState[id] = { lastPushedHash: '', lastRemoteFp: '', skipNextPull: false, lastPushNotifyAt: 0 };
  return { all: _autoSyncState, cur: _autoSyncState[id] };
}
/* 稳定内容哈希：key 递归排序后 djb2，同内容必然同 hash（用于「内容是否变更」判定） */
function stableHash(obj) {
  const str = JSON.stringify(obj, function (k, v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = {};
      Object.keys(v).sort().forEach(function (key) { o[key] = v[key]; });
      return o;
    }
    return v;
  });
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return (h >>> 0).toString(36);
}
/* 内容指纹：只覆盖 {data,fonts,spacing,v}，显式剔除 savedAt/id/name 等易变元数据。
   ⚠️ 「内容是否变更」的判定必须用它：currentPayload() 每次生成都带新的 savedAt 时间戳，
   若直接 stableHash(currentPayload()) 则指纹每次必变 → 飞书自动同步每 60s 推一个
   新版本（云盘版本膨胀）+ 本地「指纹一致跳过写盘」永不生效（死代码）。
   本地写盘（app.js saveState）与飞书自动同步（autoSyncTick）必须共用同一口径。 */
function contentHash(payload) {
  if (!payload || typeof payload !== 'object') return stableHash(payload);
  return stableHash({ data: payload.data, fonts: payload.fonts, spacing: payload.spacing, v: payload.v });
}
/* 远端版本指纹：version_id + size + create_time，任一变化即视为远端有新版本 */
function remoteFingerprint(version) {
  if (!version) return '';
  return [version.version_id || '', version.size || 0, version.create_time || 0].join(':');
}
function safeNotify(type, title, body) {
  try { if (global.ResumeNotifier) global.ResumeNotifier.notify(type, title, body); } catch (e) {}
}
/* 推送成功通知带节流（5 分钟最多一条），拉取/错误每次都发 */
function notifyThrottled(type, title, body) {
  const id = activeResumeId();
  const { all, cur } = curAutoSyncState(id);
  const now = Date.now();
  if (now - (cur.lastPushNotifyAt || 0) < PUSH_NOTIFY_THROTTLE_MS) return;
  cur.lastPushNotifyAt = now;
  saveAutoSyncState(all);
  safeNotify(type, title, body);
}
/* 手动拉取/恢复成功后对齐基线：本地 hash = 拉下来的内容，远端指纹下轮重新对齐 */
async function markManualPullBaseline(obj) {
  try {
    const id = activeResumeId();
    await loadAutoSyncState();
    const { all, cur } = curAutoSyncState(id);
    cur.lastPushedHash = contentHash(obj);
    cur.lastRemoteFp = '';
    saveAutoSyncState(all);
  } catch (e) {}
}
/* 是否已绑定飞书：原生壳直视为已绑；浏览器模式问本地服务 /api/sync/config */
function isFeishuBound() {
  if (typeof window !== 'undefined' && window.__RESUME_NATIVE__) return Promise.resolve(true);
  if (typeof fetch !== 'function') return Promise.resolve(false);
  return fetch('/api/sync/config', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { return !!(j && j.hasSecret); })
    .catch(function () { return false; });
}

async function autoSyncTick() {
  if (_autoSyncBusy || (typeof document !== 'undefined' && document.hidden)) return;
  const bound = await isFeishuBound();
  if (!bound) return;
  await loadAutoSyncState();   // 每轮从索引项刷新同步状态（重启/多份切换后仍准确）
  const id = activeResumeId();
  const { all, cur } = curAutoSyncState(id);
  const localPayload = RB.currentPayload();
  localPayload.id = id;
  localPayload.name = (localPayload.data && localPayload.data.name) || '简历';
  const localHash = contentHash(localPayload);   // 剔除 savedAt/id/name，只看内容

  _autoSyncBusy = true;
  try {
    const versions = await ResumeStore.listVersions(id);
    if (!versions || !versions.length) {
      // 远端还没有版本：首次自动推送
      if (localHash !== cur.lastPushedHash) {
        await ResumeStore.push(localPayload);
        cur.lastPushedHash = localHash;
        cur.skipNextPull = true;
        saveAutoSyncState(all);
        notifyThrottled('success', '已自动上报到飞书', '当前内容已上传云端备份');
      }
      return;
    }
    const remoteFp = remoteFingerprint(versions[0]);
    const localDirty = localHash !== cur.lastPushedHash;

    if (localDirty) {
      // 本地有未推送改动 → 推上去（远端同时变了也不覆盖：飞书版本化，旧版仍在历史）
      const remoteChanged = remoteFp !== cur.lastRemoteFp;
      await ResumeStore.push(localPayload);
      cur.lastPushedHash = localHash;
      cur.skipNextPull = true;
      saveAutoSyncState(all);
      notifyThrottled('success', '已自动上报到飞书', remoteChanged
        ? '本地有改动且云端也有更新：已上传本地新版本，云端旧版本可在「历史版本」找回'
        : '当前内容已上传云端备份');
    } else if (remoteFp !== cur.lastRemoteFp) {
      if (cur.skipNextPull) {
        // 这是我们自己刚推上去的版本，只记指纹、不回拉（避免拉回自己的内容并记一次历史）
        cur.skipNextPull = false;
      } else {
        const obj = await ResumeStore.pull(id);
        RB.recordHistory('action');
        RB.applyDataPayload(obj);
        cur.lastPushedHash = contentHash(obj);
        safeNotify('info', '已从飞书自动拉取更新', '云端有新版本，已合并到本地（可撤销）');
      }
      cur.lastRemoteFp = remoteFp;
      saveAutoSyncState(all);
    }
  } catch (e) {
    safeNotify('error', '自动同步失败', (e && e.message) ? e.message : String(e));
  } finally {
    _autoSyncBusy = false;
  }
}

function startAutoSync() {
  if (_autoSyncStarted || typeof setTimeout !== 'function') return;
  _autoSyncStarted = true;
  // 启动后稍等数据就绪立即跑一轮，之后按周期
  setTimeout(autoSyncTick, 3000);
  if (typeof setInterval === 'function') {
    _autoSyncTimer = setInterval(autoSyncTick, AUTO_SYNC_INTERVAL_MS);
  }
}
function stopAutoSync() {
  _autoSyncStarted = false;
  if (_autoSyncTimer) { clearInterval(_autoSyncTimer); _autoSyncTimer = null; }
}

global.ResumeFeishu = {
  showFeishuStatus: showFeishuStatus,
  reportToFeishu: reportToFeishu,
  pullFromFeishu: pullFromFeishu,
  restoreFromFeishu: restoreFromFeishu,
  toggleMenu: toggleMenu,
  openFeishuConfig: openFeishuConfig,
  closeFeishuConfig: closeFeishuConfig,
  saveFeishuConfig: saveFeishuConfig,
  probeFeishuConfig: probeFeishuConfig,
  localApi: localApi,
  checkFeishuOauthStatus: checkFeishuOauthStatus,
  startFeishuOauth: startFeishuOauth,
  refreshFeishuOauth: refreshFeishuOauth,
  revokeFeishuOauth: revokeFeishuOauth,
  startFeishuRegister: startFeishuRegister,
  cancelFeishuRegister: cancelFeishuRegister,
  importResumeFile: importResumeFile,
  importResumePayload: importResumePayload,
  /* 自动双向同步 */
  startAutoSync: startAutoSync,
  stopAutoSync: stopAutoSync,
  autoSyncTick: autoSyncTick,

  stableHash: stableHash,
  contentHash: contentHash,
  remoteFingerprint: remoteFingerprint
};
})(typeof window !== "undefined" ? window : globalThis);
