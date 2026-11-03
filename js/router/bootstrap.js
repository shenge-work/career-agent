/* =============================================================
 * 路由启动（P0）—— 必须在 app.js 之后加载
 * -------------------------------------------------------------
 * 注册路由表并启动。初始 hash 为空时不做任何事（.app 已经由 app.js 渲染好，
 * 保持现状，老用户零感知）；用户主动访问 #/library 或点 rail 时才介入。
 * ============================================================= */
(function (global) {
  'use strict';

  function start() {
    if (!global.ResumeRouter) {
      console.warn('[bootstrap] ResumeRouter 未就绪，跳过路由启动');
      return;
    }
    global.ResumeRouter.register('/library', global.LibraryView);
    global.ResumeRouter.register('/editor', global.EditorView);
    global.ResumeRouter.register('/editor/:resumeId', global.EditorView);
    global.ResumeRouter.register('/settings', global.SettingsView);
    global.ResumeRouter.register('/history', global.HistoryView);
    global.ResumeRouter.register('/tracker', global.TrackerView);
    global.ResumeRouter.register('/tracker/:id', global.TrackerView);
    global.ResumeRouter.register('/templates', global.TemplatesView);
    global.ResumeRouter.register('/portfolio', global.PortfolioView);
    global.ResumeRouter.register('/portfolio/:id', global.PortfolioView);
    global.ResumeRouter.register('/companies', global.CompanyView);
    global.ResumeRouter.register('/companies/:id', global.CompanyView);

    /* BUG-05 修复：为根路径注册显式默认路由，消除「no route matched: /」警告。
       重定向到工作台默认视图 /editor（与 app.js 初始渲染保持一致，零观感变化）。 */
    global.ResumeRouter.register('/', {
      onEnter: function () {
        try { global.ResumeRouter.navigate('/editor'); } catch (e) {}
      }
    });

    try { global.ResumeRouter.start(); }
    catch (e) { console.warn('[bootstrap] router.start failed', e); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(window);
