/* =============================================================
 * 简历编辑器 - 业务逻辑
 * -------------------------------------------------------------
 * 渲染、拖拽排序、字号/间距配置、分页参考线、PDF 导出、自动保存。
 * 数据与默认值来自 js/data.js（需先加载）
 * ============================================================= */
(function(global){
'use strict';
/* 从 js/render/resume-render.js 解构纯渲染函数（物理拆分，不改变行为） */
const { esc, boldText, getSection, getVarStr, spacingStyle, z, getPageMargins, mmToPx, pxToMm, T, S, renderResumeInner, blankItem, blankProject, blankSection, blankPhase, objify, itemHead, safeMm, syncPrintPageMargin, renderPreview, renderEditor, parseSpacingTarget, renderSettings, resetFonts, renderSpacingSettings, resetSpacing, renderMarginSettings, resetMargins, getPageMetrics, computePageBreaks, drawPageGuides, toggleGuides, applyPreviewScale, migrateQuoteColors, migrateSpacing, migrateSpacingDefaults, migratePageBreaks } = global.ResumeRender;
/* 从 js/feishu/feishu-sync.js 解构飞书 / 导入函数（物理拆分，不改变行为） */
const { showFeishuStatus, reportToFeishu, pullFromFeishu, restoreFromFeishu, toggleMenu, openFeishuConfig, closeFeishuConfig, saveFeishuConfig, probeFeishuConfig, localApi, checkFeishuOauthStatus, startFeishuOauth, refreshFeishuOauth, revokeFeishuOauth, startFeishuRegister, cancelFeishuRegister, importResumeFile, importResumePayload, startAutoSync } = global.ResumeFeishu;
/* 从 js/export/export-pdf.js 解构导出函数（物理拆分，不改变行为） */
const { exportPDF, downloadPDFNow, closePdfModal, showExportModal, closeExportModal, doExportDownload, exportLongImage, exportSingleFileHTML, exportSharePage, downloadBlob } = global.ResumeExport;
/* 从 js/ui/pane-mobile.js 解构面板 / 移动端 UI 函数（物理拆分，不改变行为） */
const { setPaneCollapsed, toggleEditorPane, syncSideRail, setSidePanelOpen, toggleSidePanel, setMobileView, currentMobileView, visibleModal, closeVisibleModal, handleMobileBack, setupNativeBack, setupMobileBackGesture, setupVisualViewport, setupKeyboardFocusGuard } = global.ResumeUI;
/* 保存状态条（js/ui/save-status.js）。缺失时退化为空实现 —— 保存链路本身不该因为
   一个纯展示模块没加载就崩掉（单文件版漏登记 / 老页面缓存都可能触发）。 */
const SaveStatus = (global.ResumeSaveStatus && typeof global.ResumeSaveStatus.markSaved === 'function')
  ? global.ResumeSaveStatus
  : { init: function () { return false; }, onRetry: function () { }, markInfo: function () { },
      markEditing: function () { }, markSaving: function () { }, markSaved: function () { },
      markFailed: function () { }, markDegraded: function () { } };

const HIST_MAX = 100;
/* 撤销 / 重做栈按简历隔离（修复跨份污染）：
   - 旧实现是全局单栈 {undo,redo}，切换简历不清栈 → 在 A 简历里按 Ctrl+Z 会把 B 简历内容改回去。
   - 现改为：每个简历 id 各持一份 {undo,redo}，存于 STACKS；hist.undo/hist.redo 只是「当前激活简历栈」的引用，
     recordHistory / undo / redo 经 bindHist(activeResumeId) 重指。单份模式 activeResumeId 为 null，用 '__default__' 兜底。
   - hist.last（合并窗口）保持全局，但 bindHist 仅「真正切换简历」时重置，同一份内连续输入合并不受影响。 */
const hist = { undo: [], redo: [], last: { kind:'', t:0 } };
const STACKS = {};
const DEFAULT_STACK_KEY = '__default__';
function stackKeyOf(id){ return id || DEFAULT_STACK_KEY; }
function getStack(id){ const k = stackKeyOf(id); if(!STACKS[k]) STACKS[k] = { undo:[], redo:[] }; return STACKS[k]; }
let histBoundId = DEFAULT_STACK_KEY;
function bindHist(id){
  const k = stackKeyOf(id);
  if(histBoundId === k) return;            // 同一份：不重绑、不清合并窗口
  histBoundId = k;
  const s = getStack(id);
  hist.undo = s.undo;
  hist.redo = s.redo;
  hist.last = { kind:'', t:0 };            // 切简历时重置合并窗口，避免 A 的连续输入被并入 B
}
function snapshot(){ return JSON.stringify({ data, fonts: currentFonts, spacing: currentSpacing }); }
/* 从快照恢复并把所有面板重渲染 */
function restoreSnapshot(s){
  try{
    const o = JSON.parse(s);
    data = o.data; currentFonts = o.fonts; currentSpacing = o.spacing;
  }catch(e){ return; }
  renderSettings(); renderMarginSettings(); renderSpacingSettings(); renderEditor(); renderPreview(); applyPanelState();
}
/* ============ N11 本地版本历史：把 undo 快照持久化到本地版本链 ============
   版本链 = undo 栈的「持久化超集」，回滚版本与撤销同构（restoreSnapshot）。
   单份模式（activeResumeId 为 null）用 'default' 兜底，与历史面板的 resumeId 取法一致。 */
function localHistoryResumeId(){ return activeResumeId || 'default'; }
function localHistory(){
  const LH = global.ResumeLocalHistory;
  return (LH && typeof LH.append === 'function') ? LH : null;
}
/* 追加一条本地版本（异步、静默降级：记历史失败绝不打断编辑）。 */
function appendLocalVersion(snap, label, source, name){
  const LH = localHistory();
  if(!LH) return;
  const id = localHistoryResumeId();
  try{
    LH.append(id, {
      versionId: LH.genVersionId(Date.now()),
      timestamp: Date.now(),
      label: label || '编辑',
      source: source || 'auto',
      name: name || null,
      snapshot: snap
    });
  }catch(e){ /* 静默 */ }
}
/* 列出本地版本（时间倒序）。无模块 / 失败返回空数组。 */
async function listLocalVersions(){
  const LH = localHistory();
  if(!LH) return [];
  try{ return await LH.list(localHistoryResumeId()); }catch(e){ return []; }
}
/* 回滚到某本地版本：先「把当前内容存为新版本」再应用目标（回滚可逆、不丢当前）。
   返回 true=成功；false=版本不存在 / 快照损坏。
   N3 互补：锁定简历只读——恢复会覆盖正文，锁定态下拒绝（浏览历史 / 手动快照不受限）。 */
async function restoreLocalVersion(versionId){
  const LH = localHistory();
  if(!LH) return false;
  if(isActiveLocked()){ notifyUser('warn', '简历已锁定', '锁定状态下不能恢复历史版本；先在「我的简历」里解锁再试。'); return false; }
  const id = localHistoryResumeId();
  let target;
  try{ target = await LH.restore(id, versionId); }catch(e){ target = null; }
  if(!target || !target.data) return false;
  /* 先存当前为新版本（复用 recordHistory：入栈当前快照 + 落一条持久化版本） */
  recordHistory('action', '恢复');
  restoreSnapshot(JSON.stringify(target));
  if(bootDone){ markDirty(activeResumeId); saveState(); }
  return true;
}
/* 手动命名快照：给当前状态打一个可定位的版本点（不入 undo 栈、不打断撤销）。 */
async function saveManualSnapshot(name){
  const LH = localHistory();
  if(!LH) return false;
  appendLocalVersion(snapshot(), '手动快照', 'manual', name || null);
  return true;
}
/* 记录一次变更。kind 相同且时间相近的连续「编辑/设置」会合并为一个撤销步（避免逐字符/逐格历史爆炸）；
   'action' 类（增删/移动/拖拽/导入/重置）每次都是独立可撤销步，不合并。
   N11：label 为版本历史的来源语义（'编辑'|'导入'|'重置'|'从飞书恢复'|'手动快照'），
   缺省按 kind 映射；关键 action（导入/重置/恢复）由调用点显式传入。 */
function recordHistory(kind, label){
  bindHist(activeResumeId);
  const now = Date.now();
  if((kind==='edit' || kind==='setting') && hist.last.kind===kind && (now - hist.last.t) < 700){ hist.last.t = now; return; }
  const snap = snapshot();
  hist.undo.push(snap);
  if(hist.undo.length > HIST_MAX) hist.undo.shift();
  hist.redo.length = 0;
  hist.last = { kind, t: now };
  updateUndoButtons();
  markDirty(activeResumeId);
  /* N11：undo 快照入栈的同时，向本地持久化版本链追加一条（异步、静默降级） */
  appendLocalVersion(snap, label || '编辑');
}
function undo(){
  bindHist(activeResumeId);
  if(!hist.undo.length){ return; }
  hist.redo.push(snapshot());
  restoreSnapshot(hist.undo.pop());
  hist.last = { kind:'', t:0 };
  updateUndoButtons();
  if(bootDone){ markDirty(activeResumeId); saveState(); }   // 撤销结果落盘（修复「撤销后不写盘」）
}
function redo(){
  bindHist(activeResumeId);
  if(!hist.redo.length){ return; }
  hist.undo.push(snapshot());
  restoreSnapshot(hist.redo.pop());
  hist.last = { kind:'', t:0 };
  updateUndoButtons();
  if(bootDone){ markDirty(activeResumeId); saveState(); }
}
/* 撤销 / 重做在桌面与手机各有一个按钮（同一份入口清单的两端渲染），都要同步禁用态 ——
   只更新一个的话，另一个会一直显示成「可点」，点下去却是空动作。 */
const UNDO_IDS = ['undoBtn', 'undoBtnMobile'];
const REDO_IDS = ['redoBtn', 'redoBtnMobile'];
function updateUndoButtons(){
  UNDO_IDS.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = hist.undo.length === 0; });
  REDO_IDS.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = hist.redo.length === 0; });
}
/* 判断事件 target 是否落在可编辑字段内（输入框 / 多行框 / contenteditable）。
   用于撤销快捷键：在字段内放行浏览器原生撤销，让「撤一个词」而不是回滚整份简历。 */
function isEditableTarget(el){
  if(!el) return false;
  const tag = el.tagName;
  if(tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if(el.isContentEditable) return true;
  return false;
}

/* ============ 右侧面板折叠 / 展开（状态持久化到 localStorage） ============ */
const PANEL_STATE_KEY = 'resume_collapsed_panels_v1';
function loadPanelState(){
  try{ const raw = localStorage.getItem(PANEL_STATE_KEY); return raw ? JSON.parse(raw) : {}; }catch(e){ return {}; }
}
function savePanelState(state){
  try{ localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(state)); }catch(e){}
}
// UX-01 修复：配置面板（字号/边距/间距）默认折叠，打开编辑面板即见「内容编辑」。
// 既有存储的面板状态（用户显式展开过）会覆盖默认值。
const DEFAULT_PANEL_STATE = { 'panel-fonts': true, 'panel-margins': true, 'panel-spacing': true };
let panelCollapsed = Object.assign({}, DEFAULT_PANEL_STATE, loadPanelState());
function applyPanelState(){
  ['panel-fonts','panel-margins','panel-spacing','panel-editor'].forEach(id=>{
    const el = document.getElementById(id);
    if(!el) return;
    if(panelCollapsed[id]) el.classList.add('collapsed'); else el.classList.remove('collapsed');
  });
}
function togglePanel(id){
  panelCollapsed[id] = !panelCollapsed[id];
  const el = document.getElementById(id);
  if(el) el.classList.toggle('collapsed', panelCollapsed[id]);
  savePanelState(panelCollapsed);
}
// 点击面板标题（含 chevron）切换；点击“恢复默认”按钮不触发
const editorPane = document.querySelector('.editor-pane');
if(editorPane){
  editorPane.addEventListener('click', e=>{
    const header = e.target.closest('.panel-header.collapsible');
    if(!header) return;
    if(e.target.closest('button')) return;   // 让恢复默认按钮正常工作
    togglePanel(header.dataset.panel);
  });
}

/* ============ 主题（日间 / 夜间）============
   具体逻辑在 js/theme.js（与本文件解耦）；这里只做三件事：
     1) 把工具栏 / 菜单的点击转发过去
     2) 导出时「临时把纸张拉回白纸」，确保夜间模式不会污染产物
     3) theme.js 缺席时全部静默降级，不影响编辑器本身 */
function themeApi(){
  try{ return (global.ResumeTheme && typeof global.ResumeTheme.setMode === 'function') ? global.ResumeTheme : null; }
  catch(e){ return null; }
}
function beginPaperGuard(){ const t = themeApi(); if(t) t.beginExport(); }
function endPaperGuard(){ const t = themeApi(); if(t) t.endExport(); }
function toggleTheme(){ const t = themeApi(); if(t) t.toggleTheme(); }
function setThemeMode(mode){ const t = themeApi(); if(t) t.setMode(mode); }
function togglePaperTheme(){ const t = themeApi(); if(t) t.togglePaperFollows(); }

