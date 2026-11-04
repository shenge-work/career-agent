/* =============================================================
 * 编辑面板收起/展开 + 右缘侧栏面板 + 移动端视图切换 + 模态/返回键
 * -------------------------------------------------------------
 * 从 js/app.js 物理拆分。纯 DOM / localStorage 操作，无业务回调。
 * 挂 window.ResumeUI 供 app.js 解构复用。
 * ============================================================= */
(function(global){
"use strict";

const PANE_COLLAPSED_KEY = 'resume_editor_pane_collapsed_v1';
function setPaneCollapsed(collapsed, persist){
  const app = document.querySelector('.app');
  if (!app) return;
  app.classList.toggle('pane-collapsed', collapsed);
  const tab = document.getElementById('paneTab');
  const arrow = document.getElementById('paneTabArrow');
  const menuBtn = document.getElementById('paneToggleBtn');
  if (tab) { tab.title = (collapsed ? '展开' : '收起') + '编辑面板 (Ctrl/Cmd+B)'; tab.classList.toggle('active', !collapsed); }
  if (arrow) arrow.textContent = collapsed ? '‹' : '›';
  if (menuBtn) menuBtn.textContent = collapsed ? '展开编辑面板' : '收起编辑面板';
  /* 互斥（多选一）：编辑面板展开时，收起所有右缘浮动面板（persist 跟随本次调用） */
  if (!collapsed) {
    document.querySelectorAll('.side-panel.open').forEach(p => setSidePanelOpen(p.id, false, persist));
  }
  if (persist !== false) { try{ localStorage.setItem(PANE_COLLAPSED_KEY, collapsed ? '1' : ''); }catch(e){} }
}
function toggleEditorPane(){
  const app = document.querySelector('.app');
  setPaneCollapsed(!(app && app.classList.contains('pane-collapsed')));
}

/* ============ 右缘侧边标签 + 右缘推展面板（可扩展多个；同一时间只展开一个） ============
   规划：每个 .pane-tab[data-panel] 配一个 .side-panel#<data-panel>；
   rail 自上而下堆叠；面板是 .app 的 flex 兄弟列，与 .editor-pane 同款右缘推展
   （通栏到底、宽 460，展开时把预览推窄），不是浮动小卡片；
   展开状态记 localStorage（键 SIDE_PANEL_KEY，值为面板 id 或空）。
   互斥规则（多选一）：推展面板与右侧编辑面板共用右缘，展开任一方即收起另一方；
   面板彼此之间也互斥——用户逐个点开看，不存在同时展开多个的场景。 */
const SIDE_PANEL_KEY = 'resume_side_panel_open_v1';
function syncSideRail(){
  document.querySelectorAll('.side-rail .pane-tab[data-panel]').forEach(btn => {
    const p = document.getElementById(btn.getAttribute('data-panel'));
    if (!p) return;
    const open = p.classList.contains('open');
    btn.classList.toggle('active', open);
    const arrow = btn.querySelector('.pane-tab-arrow');
    if (arrow) arrow.textContent = open ? '\u203a' : '\u2039'; // › 展开中(点收起) / ‹ 已收起(点展开)
    const label = btn.querySelector('.pane-tab-label');
    btn.title = (open ? '收起' : '展开') + (label ? label.textContent : '');
  });
}
/* BUG-03 修复：互斥折叠只做了一半——展开侧栏会折叠编辑面板，收起侧栏却不还原。
   这里用模块级标记记住「本次展开侧栏时，编辑面板是否是被互斥强制折叠的」，
   收起时若确是被互斥折叠的，则自动恢复编辑面板展开态（回到用户打开侧栏前的样子）。 */
let paneCollapsedBySidePanel = false;
function setSidePanelOpen(panelId, open, persist){
  const panel = document.getElementById(panelId);
  if (!panel) return;
  if (open) {
    /* 互斥（多选一）：浮动面板展开时，收起右侧编辑面板（persist 跟随本次调用） */
    const app = document.querySelector('.app');
    const wasExpanded = app && !app.classList.contains('pane-collapsed');
    if (wasExpanded) setPaneCollapsed(true, persist);
    /* 仅当「本次展开侧栏确实折叠了原本展开的编辑面板」才记恢复标记，
       避免侧栏 A 切侧栏 B 时把前一次的恢复意图带过来 */
    paneCollapsedBySidePanel = !!wasExpanded;
    document.querySelectorAll('.side-panel.open').forEach(p => { if (p.id !== panelId) p.classList.remove('open'); });
  } else {
    /* 收起侧栏：若编辑面板此前是被本侧栏互斥折叠的，自动恢复展开态 */
    if (paneCollapsedBySidePanel) {
      paneCollapsedBySidePanel = false;
      const app = document.querySelector('.app');
      if (app && app.classList.contains('pane-collapsed')) setPaneCollapsed(false, persist);
    }
  }
  panel.classList.toggle('open', open);
  /* N3：工具菜单里的「导出分享页」是否可用，取决于当前简历有没有开启分享（menu-actions
     的 enabled 判定）。每次展开都重渲染一遍，避免按钮停在打开面板那一刻的旧快照。 */
  if (open && panelId === 'toolsPanel' && global.ResumeMenu && typeof global.ResumeMenu.render === 'function') {
    try { global.ResumeMenu.render(); } catch (e) {}
  }
  syncSideRail();
  if (persist !== false) { try{ localStorage.setItem(SIDE_PANEL_KEY, open ? panelId : ''); }catch(e){} }
}
function toggleSidePanel(panelId){
  const panel = document.getElementById(panelId);
  setSidePanelOpen(panelId, !(panel && panel.classList.contains('open')));
}
/* 点击面板与标签栏以外的空白处收起（点面板内按钮不受影响） */
document.addEventListener('click', (e) => {
  if (e.target.closest('.side-panel') || e.target.closest('.side-rail')) return;
  document.querySelectorAll('.side-panel.open').forEach(p => setSidePanelOpen(p.id, false));
});
/* 手机视图切换：preview / edit / sync（仅新增，不影响桌面布局与渲染逻辑） */
function setMobileView(view){
  const app = document.querySelector('.app');
  if (!app) return;
  const prevView = currentMobileView();
  app.classList.remove('mv-preview','mv-edit','mv-sync');
  app.classList.add('mv-' + view);
  document.querySelectorAll('.mobile-tabbar button').forEach(b=>{
    b.classList.toggle('active', b.getAttribute('data-mv') === view);
  });
  applyPreviewScale();   // 预览页从隐藏变为可见后重新等比缩放
  /* N3：手机「同步 / 工具」页与桌面工具菜单同源，进入时同样刷新一次可用性状态 */
  if (view === 'sync' && global.ResumeMenu && typeof global.ResumeMenu.render === 'function') {
    try { global.ResumeMenu.render(); } catch (e) {}
  }
  /* P3 返回键钩子：只在 preview ↔ 非 preview 之间切换时动 history，避免连点堆积 */
  try{
    if(mvHistoryLocked) return;
    if(view !== 'preview' && prevView === 'preview') pushMobileHistory(view);
    else if(view === 'preview' && prevView !== 'preview') consumeMobileHistory();
  }catch(e){}
}

/* ============ P3 返回键语义（移动端加固） ============
   手机按系统返回键 / 浏览器后退时的优先级：
     1) 有可见弹层 → 只关弹层，不改变视图；
     2) 当前不是预览视图 → 回到预览视图；
     3) 已在预览视图且无弹层 → 允许真正后退（不把用户困住，也不无故拦截离开页面）。
   实现：History API（浏览器可实测）+ Tauri 原生返回事件（能力探测，不可用则静默跳过）。
   约束：只在 setMobileView 内挂钩子，不触碰渲染 / recordHistory / undo / redo；全程 try/catch。 */
let mvHistoryLocked = false;   // popstate 处理期间锁住 history 钩子，避免递归
function currentMobileView(){
  try{
    const app = document.querySelector('.app');
    if(!app) return 'preview';
    if(app.classList.contains('mv-edit')) return 'edit';
    if(app.classList.contains('mv-sync')) return 'sync';
  }catch(e){}
  return 'preview';
}
/* 弹层靠 inline display:flex 显示（见 exportPDF / showExportModal），这里按「当前可见」判定 */
function visibleModal(){
  try{
    const list = document.querySelectorAll('.pdf-modal');
    let found = null;
    for(let i=0;i<list.length;i++){
      const el = list[i];
      const cs = (typeof global.getComputedStyle === 'function') ? global.getComputedStyle(el) : null;
      if(el.style.display === 'flex' || (cs && cs.display !== 'none')) found = el;
    }
    return found;
  }catch(e){ return null; }
}
function closeVisibleModal(){
  try{
    const m = visibleModal();
    if(!m) return false;
    if(m.id === 'pdfModal'){ closePdfModal(); return true; }
    if(m.id === 'exportModal'){ closeExportModal(); return true; }
    if(m.id === 'feishuConfigModal'){ closeFeishuConfig(); return true; }
    m.style.display = 'none';
    return true;
  }catch(e){ return false; }
}
function pushMobileHistory(view){
  try{
    if(!global.history || typeof global.history.pushState !== 'function') return;
    global.history.pushState({ mv: view }, '');
  }catch(e){}
}
/* 回到预览视图时消费掉之前压入的那条历史，保持 history 与视图状态一致 */
function consumeMobileHistory(){
  try{
    const h = global.history;
    if(!h || !h.state || !h.state.mv || typeof h.back !== 'function') return;
    h.back();
  }catch(e){}
}
function onMobilePopState(){
  if(mvHistoryLocked) return;
  mvHistoryLocked = true;
  try{
    if(closeVisibleModal()){
      /* 这次后退已被浏览器消费（用来关弹层），补回一条状态，避免下一次后退直接离页 */
      pushMobileHistory(currentMobileView());
      return;
    }
    if(currentMobileView() !== 'preview') setMobileView('preview');
  }catch(e){
  }finally{ mvHistoryLocked = false; }
}
/* 返回动作的统一入口：返回 true 表示已被应用消费（原生壳 / 测试可直接调它） */
function handleMobileBack(){
  try{
    if(closeVisibleModal()) return true;
    if(currentMobileView() !== 'preview'){ setMobileView('preview'); return true; }
  }catch(e){}
  return false;
}
/* 原生壳返回事件：Tauri 2 未内置统一的 back 事件，故做能力探测——命中 API 才监听，
   拿不到就静默跳过、绝不报错。Android WebView 的系统返回键本身会触发 history.back()，
   所以上面那条浏览器路径已覆盖绝大多数场景。 */
function setupNativeBack(){
  try{
    const T = global.__TAURI__;
    if(!T) return false;
    const evt = T.event || (T.core && T.core.event);
    if(!evt || typeof evt.listen !== 'function') return false;
    ['tauri://back-button','back-button','android-back','onBackPressed'].forEach(name=>{
      try{
        const p = evt.listen(name, ()=>{ handleMobileBack(); });
        if(p && typeof p.then === 'function') p.catch(()=>{});
      }catch(e){}
    });
    return true;
  }catch(e){ return false; }
}
function setupMobileBackGesture(){
  try{
    if(global.history && typeof global.addEventListener === 'function'){
      global.addEventListener('popstate', onMobilePopState);
    }
  }catch(e){}
  setupNativeBack();
}

/* ============ P3 软键盘可视区（移动端加固） ============
   把 visualViewport 的可视高度 / 键盘高度写进 CSS 变量 --vvh / --kb；
   只有 css/style.css 里 ≤640px 的媒体查询消费它们，桌面 / 平板零变化。
   没有 visualViewport 时退化为 window.innerHeight（键盘高度按 0），再不行就完全不动
   （CSS 侧有 var(--vvh,100vh) / var(--kb,0px) 兜底）。 */
function setupVisualViewport(){
  try{
    const root = document.documentElement;
    if(!root || !root.style || typeof root.style.setProperty !== 'function') return;
    const vv = global.visualViewport;
    if(!vv || typeof vv.addEventListener !== 'function'){
      const fallback = ()=>{
        try{
          root.style.setProperty('--vvh', global.innerHeight + 'px');
          root.style.setProperty('--kb', '0px');
        }catch(e){}
      };
      fallback();
      global.addEventListener('resize', fallback);
      return;
    }
    const update = ()=>{
      try{
        const h = vv.height || global.innerHeight;
        // Android：软键盘弹出时 innerHeight 同步变矮 → kb≈0（Tab 自然贴住键盘上沿）
        // iOS：innerHeight 不变而 vv.height 变矮 → kb>0，把 Tab 顶到键盘之上
        const kb = Math.max(0, (global.innerHeight || h) - h - (vv.offsetTop || 0));
        root.style.setProperty('--vvh', h + 'px');
        root.style.setProperty('--kb', kb + 'px');
      }catch(e){}
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    global.addEventListener('resize', update);
  }catch(e){}
}
/* 移动端聚焦输入框后把它滚进可视区，避免被软键盘遮挡（只在小屏 / 触控设备生效） */
function setupKeyboardFocusGuard(){
  try{
    if(typeof global.matchMedia !== 'function') return;
    const mq = global.matchMedia('(max-width:640px), (pointer:coarse)');
    document.addEventListener('focusin', e=>{
      try{
        if(!mq.matches) return;
        const el = e.target;
        if(!el || !el.tagName) return;
        const tag = String(el.tagName).toLowerCase();
        if(tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;
        setTimeout(()=>{   // 等软键盘动画结束再滚，否则仍会被键盘盖住
          try{
            if(el && el.isConnected && typeof el.scrollIntoView === 'function'){
              el.scrollIntoView({block:'center', inline:'nearest'});
            }
          }catch(e){}
        }, 300);
      }catch(e){}
    }, true);
  }catch(e){}
}

global.ResumeUI = {
  setPaneCollapsed: setPaneCollapsed,
  toggleEditorPane: toggleEditorPane,
  syncSideRail: syncSideRail,
  setSidePanelOpen: setSidePanelOpen,
  toggleSidePanel: toggleSidePanel,
  setMobileView: setMobileView,
  currentMobileView: currentMobileView,
  visibleModal: visibleModal,
  closeVisibleModal: closeVisibleModal,
  handleMobileBack: handleMobileBack,
  setupNativeBack: setupNativeBack,
  setupMobileBackGesture: setupMobileBackGesture,
  setupVisualViewport: setupVisualViewport,
  setupKeyboardFocusGuard: setupKeyboardFocusGuard
};
})(typeof window !== "undefined" ? window : globalThis);
