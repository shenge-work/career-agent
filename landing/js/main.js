/**
 * CareerAgent 静态主页交互脚本
 *
 * 职责：
 *  1. 移动端导航菜单展开/收起
 *  2. 下载链接集中配置（替换下载地址只需改下面 CONFIG 一处）
 *  3. 下载埋点：优先依赖 Umami 的 data-umami-event 自动采集，
 *     同时提供 window.umami 手动兜底，便于后续漏斗分析
 *  4. 页脚年份自动更新
 *
 * 无任何第三方依赖，可离线运行。
 */
(function () {
  'use strict';

  /**
   * ============================================================
   * 下载配置（替换下载地址请改这里）
   * ------------------------------------------------------------
   * 已配置为 shenge-work/career-agent。
   * 正式发布后建议把地址指向具体的资源文件，例如：
   *   windows: 'https://github.com/shenge-work/career-agent/releases/latest/download/CareerAgent-Setup.exe'
   *   macos:   'https://github.com/shenge-work/career-agent/releases/latest/download/CareerAgent.dmg'
   * ============================================================
   */
  var CONFIG = {
    repo: {
      owner: 'shenge-work',
      name: 'career-agent'
    },
    download: {
      windows: 'https://github.com/shenge-work/career-agent/releases/latest',
      macos: 'https://github.com/shenge-work/career-agent/releases/latest'
    }
  };

  /**
   * 将 CONFIG 中的下载地址写回到页面上所有下载按钮，
   * 保证 HTML 里的占位 href 与 JS 配置保持一致（单一数据源）。
   */
  function applyDownloadLinks() {
    var buttons = document.querySelectorAll('[data-download-platform]');
    Array.prototype.forEach.call(buttons, function (btn) {
      var platform = btn.getAttribute('data-download-platform');
      if (platform && CONFIG.download[platform]) {
        btn.setAttribute('href', CONFIG.download[platform]);
      }
    });
  }

  /**
   * 下载埋点兜底。
   * 正常情况下 Umami 会自动读取按钮上的 data-umami-event 属性，
   * 这里仅在页面已加载 Umami 时再手动补一次 track，避免重复漏计。
   */
  function trackDownload(platform) {
    if (window.umami && typeof window.umami.track === 'function') {
      window.umami.track('download', { platform: platform });
    }
  }

  /**
   * 绑定下载按钮点击事件，读取 data-download-platform 做埋点。
   */
  function bindDownloadTracking() {
    var buttons = document.querySelectorAll('[data-download-platform]');
    Array.prototype.forEach.call(buttons, function (btn) {
      btn.addEventListener('click', function () {
        var platform = btn.getAttribute('data-download-platform');
        if (platform) {
          trackDownload(platform);
        }
      });
    });
  }

  /**
   * 移动端导航菜单开关。
   */
  function bindMobileNav() {
    var toggle = document.querySelector('.nav-toggle');
    var menu = document.querySelector('.nav-menu');
    if (!toggle || !menu) {
      return;
    }

    toggle.addEventListener('click', function () {
      var isOpen = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!isOpen));
      menu.classList.toggle('is-open', !isOpen);
    });

    // 点击菜单项后自动收起
    Array.prototype.forEach.call(menu.querySelectorAll('a'), function (link) {
      link.addEventListener('click', function () {
        toggle.setAttribute('aria-expanded', 'false');
        menu.classList.remove('is-open');
      });
    });
  }

  /**
   * 页脚年份自动更新。
   */
  function setFooterYear() {
    var yearEl = document.getElementById('footer-year');
    if (yearEl) {
      yearEl.textContent = String(new Date().getFullYear());
    }
  }

  /**
   * 初始化。
   */
  function init() {
    applyDownloadLinks();
    bindDownloadTracking();
    bindMobileNav();
    setFooterYear();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