document.addEventListener('keydown', e=>{
  if(e.key === 'Escape'){
    const m=document.getElementById('pdfModal'); if(m && m.style.display==='flex') closePdfModal();
    const em=document.getElementById('exportModal'); if(em && em.style.display==='flex') closeExportModal();
  }
  // 撤销 / 重做（应用级）。⚠️ 输入框 / contenteditable 内放行浏览器原生撤销，
  // 让用户在文本框里「撤一个词」而不是回滚整份简历（修复跨字段误吞原生撤销）。
  const mod = e.ctrlKey || e.metaKey;
  const inField = isEditableTarget(e.target);
  if(mod && (e.key==='z' || e.key==='Z')){
    if(inField) return;                 // 交给浏览器原生撤销，不拦截、不整份回滚
    e.preventDefault(); if(e.shiftKey) redo(); else undo();
  }
  else if(mod && (e.key==='y' || e.key==='Y')){
    if(inField) return;
    e.preventDefault(); redo();
  }
  else if(mod && (e.key==='b' || e.key==='B')){ e.preventDefault(); toggleEditorPane(); }
});

/* ============ 自动保存 ============
   已移除浏览器持久化（IndexedDB / localStorage 不再存简历数据）：
   · 多份模式 → ResumeLibrary 写 <app_data_dir>/resumes/<id>.json（Tauri 命令）
   · 单份模式 → ResumeStore 写 default 文档
   · 内容指纹（stableHash）比对后才写盘；SAVE_KEY* 仅用于清理旧版本残留。 */
const SAVE_KEY = 'resume_builder_data_v1';
const SAVE_KEY_LEGACY = 'resume_chenpeisheng_v1';
const SAVE_VERSION = 8;
const FILENAME_BASE_KEY = 'resume_filename_base_v1';
let fileNameBase = '';
let bootDone = false;

/* ============ 多简历（M1/M2）：左抽屉 + 顶部标签页 ============
   状态：
   - activeResumeId：当前正在编辑的简历 id（null = 尚未接入多简历，走单份 default 文档）
   - openTabs：已打开的工作区标签 id 列表（桌面多开）
   - dirty：每份简历是否有未同步修改（用 Set 记 id，保存即清）
   与单份逻辑的关系：data/fonts/spacing 仍是「当前编辑的那份」；
   saveState() 时经内容指纹比对后写进 ResumeLibrary.save(activeResumeId, …)。
   首份简历由「继承当前已加载数据」创建，保证老用户升级不丢内容。 */
let activeResumeId = null;       // 当前激活简历 id
let openTabs = [];               // 已打开标签 id 列表（顺序）
let dirtySet = new Set();        // 未保存的简历 id 集合
let _libraryReady = false;       // ResumeLibrary 是否已初始化
let lastSavedAt = 0;             // 当前内存数据的来源时间戳（0=未知/旧数据无时间戳）
let _defaultLastHash = null;     // 单份模式（default 文档）的内容指纹（内存态）

function currentPayload(){ return { data, fonts: currentFonts, spacing: currentSpacing, v: SAVE_VERSION, savedAt: Date.now() }; }
function markDirty(id){ if(id){ dirtySet.add(id); renderResumeDrawer(); } }
function clearDirty(id){ if(id){ dirtySet.delete(id); renderResumeDrawer(); } }
function isDirty(id){ return !!id && dirtySet.has(id); }

/* 仲裁：库文档与当前内存基底（仓库 data/resume.json / 种子数据）谁新用谁。
   返回 'library'=库文档较新（浏览器里有未落盘的更新修改）；'repo'=基底较新或同级。
   旧数据双方都无 savedAt（都为 0）→ 'repo'（磁盘是恢复脚本/手工编辑的意图载体，磁盘优先）。 */
function pickResumeSource(doc, memSavedAt){
  return ((Number(doc && doc.savedAt) || 0) > (Number(memSavedAt) || 0)) ? 'library' : 'repo';
}

/* 初始化多简历：读索引；空库则继承当前单份数据建首份。
   ⚠️ 必须在基底数据链（loadRepoData → loadTemplateData）完成之后再调用：
   本函数会用 savedAt 仲裁「库文档 vs 基底」谁新，若在基底加载完成前调用，
   库旧文档会覆盖基底并写回磁盘（数据污染事故的根因）。 */
/* 无写服务环境（file:// / 静态托管）下，ResumeLibrary 已降级 localStorage。
   旧版本把整份数据存在 SAVE_KEY（resume_builder_data_v1），升级到「分文件库」后
   若不做迁移，这些数据会静默消失 —— 这里在「降级态 + 空库」时把它作为首份简历继承。
   （npm start 模式不迁移：磁盘 data/resumes/*.json 才是真源。） */
function legacyLocalPayload(){
  try{
    const raw = localStorage.getItem(SAVE_KEY);
    if(!raw) return null;
    const obj = JSON.parse(raw);
    if(obj && obj.data && Array.isArray(obj.data.sections)) return obj;
  }catch(e){}
  return null;
}
async function initResumeLibrary(){
  if(typeof global.ResumeLibrary !== 'object' || !global.ResumeLibrary) return;
  try{
    await global.ResumeLibrary.init();
    _libraryReady = true;
    let idx = await global.ResumeLibrary.list();
    if(!idx.length){
      // 空库：继承当前已加载的单份数据（仓库 data/resume.json / 种子）建首份；
      // 若处于 localStorage 降级态且旧版本留有数据，优先继承旧数据（升级迁移）
      let payload = null;
      try{
        if(global.ResumeLibrary.backendKind() === 'localstorage') payload = legacyLocalPayload();
      }catch(e){}
      if(!payload) payload = currentPayload();
      // 旧数据迁移时必须同步载入内存：否则屏幕仍是空骨架，
      // 下一次 saveState 会用空骨架覆盖刚建好（含旧数据）的首份简历
      else applyPayloadWithoutSave(payload);
      const meta = await global.ResumeLibrary.create({ title: (data.name||'简历') || '未命名简历', payload: payload });
      activeResumeId = meta.id;
      openTabs = [meta.id];
    } else {
      const act = await global.ResumeLibrary.getActive();
      if(act && idx.some(m=>m.id===act)) activeResumeId = act;
      else { activeResumeId = idx[0].id; await global.ResumeLibrary.setActive(activeResumeId); }
      openTabs = [activeResumeId];
      // 载入激活简历——先仲裁，不再无条件覆盖：
      const doc = await global.ResumeLibrary.load(activeResumeId);
      if(doc && doc.data && pickResumeSource(doc, lastSavedAt) === 'library'){
        // 库文档较新（比磁盘/内存基底新，有未落盘的更新修改）→ 用库文档
        applyPayloadWithoutSave(doc);
      } else {
        // 基底较新（或双方都无时间戳 → 磁盘优先）：把基底回写库，保证库与基底一致
        try{ await global.ResumeLibrary.save(activeResumeId, currentPayload()); }catch(e){}
      }
    }
    renderResumeTabs();
    renderResumeDrawer();
    syncLockState();   // N3：激活简历可能是锁定的 → 启动即置为只读
    // 恢复抽屉展开/收起状态（默认展开；只有明确存过 '0' 才收起）
    try{
      const d = document.getElementById('resumeDrawer');
      if(d && localStorage.getItem(RESUME_DRAWER_KEY) === '0') d.classList.remove('open');
    }catch(e){}
  }catch(e){ /* 多简历初始化失败静默，退回旧单份逻辑 */ }
}

/* 切换激活简历：保存当前份 → 载入目标份 → 更新抽屉/标签/激活态 */
async function switchResume(id){
  if(!_libraryReady || !id || id === activeResumeId){ renderResumeTabs(); return; }
  // 取消 pending 的防抖保存：否则其闭包里的旧份 payload 会在切到新份后触发，把旧份数据写进新份
  cancelPendingSave();
  // 保存当前份
  if(activeResumeId){ try{ await global.ResumeLibrary.save(activeResumeId, currentPayload()); clearDirty(activeResumeId); }catch(e){} }
  // 载入目标份
  try{
    const doc = await global.ResumeLibrary.load(id);
    /* ⚠️ activeResumeId 必须在 applyPayloadWithoutSave 之前切换：
       applyPayloadWithoutSave → renderPreview → saveState → ResumeLibrary.save(activeResumeId, …)，
       若顺序反了，「载入新份」触发的保存会把新份数据写进旧份文档（数据覆盖事故） */
    activeResumeId = id;
    await global.ResumeLibrary.setActive(id);
    if(doc && doc.data){
      applyPayloadWithoutSave(doc);
    } else {
      // 目标份无文档（理论不会发生），给空骨架
      data = { name:'', contact:[], sections:[] }; currentFonts = JSON.parse(JSON.stringify(defaultFonts)); currentSpacing = JSON.parse(JSON.stringify(defaultSpacing));
    }
    if(!openTabs.includes(id)) openTabs.push(id);
    renderResumeTabs(); renderResumeDrawer();
  }catch(e){ /* 静默 */ }
}

/* 打开某份（抽屉点击）：若未打开则加入标签并激活，已打开则切到该标签 */
async function openResume(id){
  await switchResume(id);
}

/* 新建简历 */
async function resumeNew(){
  if(!_libraryReady) return;
  try{
    const title = (prompt('新简历名称', '未命名简历') || '').trim() || '未命名简历';
    const meta = await global.ResumeLibrary.create({ title: title, payload: { data:{name:'',contact:[],sections:[]}, fonts: JSON.parse(JSON.stringify(defaultFonts)), spacing: JSON.parse(JSON.stringify(defaultSpacing)), v: SAVE_VERSION } });
    activeResumeId = meta.id;
    openTabs.push(meta.id);
    applyPayloadWithoutSave({ data:{name:'',contact:[],sections:[]}, fonts: JSON.parse(JSON.stringify(defaultFonts)), spacing: JSON.parse(JSON.stringify(defaultSpacing)), v: SAVE_VERSION });
    await global.ResumeLibrary.setActive(meta.id);
    renderResumeTabs(); renderResumeDrawer();
    return meta;
  }catch(e){ alert('新建失败：' + (e && e.message ? e.message : e)); return null; }
}

/* 复制当前简历 */
async function resumeDuplicate(id){
  if(!_libraryReady || !id) return;
  try{
    const meta = await global.ResumeLibrary.duplicate(id);
    activeResumeId = meta.id;
    openTabs.push(meta.id);
    const doc = await global.ResumeLibrary.load(meta.id);
    if(doc && doc.data) applyPayloadWithoutSave(doc);
    await global.ResumeLibrary.setActive(meta.id);
    renderResumeTabs(); renderResumeDrawer();
    return meta;
  }catch(e){ alert('复制失败：' + (e && e.message ? e.message : e)); return null; }
}

/* 基于当前 JD 匹配结果，生成一份「JD 定制版」派生简历（不覆盖主简历）。
   流程：复制主简历 → 用 jd-derive 的 buildDerivedPayload 把缺失/弱覆盖关键词
   整理成「JD 定制待补」技能分组插入 → 落盘 → 激活。可撤销（进历史栈）。
   血缘（Resume Matcher master→tailored 模型）：派生版 kind='derived'、parentId 指向母简历、
   jobId 关联本次 JD、jdText 存 JD 原文 —— 投递后可回溯到母简历与对应岗位。 */
async function resumeDeriveFromJd(){
  if(!_libraryReady || !activeResumeId) return;
  const derive = global.ResumeJdDerive;
  const jd = global.ResumeJd;
  if(!derive){ alert('JD 派生模块未加载'); return; }
  const analysis = jd && jd.last ? jd.last() : null;
  if(!analysis || !analysis.stats || !analysis.stats.total){
    alert('请先在「JD 匹配分析」里粘贴 JD 并点「分析匹配度」，再生成定制版。');
    return;
  }
  try{
    const idx = await global.ResumeLibrary.list();
    const m = idx.filter(x=>x.id===activeResumeId)[0];
    const baseTitle = (m && m.title) || data.name || '简历';
    const doc = await global.ResumeLibrary.load(activeResumeId);
    if(!doc || !doc.data){ alert('主简历数据读取失败'); return; }
    const jdText = jd ? jd.getJd() : '';
    // 派生：深拷贝 + 插入「JD 定制待补」分组（不改原 doc）
    const derivedPayload = derive.buildDerivedPayload(doc, analysis);
    const title = derive.deriveTitle(baseTitle, jdText);
    // 血缘：jobId 稳定锚点（同一次派生会话复用，跨次派生各自独立），jdText 存 JD 原文
    const jobId = 'jd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const meta = await global.ResumeLibrary.derive({
      parentId: activeResumeId,
      title: title,
      payload: derivedPayload,
      jobId: jobId,
      jdText: jdText
    });
    activeResumeId = meta.id;
    openTabs.push(meta.id);
    const loaded = await global.ResumeLibrary.load(meta.id);
    if(loaded && loaded.data) applyPayloadWithoutSave(loaded);
    await global.ResumeLibrary.setActive(meta.id);
    renderResumeTabs(); renderResumeDrawer();
    return meta;
  }catch(e){ alert('生成 JD 定制版失败：' + (e && e.message ? e.message : e)); return null; }
}

/* 删除简历 */
async function resumeRemove(id){
  if(!_libraryReady || !id) return;
  const idx = await global.ResumeLibrary.list();
  const m = idx.filter(x=>x.id===id)[0];
  if(!confirm('确定删除「' + (m ? m.title : '') + '」吗？\n\n删除后 10 秒内可点「撤销」找回。')) return;
  try{
    global.ResumeLibrary.beginRemoveBatch();
    await global.ResumeLibrary.remove(id);
    /* N11：删除简历时一并清理其本地版本历史（跟随主文档生命周期，不留孤儿分文档） */
    if(localHistory()){ try{ await localHistory().removeAll(id); }catch(e){} }
    openTabs = openTabs.filter(t=>t!==id);
    dirtySet.delete(id);
    if(activeResumeId === id){
      const rest = await global.ResumeLibrary.list();
      if(rest.length){
        activeResumeId = rest[0].id;
        const doc = await global.ResumeLibrary.load(activeResumeId);
        if(doc && doc.data) applyPayloadWithoutSave(doc);
        await global.ResumeLibrary.setActive(activeResumeId);
      } else {
        activeResumeId = null;
      }
    }
    renderResumeTabs(); renderResumeDrawer(); syncLockState();
    showUndoToast('已删除「' + ((m && m.title) || '简历') + '」', resumeUndoRemove);
  }catch(e){ alert('删除失败：' + (e && e.message ? e.message : e)); }
}

/* 重命名 */
async function resumeRename(id){
  if(!_libraryReady || !id) return;
  const idx = await global.ResumeLibrary.list();
  const m = idx.filter(x=>x.id===id)[0];
  const title = (prompt('重命名', m ? m.title : '') || '').trim();
  if(!title) return;
  try{ await global.ResumeLibrary.rename(id, title); renderResumeDrawer(); renderResumeTabs(); }catch(e){}
}

/* 设置标签：逗号分隔输入 */
async function resumeSetTags(id){
  if(!_libraryReady || !id) return;
  const idx = await global.ResumeLibrary.list();
  const m = idx.filter(x=>x.id===id)[0];
  const cur = (m && Array.isArray(m.tags)) ? m.tags.join(', ') : '';
  const input = prompt('标签（逗号分隔，如：校招, AI方向, 后端）', cur);
  if(input === null) return;
  const tags = input.split(/[,，]/).map(function(t){return t.trim();}).filter(Boolean);
  try{ await global.ResumeLibrary.setTags(id, tags); renderResumeDrawer(); renderResumeTabs(); }catch(e){}
}

/* 关闭标签（不删简历，只是关掉工作区标签） */
async function resumeCloseTab(id){
  if(!_libraryReady) return;
  if(isDirty(id) && !confirm('该简历有未保存修改，关闭将保存。确定关闭？')) return;
  if(activeResumeId === id){
    try{ await global.ResumeLibrary.save(id, currentPayload()); clearDirty(id); }catch(e){}
  }
  openTabs = openTabs.filter(t=>t!==id);
  if(activeResumeId === id){
    // 激活下一个标签（最后一个），没有则激活列表首份
    if(openTabs.length){ await switchResume(openTabs[openTabs.length-1]); }
    else {
      const rest = await global.ResumeLibrary.list();
      if(rest.length){ activeResumeId = rest[0].id; const doc = await global.ResumeLibrary.load(activeResumeId); if(doc&&doc.data) applyPayloadWithoutSave(doc); openTabs=[activeResumeId]; }
    }
  }
  renderResumeTabs(); renderResumeDrawer();
}

/* 开关抽屉（桌面：常驻左列，切换宽度收缩/展开；手机：全屏滑出） */
const RESUME_DRAWER_KEY = 'resume_drawer_open_v1';
function toggleResumeDrawer(){
  const d = document.getElementById('resumeDrawer');
  if(!d) return;
  const open = !d.classList.contains('open');
  d.classList.toggle('open', open);
  if(open) renderResumeDrawer();
  try{ localStorage.setItem(RESUME_DRAWER_KEY, open ? '1' : '0'); }catch(e){}
}

/* 渲染顶部标签页 —— 已移除：顶部标签栏删除后，多简历切换统一走左侧常驻抽屉。
   保留函数名为空实现，兼容历史调用点；「未保存」状态改由抽屉列表体现。 */
function renderResumeTabs(){
  /* 顶部标签栏已删除，无需渲染 */
}

/* ===== 卡片「⋯」操作菜单（重命名 / 复制 / 删除） =====
   三个操作不再平铺在卡片上（鼠标扫过卡片时容易误点），改为点「⋯」弹出。
   菜单位于 body 下的固定层：抽屉 .resume-drawer-list 是 overflow:auto，
   绝对定位的子元素会被裁切，固定层不受影响。 */
let _resumeMenuId = null;
function resumeMenuEl(){
  let el = document.getElementById('resumeItemMenu');
  if(el) return el;
  el = document.createElement('div');
  el.id = 'resumeItemMenu';
  el.className = 'resume-item-menu';
  el.setAttribute('role','menu');
  // 菜单自身点击不冒泡：既不触发「点空白关闭」，也不会穿透到卡片
  el.addEventListener('click', function(ev){ ev.stopPropagation(); });
  document.body.appendChild(el);
  // 点空白处关闭（⋯ 按钮自身的点击被它 stopPropagation 拦下，走 toggle 分支）
  document.addEventListener('click', function(ev){
    if(!el.classList.contains('show')) return;
    if(el.contains(ev.target)) return;
    if(ev.target && ev.target.closest && ev.target.closest('.resume-item-more')) return;
    closeResumeItemMenu();
  });
  document.addEventListener('keydown', function(ev){ if(ev.key === 'Escape') closeResumeItemMenu(); });
  // 捕获阶段监听滚动：抽屉列表内部滚动也能关掉菜单（否则菜单会留在原地错位）
  document.addEventListener('scroll', function(){ closeResumeItemMenu(); }, true);
  window.addEventListener('resize', closeResumeItemMenu);
  return el;
}
function closeResumeItemMenu(){
  const el = document.getElementById('resumeItemMenu');
  if(el) el.classList.remove('show');
  const on = document.querySelector('.resume-item-more.on');
  if(on) on.classList.remove('on');
  _resumeMenuId = null;
}
function toggleResumeItemMenu(id, btn){
  if(!id) return;
  const el = resumeMenuEl();
  if(_resumeMenuId === id && el.classList.contains('show')){ closeResumeItemMenu(); return; }
  closeResumeItemMenu();
  _resumeMenuId = id;
  const safeId = esc(id);
  const call = function(fn){ return 'ResumeEditor.closeResumeItemMenu();ResumeEditor.'+fn+'(\''+safeId+'\')'; };
  /* N3：菜单文案随状态变化（锁定/解锁、开启/关闭分享），所以每次开菜单都读一次 meta */
  const meta = (global.ResumeLibrary && typeof global.ResumeLibrary.getMeta === 'function') ? global.ResumeLibrary.getMeta(id) : null;
  const S = shareApi();
  const locked = !!(S && S.isLocked(meta));
  const master = !!(meta && meta.isMaster);
  const pub = !!(S && S.isPublic(meta));
  const hasToken = !!(S && S.tokenOf(meta));
  el.innerHTML = '<button type="button" role="menuitem" onclick="'+call('resumeRename')+'">重命名</button>'
    + '<button type="button" role="menuitem" onclick="'+call('resumeDuplicate')+'">复制</button>'
    + '<button type="button" role="menuitem" title="把这份标为「主简历」（源头简历），库里唯一、排在列表第一" onclick="'+call('resumeSetMaster')+'">'+(master?'取消主简历':'设为主简历')+'</button>'
    + '<span class="menu-sep"></span>'
    + '<button type="button" role="menuitem" title="锁定后编辑区只读，避免误改已定稿的版本" onclick="'+call('resumeToggleLock')+'">'+(locked?'解锁编辑':'锁定防误改')+'</button>'
    + '<button type="button" role="menuitem" title="只有开启分享的简历才允许导出只读分享页" onclick="'+call('resumeTogglePublic')+'">'+(pub?'关闭分享':'开启分享')+'</button>'
    + (pub && hasToken ? '<button type="button" role="menuitem" title="复制这份简历的分享标识（导出分享页时写入页面 meta）" onclick="'+call('copyShareToken')+'">复制分享标识</button>' : '')
    + '<span class="menu-sep"></span>'
    + '<button type="button" role="menuitem" onclick="'+call('resumeRemove')+'">删除</button>';
  el.classList.add('show');
  if(btn) btn.classList.add('on');
  /* 定位：贴「⋯」右下角展开；下方放不下就翻到上方，左右收进视口内 */
  const r = btn ? btn.getBoundingClientRect() : {left:0,right:0,top:0,bottom:0};
  const w = el.offsetWidth, h = el.offsetHeight;
  let top = r.bottom + 4;
  if(top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
  const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  el.style.left = Math.round(left) + 'px';
  el.style.top = Math.round(top) + 'px';
}

/* 渲染左抽屉简历列表 */
function renderResumeDrawer(){
  const list = document.getElementById('resumeList');
  if(!list || !_libraryReady) return;
  global.ResumeLibrary.list().then(idx=>{
    if(!idx.length){
      list.innerHTML = '<div class="resume-drawer-empty">还没有简历，点右上角「新建」创建第一份。</div>';
      return;
    }
    list.innerHTML = idx.map(m=>{
      const active = m.id===activeResumeId;
      const dirty = isDirty(m.id);
      const t = m.updatedAt ? new Date(m.updatedAt).toLocaleString() : '';
      /* ⚠️ 外层不能用 <button>：HTML 禁止 button 嵌套 button，浏览器解析时会把内层
         操作按钮整体提到外层，破坏布局（白色大块）。外层用 div + role="button"。
         ⚠️「⋯」按钮的 keydown 必须 stopPropagation：焦点在它上面按回车时，
         事件会冒泡到外层卡片，否则会顺带打开这份简历。 */
      const derived = m.kind === 'derived';
      const master = !!m.isMaster;
      const S3 = shareApi();
      const locked = !!(S3 && S3.isLocked(m));
      const pub = !!(S3 && S3.isPublic(m));
      return '<div class="resume-item'+(active?' active':'')+(locked?' is-locked':'')+(master?' is-master':'')+'" role="button" tabindex="0" data-id="'+esc(m.id)+'" onclick="ResumeEditor.openResume(\''+esc(m.id)+'\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();ResumeEditor.openResume(\''+esc(m.id)+'\')}">'
        /* ⚠️ 主角标不能放进 .drawer-thumb —— renderDrawerThumbs() 会覆盖 thumb 的 innerHTML，放里面会被抹掉 */
        + (master?'<span class="drawer-master-badge" title="主简历 · 源头简历">主</span>':'')
        + '<div class="drawer-thumb resume-thumb" data-thumb-id="'+esc(m.id)+'"></div>'
        + '<div class="resume-item-main">'
        +   '<span class="resume-item-title">'+(dirty?'● ':'')+(locked?'<em class="resume-item-lock" aria-label="已锁定">🔒</em> ':'')+(master?'<em class="resume-item-kind is-master">主</em> ':'')+esc(m.title)+(derived?' <em class="resume-item-kind">定制版</em>':'')+(pub?' <em class="resume-item-kind is-public">分享中</em>':'')+'</span>'
        +   '<span class="resume-item-meta">'+esc(m.source==='local'?'本地':'云端')+' · '+esc(t)+'</span>'
        + '</div>'
        + '<button type="button" class="resume-item-more" data-more="'+esc(m.id)+'" title="更多操作（重命名 / 复制 / 锁定 / 分享 / 删除）" aria-haspopup="menu"'
        +   ' onclick="event.stopPropagation();ResumeEditor.toggleResumeItemMenu(\''+esc(m.id)+'\',this)"'
        +   ' onkeydown="event.stopPropagation()">···</button>'
        + '</div>';
    }).join('');
    renderDrawerThumbs(list, idx);
  });
}
/* N5：左抽屉缩略图。缓存按 id|updatedAt 失效——编辑中 updatedAt 不变 → 每键重渲染只命中缓存，
   仅在真正落盘（updatedAt 变）后重建一次，避免「每键重渲染」把缩略图生成变成性能黑洞。 */
const _drawerThumbCache = {};
function renderDrawerThumbs(listEl, idx){
  if(!listEl || !global.ResumeLibrary || typeof global.ResumeLibrary.load !== 'function') return;
  if(!global.ResumeRender || typeof global.ResumeRender.buildResumeHtml !== 'function') return;
  idx.forEach(m=>{
    const el = listEl.querySelector('.drawer-thumb[data-thumb-id="'+esc(m.id)+'"]');
    if(!el) return;
    const key = m.id+'|'+(m.updatedAt||0);
    if(_drawerThumbCache[key]){ el.innerHTML=_drawerThumbCache[key]; el.classList.remove('is-empty'); return; }
    el.classList.add('is-empty');
    global.ResumeLibrary.load(m.id).then(payload=>{
      if(!el.isConnected) return;
      const html = global.ResumeRender.buildResumeHtml(payload);
      if(!html){ el.classList.add('is-empty'); return; }
      _drawerThumbCache[key]=html; el.classList.remove('is-empty'); el.innerHTML=html;
    }).catch(()=>{ el.classList.add('is-empty'); });
  });
}

/* ============ 导出文件名管理 ============ */
function getDefaultFileNameBase(){ return (data.name || '简历').replace(/\s+/g,'_').replace(/[\\/:*?"<>|]/g,'_'); }
function loadFileNameBase(){ try{ fileNameBase = localStorage.getItem(FILENAME_BASE_KEY) || ''; }catch(e){ fileNameBase = ''; } }
function saveFileNameBase(){ try{ localStorage.setItem(FILENAME_BASE_KEY, fileNameBase); }catch(e){} }
function setFileNameBase(v){ fileNameBase = String(v==null?'':v).trim(); saveFileNameBase(); updateFileNameInput(); }
/* 同上：文件名输入框两端各一个（id 不同，避免重复 id），都要回填 */
const FILENAME_INPUT_IDS = ['filenameBase', 'filenameBaseMobile'];
function updateFileNameInput(){
  FILENAME_INPUT_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.placeholder = getDefaultFileNameBase();
    el.value = fileNameBase;
  });
}
function getFileName(suffix, ext){ const base = fileNameBase || getDefaultFileNameBase(); return base + (suffix||'') + '.' + ext; }

/* ============ 自动保存（统一分文件模型 + 内容指纹） ============
   链路：编辑 → saveState() → stableHash 指纹比对 → 800ms 防抖 → 写盘
   · 多份模式：ResumeLibrary.save(activeResumeId, payload, {lastHash})
     → <app_data_dir>/resumes/<id>.json + index.json（指纹持久化，重启后仍生效）
   · 单份模式：ResumeStore.save(payload) → default 文档（内存指纹比对）
   指纹一致 = 内容未变 → 跳过写盘，避免无意义文件 IO（与飞书自动同步同一规则）。 */
let _repoPushTimer = null;
/* 当前是否处于「磁盘写入失败 → 已退回浏览器存储」的降级态。
   降级之后每次保存都会「成功」（写进了 localStorage），若不做这个判断，
   「已保存」提示会把降级告警盖掉，用户重新误以为改动已落盘。 */
function isDegradedNow(){
  try{
    return !!(global.ResumeLibrary && typeof global.ResumeLibrary.isDegraded === 'function' && global.ResumeLibrary.isDegraded());
  }catch(e){ return false; }
}
/* 启动阶段的信息（数据从哪来、要不要 npm start）同时写到常驻状态条与旧 #autosave 上，
   让用户一进来就能看到「我的数据在哪儿」，而不是只在收起的面板里留一行字。 */
function setBootInfo(text){
  SaveStatus.markInfo(text);
  const el = document.getElementById('autosave');
  if(el) el.textContent = text;
}
/* 写盘结果统一回报到状态条：成功=已保存时刻；失败=可重试；降级态持续告警、不被成功覆盖 */
function reportSaveDone(){
  clearDirty(activeResumeId);
  if(isDegradedNow()) SaveStatus.markDegraded();
  else SaveStatus.markSaved();
}
function reportSaveFail(e){
  SaveStatus.markFailed(e && e.message ? String(e.message).slice(0, 60) : '');
}
function pushRepo(payload, hash){
  if(_libraryReady && activeResumeId && typeof global.ResumeLibrary === 'object' && global.ResumeLibrary){
    /* ⚠️ 必须写入 saveState 传入的同一份 payload：若此处再调 currentPayload() 会生成
       另一个 savedAt 的新对象，写盘内容与指纹 hash 对不上，指纹比对失去意义。 */
    try{
      const p = global.ResumeLibrary.save(activeResumeId, payload, { lastHash: hash });
      if(p && typeof p.then === 'function') p.then(reportSaveDone).catch(reportSaveFail);
      else reportSaveDone();          // 后端未返回 Promise 时按同步成功处理
    }catch(e){ reportSaveFail(e); }
  } else {
    /* 单份模式：store 内部会吞掉持久化错误，能回报就回报 */
    try{
      const r = ResumeStore.save(payload);
      if(r && typeof r.then === 'function') r.then(reportSaveDone).catch(reportSaveFail);
      else reportSaveDone();
    }catch(e){ reportSaveFail(e); }
  }
}
/* 人工重试（状态条的「重试」按钮）：清掉降级锁 → 绕过内容指纹强制再写一次盘，
   否则内容未变会被 saveState 的指纹比对直接跳过，重试就成了空动作。 */
function retrySave(){
  try{
    if(global.ResumeLibrary && typeof global.ResumeLibrary.retryDisk === 'function') global.ResumeLibrary.retryDisk();
  }catch(e){}
  SaveStatus.markSaving();
  const payload = currentPayload();
  let hash = null;
  try{
    hash = (global.ResumeFeishu && typeof global.ResumeFeishu.contentHash === 'function')
      ? global.ResumeFeishu.contentHash(payload) : null;
  }catch(e){ hash = null; }
  pushRepo(payload, hash);
}
function pushRepoDebounced(payload){
  /* 性能：把「全量内容哈希 + 指纹比对」从「每键同步」推迟到「防抖窗口结束」。
     每敲一键只做 currentPayload()（浅组装，O(1)）+ 重置定时器；真正的
     contentHash = O(整份简历) 只在这 800ms 窗口静默后算一次。连续敲 N 键从
     N 次 O(简历) 哈希降为 1 次，语义等价（「内容未变跳过写盘」仍成立，仅判定延迟到防抖结束）。 */
  if(_repoPushTimer) clearTimeout(_repoPushTimer);
  _repoPushTimer = setTimeout(function(){
    _repoPushTimer = null;
    let hash = null;
    try {
      hash = (global.ResumeFeishu && typeof global.ResumeFeishu.contentHash === 'function')
        ? global.ResumeFeishu.contentHash(payload)
        : null;
    } catch (e) { hash = null; }
    if(_libraryReady && activeResumeId && typeof global.ResumeLibrary === 'object' && global.ResumeLibrary){
      // 多份模式：lastHash 持久化在 index.json，重启后仍可跳过无变化写盘
      let lastHash = null;
      try { const m = global.ResumeLibrary.getMeta(activeResumeId); if(m) lastHash = m.lastHash || null; } catch(e){}
      if(hash !== null && lastHash !== null && hash === lastHash) return; // 内容未变，跳过
    } else {
      // 单份模式：内存指纹比对
      if(hash !== null && _defaultLastHash !== null && hash === _defaultLastHash) return;
      if(hash !== null) _defaultLastHash = hash;
    }
    pushRepo(payload, hash);
  }, 800);
}
/* 取消 pending 的防抖保存（切换简历/清空/载入目标份前调用）。
   若不取消：防抖回调里捕获的 payload 仍指向旧份的 data/fonts/spacing 引用，
   而 activeResumeId 已切到新份 → 旧份数据被写进新份文档（跨简历数据污染）。 */
function cancelPendingSave(){
  if(_repoPushTimer){ clearTimeout(_repoPushTimer); _repoPushTimer = null; }
}
function saveState(){
  const payload = currentPayload();
  // 统一内容指纹：只看 {data,fonts,spacing,v}，剔除 savedAt（每次生成必变的时间戳，
  // 混进哈希会让「内容未变跳过写盘」永不成立）；与飞书自动同步同一口径。
  // ⚠️ 哈希计算已移入 pushRepoDebounced 的防抖回调（性能债：每键全量哈希 → 防抖后一次），
  //   此处仅浅组装 payload + 打保存中标记，指纹比对统一在防抖结束时做。
  if(bootDone) SaveStatus.markSaving();   // 防抖窗口内先给出「保存中」，别让用户对着静默干等
  pushRepoDebounced(payload);
}
/* 内置初始数据（种子）：单文件构建时 DEMO_DATA 为完整示范，开发态为空骨架 */
function seedPayload(){
  const empty = { name:'', subtitle:'', subtitleBold:false, meta:'', metaBold:false, contact:[], sections:[], theme:{ id:'classic', overrides:{} } };
  return {
    data: JSON.parse(JSON.stringify((typeof DEMO_DATA !== 'undefined' && DEMO_DATA) ? DEMO_DATA : empty)),
    fonts: JSON.parse(JSON.stringify(defaultFonts)),
    spacing: JSON.parse(JSON.stringify(defaultSpacing)),
    v: SAVE_VERSION,
    savedAt: Date.now()
  };
}
/* 清空当前简历的修改，恢复到内置初始数据。
   已移除浏览器持久化（localStorage 不再存简历数据），这里同时清理旧版本残留键。 */
function clearSaved(){
  if(!confirm('确定清空当前简历的修改，恢复到内置初始数据吗？')) return;
  try{ localStorage.removeItem(SAVE_KEY); localStorage.removeItem(SAVE_KEY_LEGACY); }catch(e){}
  recordHistory('action', '重置');
  const seed = seedPayload();
  if(_libraryReady && activeResumeId && typeof global.ResumeLibrary === 'object' && global.ResumeLibrary){
    try{ global.ResumeLibrary.save(activeResumeId, seed, {}); }catch(e){}
  }
  applyPayloadWithoutSave(seed);
  renderSettings(); renderMarginSettings(); renderSpacingSettings(); renderEditor(); renderPreview(); applyPanelState();
  updateUndoButtons();
  try{ document.title = (data.name||'简历') + ' · 简历编辑器'; }catch(_){}
}
/* 保存完成时刷新反馈。主呈现已交给常驻状态条（含失败 / 降级态），这里同时更新工具菜单
   面板头里的旧 #autosave 文案，兼容展开面板时的查看习惯。降级态优先，不被「已保存」盖掉。 */
function showAutosave(){
  const degraded = isDegradedNow();
  if(degraded) SaveStatus.markDegraded(); else SaveStatus.markSaved();
  const el=document.getElementById('autosave');
  if(!el) return;
  if(degraded){ el.textContent = '⚠ 磁盘写入失败，改动暂存本浏览器'; return; }
  const t=new Date(); const p=n=>String(n).padStart(2,'0');
  el.textContent = '✓ 已自动保存 · ' + p(t.getHours())+':'+p(t.getMinutes())+':'+p(t.getSeconds());
}

/* ============ 数据导入 / 导出（JSON，脱离浏览器存储的可移植备份） ============ */
/* 导出当前全部数据为 JSON 文件，可在任意设备/浏览器导入恢复 */
function exportJSON(){
  const payload = {data, fonts: currentFonts, spacing: currentSpacing, v: SAVE_VERSION};
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
  downloadBlob(blob, getFileName('_数据', 'json'));
}
/* 导出为标准 JSON Resume（jsonresume.org/schema），供 resume-cli / Reactive Resume 等生态消费 */
function exportJSONResume(){
  const adapter = global.ResumeJSONResume;
  if(!adapter){ alert('JSON Resume 适配器未加载'); return; }
  let jr;
  try { jr = adapter.toJsonResume({ data: data }); }
  catch(e){ alert('导出 JSON Resume 失败：' + (e && e.message ? e.message : e)); return; }
  const blob = new Blob([JSON.stringify(jr, null, 2)], {type:'application/json'});
  downloadBlob(blob, getFileName('_JSONResume', 'json'));
}
/* 导入标准 JSON Resume：识别 jsonresume 结构（有 basics/work/education/skills 任一即视为），
   转为本项目模型后走 applyImported 覆盖导入；识别不出则回退到普通 JSON 导入 */
function importJSONResume(input){
  const file = input.files && input.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = e=>{
    let obj;
    try { obj = JSON.parse(e.target.result); }
    catch(err){ alert('导入失败：文件不是有效的 JSON\n' + (err && err.message ? err.message : err)); input.value=''; return; }
    const adapter = global.ResumeJSONResume;
    const looksLikeJsonResume = obj && (obj.basics || obj.work || obj.education || obj.skills);
    if(adapter && looksLikeJsonResume){
      try { obj = adapter.fromJsonResume(obj); }
      catch(err){ alert('导入 JSON Resume 失败：' + (err && err.message ? err.message : err)); input.value=''; return; }
    }
    applyImported(obj);
    input.value='';
  };
  reader.onerror = ()=>{ alert('导入失败：文件读取错误'); input.value=''; };
  reader.readAsText(file);
}
/* 由隐藏 file input 触发：读取并校验 JSON，覆盖式导入 */
function importJSON(input){
  const file = input.files && input.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = e=>{
    try{
      const obj = JSON.parse(e.target.result);
      applyImported(obj);
    }catch(err){
      alert('导入失败：文件不是有效的 JSON\n' + (err && err.message ? err.message : err));
    }
    input.value = '';
  };
  reader.onerror = ()=>{ alert('导入失败：文件读取错误'); input.value = ''; };
  reader.readAsText(file);
}
/* 导入数据的安全规范化（分享模板是简历工具的常见场景，导入面必须收紧）：
   fonts/spacing 只接受已知 key，val/mt/mb 强制数值化，label/desc 一律重置为出厂默认 ——
   防止恶意 JSON 借 label/desc/键名注入 HTML（渲染层已转义，这里是第二道防线） */
function sanitizePayload(){
  const okFonts = {};
  Object.keys(defaultFonts).forEach(function(k){
    const f = currentFonts[k] || {};
    okFonts[k] = { label: defaultFonts[k].label, desc: defaultFonts[k].desc,
      val: z(f.val) || defaultFonts[k].val, min: defaultFonts[k].min, max: defaultFonts[k].max };
  });
  currentFonts = okFonts;
  const okSpacing = {};
  Object.keys(defaultSpacing).forEach(function(k){
    const s = currentSpacing[k] || {};
    okSpacing[k] = { label: defaultSpacing[k].label, mt: z(s.mt), mb: z(s.mb) };
  });
  currentSpacing = okSpacing;
  if(!Array.isArray(data.contact)) data.contact = [];
}
/* 把一份 {data,fonts,spacing} 形态的载荷应用为当前内容（导入 / 加载仓库 data/resume.json 共用） */
function applyDataPayload(obj){
  data = obj.data;
  if(obj.fonts && typeof obj.fonts==='object') currentFonts = obj.fonts;
  if(obj.spacing && typeof obj.spacing==='object') currentSpacing = obj.spacing;
  sanitizePayload();
  lastSavedAt = Number(obj && obj.savedAt) || 0;
  data.pageMargins = data.pageMargins || JSON.parse(JSON.stringify(defaultPageMargins));
  migrateQuoteColors(data);
  migrateSpacing(data);
  if(!data.sections) data.sections = [];
  // 兼容旧数据：section 级别 pageBreak 字段缺失时补 false
  data.sections.forEach(sec=>{ if(typeof sec.pageBreak !== 'boolean') sec.pageBreak = false; });
  saveState();
  renderSettings(); renderMarginSettings(); renderSpacingSettings(); renderEditor(); renderPreview(); applyPanelState();
  updateFileNameInput();
  try{ document.title = (data.name||'简历') + ' · 简历编辑器'; }catch(_){}
  showAutosave();
}
function applyImported(obj){
  if(!obj || typeof obj!=='object' || !obj.data || !Array.isArray(obj.data.sections)){
    alert('导入失败：文件格式不正确（缺少 data.sections）');
    return;
  }
  if(!confirm('导入将用文件内容覆盖当前编辑器中的全部内容，确定继续？')) return;
  recordHistory('action', '导入');   // 导入前记录，导入结果可撤销
  applyDataPayload(obj);
  alert('✓ 已导入数据');
}
/* 与 applyDataPayload 相同，但**不触发 saveState**（用于多简历切换时载入目标份，
   避免「切换即写回」污染刚载入的文档 / 造成误 dirty） */
function applyPayloadWithoutSave(obj){
  if(!obj || !obj.data) return;
  // 载入新数据覆盖内存前，取消 pending 的防抖保存（其闭包 payload 指向旧份数据引用，
  // 若不清，会在 activeResumeId 已切到新份后触发，把旧份数据写进新份 → 跨简历污染）
  cancelPendingSave();
  data = obj.data;
  // N1：确保 data.theme 存在（缺省回退 classic），供渲染层解析调色板与持久化
  if(typeof ResumeThemeTemplates !== 'undefined' && ResumeThemeTemplates) ResumeThemeTemplates.ensureTheme(data);
  if(obj.fonts && typeof obj.fonts==='object') currentFonts = obj.fonts;
  if(obj.spacing && typeof obj.spacing==='object') currentSpacing = obj.spacing;
  sanitizePayload();
  lastSavedAt = Number(obj && obj.savedAt) || 0;
  data.pageMargins = data.pageMargins || JSON.parse(JSON.stringify(defaultPageMargins));
  migrateQuoteColors(data);
  migrateSpacing(data);
  if(!data.sections) data.sections = [];
  data.sections.forEach(sec=>{ if(typeof sec.pageBreak !== 'boolean') sec.pageBreak = false; });
  renderSettings(); renderMarginSettings(); renderSpacingSettings(); renderEditor(); renderPreview(); applyPanelState();
  updateFileNameInput();
  syncLockState();   // N3：换了简历 → 重新判定锁定态（锁定简历的编辑区必须立刻变只读）
  try{ document.title = (data.name||'简历') + ' · 简历编辑器'; }catch(_){}
}
/* 从仓库根目录 data/resume.json 加载（版本化数据源）。
   仅当通过 http(s) 打开且文件存在时生效；本地 file:// 或单文件版无法读取外部文件，会静默跳过、回退到内置默认数据。 */
async function loadRepoData(opts){
  opts = opts || {};
  if(typeof fetch !== 'function') return false;
  let res;
  try{ res = await fetch('./data/resume.json', {cache:'no-store'}); }
  catch(e){ if(!opts.silent) alert('未找到仓库 data/resume.json（需通过本地服务器打开，且文件存在）'); return false; }
  if(!res || !res.ok){ if(!opts.silent) alert('未找到仓库 data/resume.json（HTTP ' + (res?res.status:'?') + '）'); return false; }
  let obj;
  try{ obj = await res.json(); }
  catch(e){ if(!opts.silent) alert('data/resume.json 不是有效的 JSON'); return false; }
  if(!obj || !obj.data || !Array.isArray(obj.data.sections)){ if(!opts.silent) alert('data/resume.json 格式不正确（缺少 data.sections）'); return false; }
  if(!opts.silent && !confirm('将从仓库 data/resume.json 重新加载全部内容，覆盖当前编辑器数据，确定继续？')) return false;
  applyDataPayload(obj);
  if(!opts.silent) alert('✓ 已从仓库 data/resume.json 加载');
  return true;
}

/* 从仓库根目录 template.json 加载「示范数据」（公开模板的演示内容）。
   仅在 data/resume.json 不存在时作为兜底演示；经本地服务器（npm start）打开时生效，
   file:// 或单文件版无法读取外部文件，会静默跳过、回退到内置默认数据（js/data.js）。 */
async function loadTemplateData(opts){
  opts = opts || {};
  if(typeof fetch !== 'function') return false;
  let res;
  try{ res = await fetch('./template.json', {cache:'no-store'}); }
  catch(e){ return false; }
  if(!res || !res.ok) return false;
  let obj;
  try{ obj = await res.json(); }
  catch(e){ return false; }
  if(!obj || !obj.data || !Array.isArray(obj.data.sections)) return false;
  applyDataPayload(obj);
  return true;
}

/* ============ 右侧编辑面板 收起/展开（收起后简历预览占满居中） ============ */
/* 启动时恢复上次的面板状态（不回写存储） */
try{ setPaneCollapsed(localStorage.getItem(PANE_COLLAPSED_KEY) === '1', false); }catch(e){}
try{ setSidePanelOpen('toolsPanel', localStorage.getItem(SIDE_PANEL_KEY) === 'toolsPanel', false); }catch(e){}
/* 简历抽屉：桌面默认常驻展开；手机（≤640px）抽屉是全屏滑出层，启动时一律收起，
   避免把桌面遗留的 open class 带进手机首屏盖住预览（点「我的简历」再滑出） */
try{
  if(global.matchMedia && global.matchMedia('(max-width:640px)').matches){
    const md = document.getElementById('resumeDrawer');
    if(md) md.classList.remove('open');
  }
}catch(e){}

/* ============ RB 桥接：供拆出的 render/export/feishu 模块回调 app.js 内部函数与状态 ============ */
global.RB = global.RB || {};
RB.currentPayload = currentPayload;
RB.recordHistory = recordHistory;
RB.applyDataPayload = applyDataPayload;
RB.applyPayloadWithoutSave = applyPayloadWithoutSave;
RB.renderResumeTabs = renderResumeTabs;
RB.renderResumeDrawer = renderResumeDrawer;
RB.getSaveVersion = function(){ return SAVE_VERSION; };
RB.getLibraryReady = function(){ return _libraryReady; };
RB.setActiveResumeId = function(v){ activeResumeId = v; };
RB.setOpenTabs = function(v){ openTabs = v; };
RB.computePageBreaks = computePageBreaks;
/* 导出侧（export-pdf.js）的「内容区 px→mm」换算必须与分页计算同源，否则两条导出路径
   会各算一套版面几何（历史 bug：图片版纵向拉伸 4.5% 且每页少装 11mm） */
RB.getPageMetrics = getPageMetrics;
RB.beginPaperGuard = beginPaperGuard;
RB.endPaperGuard = endPaperGuard;
RB.getFileName = getFileName;
RB.saveState = saveState;
RB.drawPageGuides = drawPageGuides;
/* N11 本地版本历史（供 history-view.js 读列 / 回滚 / 手动快照） */
RB.listLocalVersions = listLocalVersions;
RB.restoreLocalVersion = restoreLocalVersion;
RB.saveManualSnapshot = saveManualSnapshot;
RB.appendLocalVersion = appendLocalVersion;

/* ============ 初始化 ============ */
/* 主题：js/theme.js 加载时已自行初始化并写好 <html> 属性；
   这里再刷一次按钮文案（防御性：若将来调整脚本加载顺序也不会漏渲） */
try{ if(themeApi()) themeApi().init(); }catch(e){}
loadFileNameBase();
renderSettings();
renderMarginSettings();
renderSpacingSettings();
renderEditor();
renderPreview();
applyPanelState();
updateFileNameInput();
try{ document.title = (data.name||'简历') + ' · 简历编辑器'; }catch(_){}
updateUndoButtons();
bootDone = true;
/* P3 移动端加固：软键盘可视区变量 + 返回键语义（任一步失败都静默，桌面 / 浏览器零影响） */
setupVisualViewport();
setupKeyboardFocusGuard();
setupMobileBackGesture();
/* M1/M2 多简历：初始化简历仓库。
   ⚠️ 已移到下方数据链末尾（loadRepoData/template 之后）串行执行——
   若与数据加载并发，IndexedDB 旧文档会覆盖基底数据并写回磁盘（污染事故根因）。 */
// 初始化数据源优先级：
//   1) 仓库 data/resume.json（用户私有实时数据，最高优先）
//   2) 否则 template.json（公开示范数据）
//   3) 都没有（如 file:// / 单文件版）→ 回退 js/data.js 内置默认数据
// 需经本地写服务（npm start）打开才能读到；file:// 或只读服务器读取失败时静默回退
loadRepoData({silent:true}).catch(()=>false).then(applied=>{
  if(applied){
    setBootInfo('✓ 已从仓库 data/resume.json 加载');
    return;
  }
  return loadTemplateData({silent:true}).then(tApplied=>{
    setBootInfo(tApplied
      ? '✓ 已加载示范数据（template.json，可编辑后导出 / 实时保存）'
      : '✓ 已加载（未连接本地写服务，编辑仅存本浏览器，请改用 npm start 启动）');
  }).catch(()=>{});
}).then(()=>{
  // 基底数据已定（磁盘 > template > 内置），此时多简历初始化才能正确仲裁新旧
  return initResumeLibrary();
}).then(()=>{
  // 按实际存储后端更新持久化状态提示（避免「未连接本地写服务，编辑仅存本浏览器」误导）
  try{
    const kind = (global.ResumeLibrary && typeof global.ResumeLibrary.backendKind === 'function')
      ? global.ResumeLibrary.backendKind() : '';
    if(kind === 'localstorage'){
      setBootInfo('⚠ 未连接本地写服务：编辑自动存入本浏览器（换浏览器 / 清缓存会丢，建议 npm start 或用 JSON 备份）');
    }
  }catch(e){}
  /* 保存状态条就位：绑定 DOM、接管存储降级通知、接上人工重试。
     放在数据链末尾（与 initResumeLibrary 同序）—— 此时 ResumeLibrary 的后端已确定，
     init 里注册的降级回调才不会挂到一个还没定型后端上。 */
  try{
    SaveStatus.init();
    SaveStatus.onRetry(retrySave);
  }catch(e){}
  // 绑定飞书后开机即自动双向同步（未绑定时 tick 内部自检绑定态、静默空转）
  try{ startAutoSync(); }catch(e){}
}).catch(()=>{});

/* 排版预设：一键缩放字号 / 间距。compact 收紧、relaxed 放宽、normal 重置为默认。
   供 TemplatesView（#/templates）点击卡片调用。 */
async function applyLayoutPreset(mode){
  if(mode === 'normal'){
    resetFonts();
    resetSpacing();
  } else {
    var fontScale = (mode === 'relaxed') ? 1.08 : 0.92;   // 其余档按 compact 收紧
    var spacingScale = (mode === 'relaxed') ? 1.2 : 0.8;
    recordHistory('action');
    Object.keys(currentFonts).forEach(function(k){
      var s = currentFonts[k];
      if(!s || typeof s.val !== 'number') return;
      var v = s.val * fontScale;
      v = Math.round(v * 10) / 10;
      if(typeof s.min === 'number') v = Math.max(s.min, v);
      if(typeof s.max === 'number') v = Math.min(s.max, v);
      s.val = v;
    });
    Object.keys(currentSpacing).forEach(function(k){
      var s = currentSpacing[k];
      if(!s) return;
      s.mt = Math.round((s.mt || 0) * spacingScale);
      s.mb = Math.round((s.mb || 0) * spacingScale);
    });
    renderSettings();
    renderSpacingSettings();
    renderPreview();
  }
  saveState();
  if(global.ResumeRouter) ResumeRouter.navigate('/editor');
}

/* ============ N1 主题模板系统：切换 / 微调 / 持久化 ============
   主题切换是可撤销操作（进撤销栈），误切可 Ctrl/Cmd+Z 恢复。
   字体 / 间距微调直接落在 currentFonts / currentSpacing（已随 payload 落盘）；
   颜色 / 纸张微调落在 data.theme.overrides（随 data 落盘，不污染内置主题定义）。 */
function applyTheme(id){
  if(typeof ResumeThemeTemplates === 'undefined' || !ResumeThemeTemplates) return;
  var tmpl = ResumeThemeTemplates.getTheme(id);
  if(!tmpl) return;
  recordHistory('action');                       // 切前记快照，撤销可回到切前
  var th = ResumeThemeTemplates.ensureTheme(data);
  th.id = id;                                    // 保留已有颜色微调（跨主题保留）
  if(!th.overrides) th.overrides = {};
  currentFonts = ResumeThemeTemplates.resolveFonts(tmpl.fonts);
  currentSpacing = ResumeThemeTemplates.resolveSpacing(tmpl.spacing);
  data.pageMargins = JSON.parse(JSON.stringify(tmpl.paper.margin));
  saveState();
  renderSettings(); renderSpacingSettings(); renderMarginSettings(); renderEditor(); renderPreview();
  if(global.ResumeRouter) ResumeRouter.navigate('/editor');
}
/* F3 颜色微调：写进 data.theme.overrides.color（随 data 落盘，不污染内置主题） */
function customizeThemeColor(key, val){
  if(typeof ResumeThemeTemplates === 'undefined' || !ResumeThemeTemplates) return;
  recordHistory('action');
  var th = ResumeThemeTemplates.ensureTheme(data);
  th.overrides.color = th.overrides.color || {};
  th.overrides.color[key] = val;
  saveState(); renderPreview();
}
/* 重置当前主题的全部微调，回到主题出厂外观 */
function resetThemeOverrides(){
  if(typeof ResumeThemeTemplates === 'undefined' || !ResumeThemeTemplates) return;
  recordHistory('action');
  var th = ResumeThemeTemplates.ensureTheme(data);
  th.overrides = {};
  var tmpl = ResumeThemeTemplates.getTheme(th.id);
  currentFonts = ResumeThemeTemplates.resolveFonts(tmpl.fonts);
  currentSpacing = ResumeThemeTemplates.resolveSpacing(tmpl.spacing);
  data.pageMargins = JSON.parse(JSON.stringify(tmpl.paper.margin));
  saveState();
  renderSettings(); renderSpacingSettings(); renderMarginSettings(); renderEditor(); renderPreview();
}
function getActiveThemeId(){
  if(typeof ResumeThemeTemplates === 'undefined' || !ResumeThemeTemplates) return 'classic';
  return ResumeThemeTemplates.ensureTheme(data).id;
}
/* 当前生效调色板（主题 color + overrides.color 合并），供主题微调面板取初值 */
function getCurrentPalette(){
  if(typeof ResumeThemeTemplates === 'undefined' || !ResumeThemeTemplates) return {};
  return ResumeThemeTemplates.resolvePalette(data) || {};
}

/* ============ N3 分享与权限控制 ============
   F1 锁定（编辑区只读）/ F2 分享开关（门禁导出分享页）/ F3 分享标识 token /
   F4 整库 JSON 备份与恢复 / F5 删除二次确认 + 可撤销。
   纯数据判定在 js/store/library-share.js（ResumeShare），这里只做接线与界面反馈。
   ⚠️ 锁定/分享状态存在简历库 meta（不写进 data），所以不随简历内容哈希变化，
     也不能走 saveState —— 统一用 ResumeLibrary.patchMeta 落盘。 */
function shareApi(){ try{ return global.ResumeShare || null; }catch(e){ return null; } }
function notifyUser(type, title, body){
  try{
    if(global.ResumeNotifier && typeof global.ResumeNotifier.notify === 'function') global.ResumeNotifier.notify(type, title, body);
  }catch(e){ /* 通知失败不影响主流程 */ }
}
/* 同步取当前激活简历的 meta（不需要 await：库索引已在内存里） */
function activeMetaSync(){
  try{
    if(!activeResumeId || !global.ResumeLibrary || typeof global.ResumeLibrary.getMeta !== 'function') return null;
    return global.ResumeLibrary.getMeta(activeResumeId);
  }catch(e){ return null; }
}
function isActiveLocked(){
  const S = shareApi();
  return !!(S && S.isLocked(activeMetaSync()));
}

/* F1：锁定 ⇄ 解锁（抽屉卡片「⋯」菜单） */
async function resumeToggleLock(id){
  if(!_libraryReady || !id) return;
  const S = shareApi();
  if(!S){ alert('分享/权限模块未加载'); return; }
  const idx = await global.ResumeLibrary.list();
  const m = idx.filter(x=>x.id===id)[0];
  if(!m) return;
  const next = !S.isLocked(m);
  try{
    await global.ResumeLibrary.patchMeta(id, { isLocked: next });
    renderResumeDrawer();
    if(id === activeResumeId) applyLockState();
  }catch(e){ alert('操作失败：' + (e && e.message ? e.message : e)); }
}

/* 主简历：设 / 取消（互斥，库里唯一）。抽屉卡片「⋯」菜单触发。 */
async function resumeSetMaster(id){
  if(!_libraryReady || !id) return;
  const L = global.ResumeLibrary;
  if(!L){ alert('简历库模块未加载'); return; }
  try{
    await L.setMaster(id);
    renderResumeDrawer();
  }catch(e){ alert('操作失败：' + (e && e.message ? e.message : e)); }
}

/* F2/F3：开启 / 关闭分享。开启时顺带发一个分享标识（token）。 */
async function setResumePublic(id, v){
  if(!_libraryReady || !id) return { ok:false };
  const S = shareApi();
  if(!S) return { ok:false };
  const idx = await global.ResumeLibrary.list();
  const m = idx.filter(x=>x.id===id)[0];
  if(!m) return { ok:false };
  const want = !!v;
  const patch = { isPublic: want };
  let freshToken = false;
  if(want && !S.tokenOf(m)){ patch.shareToken = S.genToken(); freshToken = true; }
  if(!want) patch.shareToken = null;   // 关闭分享即作废标识，下次开启重新发一个
  try{
    await global.ResumeLibrary.patchMeta(id, patch);
    renderResumeDrawer();
    if(global.ResumeMenu && typeof global.ResumeMenu.render === 'function') global.ResumeMenu.render();
    return { ok:true, freshToken: freshToken, token: want ? (patch.shareToken || S.tokenOf(m)) : '' };
  }catch(e){ return { ok:false, error: (e && e.message) || String(e) }; }
}

/* 抽屉 / 卡片菜单用：切换分享并给出结果反馈 */
async function resumeTogglePublic(id){
  if(!_libraryReady || !id) return;
  const S = shareApi();
  if(!S) return;
  const idx = await global.ResumeLibrary.list();
  const m = idx.filter(x=>x.id===id)[0];
  if(!m) return;
  const want = !S.isPublic(m);
  const r = await setResumePublic(id, want);
  if(!r || !r.ok){ alert('操作失败：' + ((r && r.error) || '未知错误')); return; }
  if(want){
    notifyUser('success', '已开启分享',
      '「' + m.title + '」已可导出只读分享页。' + (r.freshToken ? '（已生成分享标识 ' + r.token + '）' : ''));
  } else {
    notifyUser('info', '已关闭分享',
      '「' + m.title + '」之后不再允许导出分享页；已经导出发出去的静态页收不回来（本项目没有托管后端）。');
  }
}

/* F3：复制分享标识。没有标识就先补一个（历史数据可能只有 isPublic 没有 token）。 */
async function copyShareToken(id){
  if(!_libraryReady || !id) return;
  const S = shareApi();
  if(!S) return;
  const idx = await global.ResumeLibrary.list();
  const m = idx.filter(x=>x.id===id)[0];
  if(!m) return;
  if(!S.isPublic(m)){ notifyUser('warn', '还没开启分享', '先在简历卡片「⋯」里开启分享，才会生成分享标识。'); return; }
  let t = S.tokenOf(m);
  if(!t){
    t = S.genToken();
    try{ await global.ResumeLibrary.patchMeta(id, { shareToken: t }); renderResumeDrawer(); }catch(e){ return; }
  }
  try{
    await navigator.clipboard.writeText(t);
    notifyUser('success', '分享标识已复制', S.tokenNote({ shareToken: t }));
  }catch(e){ window.prompt('分享标识（请手动复制）', t); }
}

/* F3：重设分享标识（旧标识作废，仅影响之后导出的页面） */
async function resetShareToken(id){
  if(!_libraryReady || !id) return;
  const S = shareApi();
  if(!S) return;
  const idx = await global.ResumeLibrary.list();
  const m = idx.filter(x=>x.id===id)[0];
  if(!m) return;
  if(!confirm('重设分享标识？\n\n之后导出的分享页会带新标识；此前已经导出发出去的静态页无法远程吊销（本项目没有托管后端）。')) return;
  try{
    await global.ResumeLibrary.patchMeta(id, { shareToken: S.genToken() });
    renderResumeDrawer();
    notifyUser('info', '已重设分享标识', '「' + m.title + '」的分享标识已更换。');
  }catch(e){ alert('重设失败：' + (e && e.message ? e.message : e)); }
}

/* F2 门禁：导出分享页前先过 ResumeShare.shareGate。
   未开启分享时给一条「现在开启并导出」的出路，而不是把入口做成死路。 */
async function sharePageGuarded(){
  const S = shareApi();
  const meta = activeMetaSync();
  /* 取不到 meta（库未就绪 / 单份模式）→ 保持旧行为，直接导出，不因新功能把老路径弄坏 */
  if(!S || !meta){ exportSharePage(); return; }
  const gate = S.shareGate(meta);
  if(gate.allowed){ exportSharePage({ token: S.tokenOf(meta) }); return; }
  if(gate.reason === 'not-public'){
    if(!confirm(gate.message + '\n\n现在开启分享并导出分享页？')) return;
    const r = await setResumePublic(meta.id, true);
    if(r && r.ok){ exportSharePage({ token: r.token }); }
    else notifyUser('error', '开启分享失败', (r && r.error) || '未知错误');
    return;
  }
  notifyUser('warn', '无法导出分享页', gate.message);
}

/* ============ 锁定态：编辑区只读 ============
   锁定后把 .editor-pane 下的各个 `.panel` 整体设为不可交互（inert：鼠标、键盘焦点、
   读屏一并挡住）。锁定提示条本身是 .editor-pane 的直接子元素但不是 .panel，
   因此不会被自己锁住 —— 否则用户没法解锁。
   预览区不设 inert（否则长简历没法滚动），改为 CSS 隐藏 ↑↓ 排序按钮 +
   在拖拽处理器里拒绝拖拽（见 js/render/resume-render.js）。 */
function syncLockState(){
  const locked = isActiveLocked();
  try{ document.body.classList.toggle('resume-locked', locked); }catch(e){}
  const bar = document.getElementById('lockBar');
  if(bar) bar.hidden = !locked;
  const panels = document.querySelectorAll('.editor-pane > .panel');
  Array.prototype.forEach.call(panels, function(el){
    if(locked){ el.setAttribute('inert',''); el.setAttribute('aria-disabled','true'); }
    else { el.removeAttribute('inert'); el.removeAttribute('aria-disabled'); }
  });
  const tip = document.getElementById('lockBarTip');
  if(tip){
    const m = activeMetaSync();
    tip.textContent = locked
      ? ('「' + ((m && m.title) || '当前简历') + '」已锁定：编辑区只读，避免误改定稿版本。')
      : '';
  }
  return locked;
}
/* 兼容旧调用名（renderPreview 链路里用过 applyLockState） */
const applyLockState = syncLockState;

/* ============ F4 整库 JSON 备份 / 恢复 ============ */
async function exportLibraryBundle(){
  if(!_libraryReady){ alert('简历库未就绪，暂时无法备份。'); return; }
  const S = shareApi();
  if(!S){ alert('分享/权限模块未加载'); return; }
  try{
    const idx = await global.ResumeLibrary.list();
    if(!idx.length){ alert('简历库是空的，没有可备份的内容。'); return; }
    const entries = [];
    for(let i=0;i<idx.length;i++){
      const m = idx[i];
      entries.push({ meta: m, payload: await global.ResumeLibrary.load(m.id) });
    }
    const bundle = S.buildBundle(entries);
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {type:'application/json;charset=utf-8'});
    const stamp = new Date().toISOString().slice(0,10);
    const name = '简历库备份_' + stamp + '.json';
    await downloadBlob(blob, name);
    notifyUser('success', '已导出整库备份',
      '共 ' + bundle.count + ' 份简历（含标签 / 血缘 / 分享与锁定状态），文件名 ' + name + '。');
  }catch(e){ alert('导出备份失败：' + (e && e.message ? e.message : e)); }
}

/* 恢复：备份里的简历一律**新增**（不覆盖现有），meta 里的分享/锁定/标签/血缘一并还原。
   血缘用 idMap 把旧 parentId 映射到本次新分配的 id。 */
async function importLibraryBundle(file){
  const S = shareApi();
  if(!file || !S) return;
  if(!_libraryReady){ alert('简历库未就绪，暂时无法恢复。'); return; }
  let text = '';
  try{ text = await file.text(); }
  catch(e){ alert('读取备份文件失败：' + (e && e.message ? e.message : e)); return; }
  const parsed = S.parseBundle(text);
  if(!parsed.ok){ alert('导入失败：' + parsed.error); return; }
  const extra = parsed.skipped ? ('（另有 ' + parsed.skipped + ' 条正文缺失，已跳过）') : '';
  if(!confirm('将从备份导入 ' + parsed.items.length + ' 份简历' + extra + '。\n\n导入是**新增**，不会覆盖或删除现有简历。继续？')) return;
  const created = [];
  const idMap = {};
  try{
    for(let i=0;i<parsed.items.length;i++){
      const it = parsed.items[i];
      const src = it.meta || {};
      const title = src.title || ('导入的简历 ' + (i+1));
      const meta = await global.ResumeLibrary.create({
        title: title,
        payload: it.payload,
        kind: src.kind === 'derived' ? 'derived' : 'master'
      });
      if(src.id) idMap[src.id] = meta.id;
      created.push({ newId: meta.id, src: src });
    }
    /* 二次遍历回填权限 / 血缘 / 标签：create 只认 title/payload/kind，
       其余字段必须走 patchMeta（白名单）与 setTags（tags 有独立归一化逻辑）。 */
    for(let i=0;i<created.length;i++){
      const c = created[i];
      const patch = {};
      if(c.src.isPublic) patch.isPublic = true;
      if(c.src.isLocked) patch.isLocked = true;
      if(c.src.shareToken) patch.shareToken = c.src.shareToken;
      const parentId = S.resolveImportedParent({ id: c.src.id, parentId: c.src.parentId }, idMap);
      if(parentId) patch.parentId = parentId;
      if(c.src.jobId) patch.jobId = c.src.jobId;
      if(c.src.jdText) patch.jdText = c.src.jdText;
      if(Object.keys(patch).length) await global.ResumeLibrary.patchMeta(c.newId, patch);
      if(c.src.tags && c.src.tags.length) await global.ResumeLibrary.setTags(c.newId, c.src.tags);
    }
  }catch(e){
    alert('导入中断：' + (e && e.message ? e.message : e) + '\n已导入 ' + created.length + ' 份。');
  }
  /* create 会把库内激活态挪到最后一份，这里拉回编辑器真正的激活简历，避免两侧漂移 */
  try{ if(activeResumeId) await global.ResumeLibrary.setActive(activeResumeId); }catch(e){}
  renderResumeDrawer();
  notifyUser(created.length ? 'success' : 'warn', '备份导入完成',
    created.length ? ('已新增 ' + created.length + ' 份简历（分享 / 锁定 / 标签 / 血缘一并还原）。')
                   : '没有导入任何简历。');
  if(global.LibraryView && document.body.classList.contains('route-library') && typeof global.LibraryView.refresh === 'function'){
    try{ global.LibraryView.refresh(); }catch(e){}
  }
}

/* ============ F5 删除：二次确认 + 10 秒内可撤销 ============ */
let _undoTimer = null;
function hideUndoToast(){
  if(_undoTimer){ clearTimeout(_undoTimer); _undoTimer = null; }
  const el = document.getElementById('undoToast');
  if(el) el.classList.remove('show');
}
/* 删除反馈用独立小条而不是消息中心：撤销是有时效的动作，藏进铃铛里等于没有 */
function showUndoToast(text, onUndo){
  let el = document.getElementById('undoToast');
  if(!el){
    el = document.createElement('div');
    el.id = 'undoToast';
    el.className = 'undo-toast';
    el.setAttribute('role','status');
    el.setAttribute('aria-live','polite');
    document.body.appendChild(el);
  }
  el.innerHTML = '<span class="undo-toast-text"></span><button type="button" class="undo-toast-btn">撤销</button>';
  el.querySelector('.undo-toast-text').textContent = text;
  el.querySelector('.undo-toast-btn').onclick = function(){ hideUndoToast(); try{ onUndo(); }catch(e){} };
  el.classList.add('show');
  if(_undoTimer) clearTimeout(_undoTimer);
  _undoTimer = setTimeout(hideUndoToast, 10000);
}

async function resumeUndoRemove(){
  if(!_libraryReady) return;
  try{
    const restored = await global.ResumeLibrary.undoRemove();
    if(!restored || !restored.length) return;
    renderResumeTabs(); renderResumeDrawer();
    notifyUser('success', '已撤销删除',
      '找回 ' + restored.length + ' 份简历：' + restored.map(x=>x.title).join('、'));
    if(!activeResumeId && restored[0]){
      activeResumeId = restored[0].id;
      const doc = await global.ResumeLibrary.load(activeResumeId);
      if(doc && doc.data) applyPayloadWithoutSave(doc);
      await global.ResumeLibrary.setActive(activeResumeId);
      renderResumeDrawer();
    }
  }catch(e){ notifyUser('error', '撤销失败', (e && e.message) || String(e)); }
}

/* 清空全部（#/library 头部与工具菜单）：两次确认，删除后仍可撤销 */
async function removeAllResumes(){
  if(!_libraryReady) return;
  const idx = await global.ResumeLibrary.list();
  if(!idx.length){ alert('简历库已经是空的。'); return; }
  if(!confirm('将删除全部 ' + idx.length + ' 份简历（含正文文件）。\n\n删除后 10 秒内可点「撤销」找回，超过就找不回来了。确定继续？')) return;
  if(!confirm('再次确认：真的要清空这 ' + idx.length + ' 份简历吗？')) return;
  try{
    cancelPendingSave();
    global.ResumeLibrary.beginRemoveBatch();
    for(let i=0;i<idx.length;i++){ await global.ResumeLibrary.remove(idx[i].id); if(localHistory()){ try{ await localHistory().removeAll(idx[i].id); }catch(e){} } }
    activeResumeId = null; openTabs = []; dirtySet.clear();
    renderResumeTabs(); renderResumeDrawer(); syncLockState();
    if(global.ResumeRouter) global.ResumeRouter.navigate('/library');
    showUndoToast('已清空 ' + idx.length + ' 份简历', resumeUndoRemove);
  }catch(e){ alert('清空失败：' + (e && e.message ? e.message : e)); }
}

/* 工具菜单 / 手机同步页里的入口都是无参表达式（统一清单，两端同源），
   所以这里提供一组「作用于当前激活简历」的变体，内部再转发到带 id 的实现。 */
function noActiveResumeTip(){
  notifyUser('warn', '没有打开的简历', '先在左侧「我的简历」里选择或新建一份简历。');
}
function toggleActiveLock(){
  if(!activeResumeId) return noActiveResumeTip();
  return resumeToggleLock(activeResumeId);
}
function toggleActivePublic(){
  if(!activeResumeId) return noActiveResumeTip();
  return resumeTogglePublic(activeResumeId);
}
function copyActiveShareToken(){
  if(!activeResumeId) return noActiveResumeTip();
  return copyShareToken(activeResumeId);
}
/* 「从备份恢复」在工具菜单里无法传 file 参数：动态建一个隐藏 file input 再点它。
   同一个文件连续导入两次也要生效 → change 里先清空 value。 */
function pickLibraryBundle(){
  let input = document.getElementById('libraryBundleFile');
  if(!input){
    input = document.createElement('input');
    input.type = 'file';
    input.id = 'libraryBundleFile';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    input.addEventListener('change', function(){
      const f = input.files && input.files[0];
      input.value = '';
      if(f) importLibraryBundle(f);
    });
    document.body.appendChild(input);
  }
  input.click();
}

/* ============ N9 导出为个人官网 ============
   产物是简历数据的**第五种渲染格式**：单个自包含 HTML（内联 CSS、零外部依赖），
   双击可开、可直接丢 GitHub Pages / Vercel。渲染是纯函数，在 js/render/portfolio-html.js；
   这里只负责「脱敏确认 → 生成 → 预览 / 下载 → 部署指引 + 附言」的接线。
   ⚠️ 三条护栏：官网不替代 PDF、公开前默认脱敏、数字与公司名永远来自用户已录入数据。 */
/* 脱敏偏好的持久化位置：localStorage（与主题 / 抽屉 / 侧栏等界面偏好一致）。
   ⚠️ 刻意**不写** sync.config.json（技术设计方案 §5.4 的原始设想）：
   sync.config.json 只有 npm start 起的本地服务能读写，而官网导出必须在
   「双击打开的单文件 HTML」这种无服务端形态下也能用，写在那里等于单文件版永远记不住。 */
const PF_PRIVACY_KEY = 'resume_portfolio_privacy_v1';
const PF_DEFAULT_PRIVACY = { hideSensitive: true, maskEmail: false, embedFullResume: false };
/* 生成后的产物暂存在内存里，供「预览 / 下载」两个按钮复用（不进 localStorage：正文太大） */
let _pfResult = null;

function pfEsc(s){
  return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
/* 官网渲染模块：缺失时明确报错，不静默导出一个没有内容的「官网」 */
function portfolioApi(){
  const P = global.ResumePortfolio;
  if(!P || typeof P.buildPortfolioHtml !== 'function'){
    throw new Error('缺少 js/render/portfolio-html.js，无法导出个人官网');
  }
  return P;
}
function readPortfolioPrivacy(){
  try{
    const raw = localStorage.getItem(PF_PRIVACY_KEY);
    if(!raw) return Object.assign({}, PF_DEFAULT_PRIVACY);
    const o = JSON.parse(raw) || {};
    return {
      hideSensitive: o.hideSensitive !== false,
      maskEmail: !!o.maskEmail,
      embedFullResume: !!o.embedFullResume
    };
  }catch(e){ return Object.assign({}, PF_DEFAULT_PRIVACY); }
}
function writePortfolioPrivacy(p){
  try{ localStorage.setItem(PF_PRIVACY_KEY, JSON.stringify({
    hideSensitive: !!p.hideSensitive, maskEmail: !!p.maskEmail, embedFullResume: !!p.embedFullResume
  })); }catch(e){ /* 存储不可用不影响本次导出 */ }
}
/* 表单（三个勾选项）↔ 隐私对象 */
function readPortfolioForm(){
  const on = function(id){ const el = document.getElementById(id); return !!(el && el.checked); };
  return { hideSensitive: on('pfHideSensitive'), maskEmail: on('pfMaskEmail'), embedFullResume: on('pfEmbedFull') };
}
function applyPortfolioForm(p){
  const set = function(id, v){ const el = document.getElementById(id); if(el) el.checked = !!v; };
  set('pfHideSensitive', p.hideSensitive);
  set('pfMaskEmail', p.maskEmail);
  set('pfEmbedFull', p.embedFullResume);
}
/* 弹层两步切换 */
function showPortfolioStep(step){
  const c = document.getElementById('pfStepConfirm');
  const d = document.getElementById('pfStepDone');
  if(c) c.hidden = (step !== 'confirm');
  if(d) d.hidden = (step !== 'done');
}
function openPortfolioModal(){ const m = document.getElementById('portfolioModal'); if(m) m.style.display = 'flex'; }
function closePortfolioModal(){
  const m = document.getElementById('portfolioModal'); if(m) m.style.display = 'none';
  _pfResult = null;
}
/* 逐条列出「会上官网 / 不会上官网」——把脱敏结果摊开给用户核对，而不是只给一句「已脱敏」 */
function refreshPortfolioPublicList(){
  const el = document.getElementById('pfPublicList');
  if(!el) return;
  const P = global.ResumePortfolio;
  if(!P || typeof P.redact !== 'function'){ el.innerHTML = '<span class="pf-empty-tip">官网渲染模块未加载。</span>'; return; }
  const r = P.redact(data, readPortfolioForm());
  const chips = function(arr){
    return arr.map(function(x){ return '<code>' + pfEsc(x.text) + '</code>'; }).join(' ');
  };
  el.innerHTML =
    '<div class="pf-pub-t">✓ 会上官网（公开可见）</div><div>'
      + (r.published.length ? chips(r.published) : '<span class="pf-empty-tip">（没有联系方式会被公开）</span>') + '</div>'
    + '<div class="pf-pub-t">✕ 不会上官网</div><div>'
      + (r.hidden.length ? chips(r.hidden) : '<span class="pf-empty-tip">（没有需要隐藏的内容）</span>') + '</div>'
    + (r.masked.length ? '<div class="pf-pub-t">↺ 已被占位替换</div><div>' + chips(r.masked) + '</div>' : '');
}
/* 入口：菜单「导出为个人官网」 → 先弹脱敏确认 */
function exportPortfolioSite(){
  try{ portfolioApi(); }
  catch(e){ notifyUser('error', '导出失败', e.message); return; }
  if(!data){ notifyUser('warn', '没有可导出的简历', '先新建或打开一份简历。'); return; }
  applyPortfolioForm(readPortfolioPrivacy());
  refreshPortfolioPublicList();
  showPortfolioStep('confirm');
  openPortfolioModal();
}
function pfTodayStr(){
  try{
    const d = new Date();
    const p = function(n){ return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate());
  }catch(e){ return ''; }
}
/* 第二步：生成 HTML → 展示部署指引 + 附言；预览 / 下载复用产物 */
function runPortfolioExport(){
  let P;
  try{ P = portfolioApi(); }
  catch(e){ notifyUser('error', '导出失败', e.message); return; }
  if(!data){ notifyUser('warn', '没有可导出的简历', '先新建或打开一份简历。'); return; }
  const privacy = readPortfolioForm();
  writePortfolioPrivacy(privacy);
  const baseName = String(data.name || '').trim() || '我的';
  const fileName = baseName + '-个人官网.html';
  let html;
  try{
    html = P.buildPortfolioHtml({ data: data, privacy: privacy, generatedAt: pfTodayStr() });
  }catch(e){
    notifyUser('error', '生成失败', (e && e.message) || String(e));
    return;
  }
  _pfResult = {
    html: html, fileName: fileName, name: baseName, privacy: privacy,
    /* 相对路径封面在单文件官网上会 404 —— 必须提示，而不是导出一个「有几张图裂了」的官网 */
    relativeCovers: (typeof P.relativeCoverCount === 'function') ? P.relativeCoverCount(data) : 0
  };
  renderPortfolioDone();
}
function renderPortfolioDone(){
  const box = document.getElementById('pfStepDone');
  if(!box || !_pfResult) return;
  const P = global.ResumePortfolio;
  const st = _pfResult;
  const notes = (P && typeof P.buildDeployNotes === 'function') ? P.buildDeployNotes(st.fileName) : '';
  /* 附言里的链接留空：应用不知道用户最终部署到哪个域名，给占位符让他自己粘 */
  const pitch = (P && typeof P.buildPitch === 'function') ? P.buildPitch(st.name, '') : '';
  const warns = [];
  if(st.relativeCovers){
    warns.push('有 ' + st.relativeCovers + ' 张封面图用的是相对路径，部署时要连同图片一起上传，否则官网里会显示不出来。');
  }
  if(!st.privacy.hideSensitive){
    warns.push('你取消了「隐藏手机号 / 住址 / 身份证 / 期望薪资」——这些内容会写进公开网页，请再确认一次。');
  }
  box.innerHTML =
    '<h3>已生成：' + pfEsc(st.fileName) + '</h3>'
    + '<p class="pf-ok">官网是<b>单个 HTML 文件</b>，可以直接双击打开；下载后拖到 Netlify / Vercel，'
      + '或推到 GitHub 仓库开 Pages，就能拿到一个公开链接。</p>'
    + warns.map(function(w){ return '<p class="pf-ok pf-warn">⚠️ ' + pfEsc(w) + '</p>'; }).join('')
    + '<div class="pf-deploy">' + pfEsc(notes) + '</div>'
    + '<label class="pf-label-sm" for="pfPitch">可复制到招聘软件的附言（把链接占位符换成你的官网地址）</label>'
    + '<textarea class="pf-pitch" id="pfPitch" readonly>' + pfEsc(pitch) + '</textarea>'
    + '<div class="pf-row">'
    + '<button type="button" onclick="ResumeEditor.copyPortfolioPitch()">复制附言</button>'
    + '<button type="button" onclick="ResumeEditor.previewPortfolio()">预览官网</button>'
    + '<button type="button" class="primary" onclick="ResumeEditor.downloadPortfolio()">下载 HTML</button>'
    + '</div>';
  showPortfolioStep('done');
}
function pfBlob(){
  if(!_pfResult) return null;
  try{ return new Blob([_pfResult.html], { type: 'text/html;charset=utf-8' }); }
  catch(e){ return null; }
}
/* 预览：复用统一的导出预览弹层（它在 DOM 里排在官网弹层之后，会盖在上面） */
function previewPortfolio(){
  if(!_pfResult) return;
  const blob = pfBlob();
  if(!blob){ notifyUser('error', '预览失败', '当前环境不支持 Blob'); return; }
  const url = URL.createObjectURL(blob);
  const show = global.ResumeExport && global.ResumeExport.showExportModal;
  if(typeof show === 'function') show('html', blob, url, _pfResult.fileName, '个人官网预览');
  else notifyUser('error', '预览失败', '导出预览模块未加载');
}
function downloadPortfolio(){
  if(!_pfResult) return;
  const blob = pfBlob();
  if(!blob){ notifyUser('error', '下载失败', '当前环境不支持 Blob'); return; }
  const dl = global.ResumeExport && global.ResumeExport.downloadBlob;
  if(typeof dl === 'function'){ dl(blob, _pfResult.fileName); notifyUser('success', '已导出个人官网', _pfResult.fileName); return; }
  notifyUser('error', '下载失败', '下载模块未加载');
}
async function copyPortfolioPitch(){
  const ta = document.getElementById('pfPitch');
  const text = ta ? ta.value : '';
  if(!text) return;
  const done = function(){ notifyUser('success', '附言已复制', '粘贴到招聘软件的沟通框即可（记得先替换链接占位符）。'); };
  try{
    if(global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText){
      await global.navigator.clipboard.writeText(text);
      done();
      return;
    }
  }catch(e){ /* 剪贴板被拒 → 退回手动复制 */ }
  window.prompt('附言（请手动复制）', text);
}

/* ============ 对外命名空间（集中挂载，避免污染全局 window） ============ */
/* 仅 index.html 内联事件所需的函数，以及测试 / 调试用内部函数，暴露在此对象上；
   其余所有辅助函数 / 变量均为 IIFE 私有，不再泄漏到全局作用域。 */
global.ResumeEditor = {
  // —— 供 index.html 内联 onclick / onchange 调用 ——
  toggleGuides: toggleGuides,
  exportPDF: exportPDF,
  exportJSON: exportJSON,
  exportJSONResume: exportJSONResume,
  exportLongImage: exportLongImage,
  exportSingleFileHTML: exportSingleFileHTML,
  exportSharePage: exportSharePage,
  closeExportModal: closeExportModal,
  doExportDownload: doExportDownload,
  setFileNameBase: setFileNameBase,
  importJSON: importJSON,
  importJSONResume: importJSONResume,
  loadRepoData: loadRepoData,
  clearSaved: clearSaved,
  reportToFeishu: reportToFeishu,
  pullFromFeishu: pullFromFeishu,
  restoreFromFeishu: restoreFromFeishu,
  toggleMenu: toggleMenu,
  openFeishuConfig: openFeishuConfig,
  closeFeishuConfig: closeFeishuConfig,
  saveFeishuConfig: saveFeishuConfig,
  probeFeishuConfig: probeFeishuConfig,
  startFeishuOauth: startFeishuOauth,
  refreshFeishuOauth: refreshFeishuOauth,
  revokeFeishuOauth: revokeFeishuOauth,
  checkFeishuOauthStatus: checkFeishuOauthStatus,
  startFeishuRegister: startFeishuRegister,
  cancelFeishuRegister: cancelFeishuRegister,
  importResumeFile: importResumeFile,
  importResumePayload: importResumePayload,
  pickResumeSource: pickResumeSource,
  toggleEditorPane: toggleEditorPane,
  toggleSidePanel: toggleSidePanel,
  setSidePanelOpen: setSidePanelOpen,
  toggleTheme: toggleTheme,
  setThemeMode: setThemeMode,
  togglePaperTheme: togglePaperTheme,
  setMobileView: setMobileView,
  handleMobileBack: handleMobileBack,
  currentMobileView: currentMobileView,
  closeVisibleModal: closeVisibleModal,
  undo: undo,
  redo: redo,
  isEditableTarget: isEditableTarget,
  resetSpacing: resetSpacing,
  applyLayoutPreset: applyLayoutPreset,
  applyTheme: applyTheme,
  customizeThemeColor: customizeThemeColor,
  resetThemeOverrides: resetThemeOverrides,
  getActiveThemeId: getActiveThemeId,
  getCurrentPalette: getCurrentPalette,
  resetMargins: resetMargins,
  closePdfModal: closePdfModal,
  downloadPDFNow: downloadPDFNow,
  // —— 多简历（M1/M2）——
  toggleResumeDrawer: toggleResumeDrawer,
  openResume: openResume,
  switchResume: switchResume,
  /* P0 路由层用：取当前激活简历 id（闭包变量，只读） */
  getActiveResumeId: function () { return activeResumeId; },
  setActiveResumeId: function (v) { activeResumeId = v; },
  resumeNew: resumeNew,
  resumeDuplicate: resumeDuplicate,
  resumeDeriveFromJd: resumeDeriveFromJd,
  resumeRemove: resumeRemove,
  resumeRename: resumeRename,
  resumeSetTags: resumeSetTags,
  resumeSetMaster: resumeSetMaster,
  resumeCloseTab: resumeCloseTab,
  /* —— N3 分享与权限控制 —— */
  resumeToggleLock: resumeToggleLock,
  resumeTogglePublic: resumeTogglePublic,
  setResumePublic: setResumePublic,
  copyShareToken: copyShareToken,
  resetShareToken: resetShareToken,
  sharePageGuarded: sharePageGuarded,
  exportLibraryBundle: exportLibraryBundle,
  importLibraryBundle: importLibraryBundle,
  removeAllResumes: removeAllResumes,
  resumeUndoRemove: resumeUndoRemove,
  toggleActiveLock: toggleActiveLock,
  toggleActivePublic: toggleActivePublic,
  copyActiveShareToken: copyActiveShareToken,
  pickLibraryBundle: pickLibraryBundle,
  // —— N9 导出为个人官网（菜单入口 + 确认弹层 + 预览 / 下载 / 复制附言）——
  exportPortfolioSite: exportPortfolioSite,
  runPortfolioExport: runPortfolioExport,
  closePortfolioModal: closePortfolioModal,
  refreshPortfolioPublicList: refreshPortfolioPublicList,
  previewPortfolio: previewPortfolio,
  downloadPortfolio: downloadPortfolio,
  copyPortfolioPitch: copyPortfolioPitch,
  syncLockState: syncLockState,
  isActiveLocked: isActiveLocked,
  renderResumeDrawer: renderResumeDrawer,
  toggleResumeItemMenu: toggleResumeItemMenu,
  closeResumeItemMenu: closeResumeItemMenu,
  // —— 供平行模块（js/audit.js 体检、js/export-extra.js 导出）只读取当前数据 ——
  // 只读用途：体检 / 导出；外部需要改数据请走 applyImported，勿直接改返回的 data
  getData: function(){ return { data: data, fonts: currentFonts, spacing: currentSpacing }; },
  getActiveResumeId: function(){ return activeResumeId || 'default'; },
  // —— 供单元测试 / 调试复用（非公开 API） ——
  blankSection: blankSection,
  blankItem: blankItem,
  recordHistory: recordHistory,
  hist: hist,
  saveState: saveState,
  cancelPendingSave: cancelPendingSave,
  applyImported: applyImported,
  renderResumeInner: renderResumeInner,
  migrateSpacing: migrateSpacing,
  migratePageBreaks: migratePageBreaks,
  getFileName: getFileName,
  SAVE_KEY: SAVE_KEY,
  SAVE_KEY_LEGACY: SAVE_KEY_LEGACY,
  // —— N11 本地版本历史（供测试 / 外部调用）——
  listLocalVersions: listLocalVersions,
  restoreLocalVersion: restoreLocalVersion,
  saveManualSnapshot: saveManualSnapshot
};
}) (typeof window !== 'undefined' ? window : globalThis);
