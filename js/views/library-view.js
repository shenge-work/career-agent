/* =============================================================
 * LibraryView —— 简历库首页（P1 卡片网格 + 标签筛选）
 * -------------------------------------------------------------
 * 功能：
 *   - 调 ResumeLibrary.list() 渲染卡片网格
 *   - 点卡片 → 跳 #/editor/<id>
 *   - 新建 / 导入 / 复制 / 删除 / 重命名 / 编辑标签
 *   - 顶部标签筛选条（点 chip 过滤）
 *   - 空态引导
 * ============================================================= */
(function (global) {
  'use strict';

  function relTime(ts) {
    var t = Number(ts) || 0;
    if (!t) return '—';
    var diff = Date.now() - t;
    var min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + ' 小时前';
    var day = Math.floor(hr / 24);
    if (day < 7) return day + ' 天前';
    var d = new Date(t);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function thumbChar(title) {
    var t = String(title || '未命名').trim();
    return t ? t.charAt(0) : '?';
  }

  function sourceBadge(meta) {
    if (meta && meta.source === 'feishu') return '<span class="lib-src feishu">☁ 飞书</span>';
    return '<span class="lib-src local">● 本地</span>';
  }

  function tagsOf(meta) {
    return (meta && Array.isArray(meta.tags)) ? meta.tags : [];
  }

  /* N3：锁定 / 分享状态（ResumeShare 缺席时一律视为未锁定、未分享，不影响老环境） */
  function shareApi() { try { return global.ResumeShare || null; } catch (e) { return null; } }
  function isLockedMeta(meta) { var S = shareApi(); return !!(S && S.isLocked(meta)); }
  function isPublicMeta(meta) { var S = shareApi(); return !!(S && S.isPublic(meta)); }
  function metaBadges(meta) {
    var out = '';
    if (isLockedMeta(meta)) out += '<em class="lib-badge is-lock" aria-label="已锁定">🔒</em>';
    if (isPublicMeta(meta)) out += '<em class="lib-badge is-public" aria-label="已开启分享">🌐 分享中</em>';
    return out;
  }

  function tagChips(tags) {
    if (!tags || !tags.length) return '';
    return '<div class="lib-card-tags">' + tags.map(function (t) {
      return '<span class="lib-tag">' + esc(t) + '</span>';
    }).join('') + '</div>';
  }

  var LibraryView = {
    root: null,
    listCache: [],
    menuEl: null,
    activeTag: null,
    thumbCache: {},   // N5：id|updatedAt -> 缩略图 HTML（内存缓存，内容变化即失效）

    onEnter: function () {
      if (!this.root) this.root = global.ResumeLayout.getViewRoot();
      document.body.classList.remove('route-editor');
      document.body.classList.add('route-library');
      this.activeTag = null;
      this.render();
    },

    onLeave: function () {
      this.closeMenu();
      if (this.root) this.root.innerHTML = '';
    },

    refresh: function () { this.render(); },

    /* 收集所有已用标签（去重、按使用频次排序） */
    allTags: function () {
      var freq = {};
      this.listCache.forEach(function (m) {
        tagsOf(m).forEach(function (t) { freq[t] = (freq[t] || 0) + 1; });
      });
      return Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; });
    },

    render: function () {
      var self = this;
      var root = this.root;

      root.innerHTML =
        '<div class="lib-page">' +
        '  <div class="lib-header">' +
        '    <h1 class="lib-title">简历库</h1>' +
        '    <div class="lib-actions">' +
        '      <button type="button" class="lib-btn" id="libBackupBtn" title="把库里全部简历（含标签 / 血缘 / 分享与锁定状态）导出成一个 JSON 备份">备份全部</button>' +
        '      <button type="button" class="lib-btn" id="libRestoreBtn" title="从整库 JSON 备份导入（新增，不覆盖现有简历）">恢复备份</button>' +
        '      <button type="button" class="lib-btn danger" id="libClearBtn" title="删除全部简历：两次确认，删除后 10 秒内可撤销">清空全部</button>' +
        '      <button type="button" class="lib-btn" id="libImportBtn">导入</button>' +
        '      <button type="button" class="lib-btn primary" id="libNewBtn">＋ 新建简历</button>' +
        '    </div>' +
        '  </div>' +
        '  <div class="lib-filter" id="libFilter" style="display:none;"></div>' +
        '  <div class="lib-grid" id="libGrid"><div class="lib-loading">加载中…</div></div>' +
        '  <input type="file" id="libImportFile" accept=".pdf,.json,application/pdf,application/json" style="display:none">' +
        '</div>';

      root.querySelector('#libNewBtn').addEventListener('click', function () {
        self.handleNew();
      });
      root.querySelector('#libImportBtn').addEventListener('click', function () {
        root.querySelector('#libImportFile').click();
      });
      root.querySelector('#libImportFile').addEventListener('change', function (e) {
        self.handleImport(e);
      });
      /* N3：整库备份 / 恢复 / 清空 —— 都转发给 app.js 的实现（那里有二次确认与撤销条） */
      root.querySelector('#libBackupBtn').addEventListener('click', function () {
        if (global.ResumeEditor && typeof global.ResumeEditor.exportLibraryBundle === 'function') global.ResumeEditor.exportLibraryBundle();
      });
      root.querySelector('#libRestoreBtn').addEventListener('click', function () {
        if (global.ResumeEditor && typeof global.ResumeEditor.pickLibraryBundle === 'function') global.ResumeEditor.pickLibraryBundle();
      });
      root.querySelector('#libClearBtn').addEventListener('click', function () {
        if (global.ResumeEditor && typeof global.ResumeEditor.removeAllResumes === 'function') {
          Promise.resolve(global.ResumeEditor.removeAllResumes()).then(function () { self.refresh(); });
        }
      });
      root.addEventListener('click', function (e) {
        if (!e.target.closest('.lib-card-menu') && !e.target.closest('.lib-menu')) {
          self.closeMenu();
        }
      });

      if (global.ResumeLibrary && typeof global.ResumeLibrary.list === 'function') {
        global.ResumeLibrary.list().then(function (idx) {
          self.listCache = idx || [];
          self.renderFilter();
          self.renderGrid();
        }).catch(function () {
          self.listCache = [];
          self.renderFilter();
          self.renderGrid();
        });
      } else {
        self.listCache = [];
        self.renderFilter();
        self.renderGrid();
      }
    },

    renderFilter: function () {
      var self = this;
      var bar = this.root.querySelector('#libFilter');
      if (!bar) return;
      var tags = this.allTags();
      if (!tags.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
      bar.style.display = '';
      var html = '<span class="lib-filter-label">筛选：</span>';
      html += '<button type="button" class="lib-filter-chip' + (!this.activeTag ? ' on' : '') + '" data-tag="">全部</button>';
      tags.forEach(function (t) {
        var n = self.listCache.filter(function (m) { return tagsOf(m).indexOf(t) >= 0; }).length;
        html += '<button type="button" class="lib-filter-chip' + (self.activeTag === t ? ' on' : '') + '" data-tag="' + esc(t) + '">' + esc(t) + ' <span class="lib-filter-n">' + n + '</span></button>';
      });
      bar.innerHTML = html;
      bar.querySelectorAll('.lib-filter-chip').forEach(function (chip) {
        chip.addEventListener('click', function () {
          var t = chip.getAttribute('data-tag');
          self.activeTag = t || null;
          self.renderFilter();
          self.renderGrid();
        });
      });
    },

    renderGrid: function () {
      var self = this;
      var grid = this.root.querySelector('#libGrid');
      if (!grid) return;

      var items = this.listCache;
      if (this.activeTag) {
        items = items.filter(function (m) { return tagsOf(m).indexOf(self.activeTag) >= 0; });
      }

      if (!this.listCache.length) {
        grid.innerHTML =
          '<div class="lib-empty">' +
          '  <div class="lib-empty-icon">📄</div>' +
          '  <div class="lib-empty-title">还没有简历</div>' +
          '  <div class="lib-empty-sub">从一份空白简历开始，或导入已有的 PDF / JSON</div>' +
          '</div>';
        return;
      }
      if (!items.length) {
        grid.innerHTML =
          '<div class="lib-empty">' +
          '  <div class="lib-empty-icon">🏷</div>' +
          '  <div class="lib-empty-title">没有标签为「' + esc(this.activeTag) + '」的简历</div>' +
          '  <div class="lib-empty-sub">点上方「全部」查看所有简历</div>' +
          '</div>';
        return;
      }

      var html = items.map(function (meta) {
        var derived = meta.kind === 'derived';
        var locked = isLockedMeta(meta);
        var master = !!meta.isMaster;
        var title = String(meta.title == null ? '' : meta.title);
        return '' +
          '<div class="lib-card' + (derived ? ' is-derived' : '') + (locked ? ' is-locked' : '') + (master ? ' is-master' : '') + '"' +
              ' data-id="' + esc(meta.id) + '" data-full-title="' + esc(title) + '">' +
          /* ⚠️ 主角标必须是 .lib-card 的直接子元素，不能放进 .lib-card-thumb ——
             renderThumbs() 会用简历预览 HTML 整体覆盖 thumb 的 innerHTML，放里面会被抹掉 */
          (master ? '<span class="lib-master-badge" title="主简历 · 源头简历">主</span>' : '') +
          '  <div class="lib-card-thumb resume-thumb" data-thumb-id="' + esc(meta.id) + '"></div>' +
          '  <div class="lib-card-body">' +
          /* 名称最多两行（CSS line-clamp）；仍放不下时由 markClippedTitles() 加 is-clipped，
             hover 触发 CSS 气泡显示 data-full-title 里的完整名称 */
          '    <div class="lib-card-title">' + esc(title) + '</div>' +
          /* 徽标统一放 meta 行：标题区要完整留给名称本身（派生名普遍很长）；
              「定制」角标由 CSS 画在缩略图上，不占正文宽度 */
          '    <div class="lib-card-meta">更新 ' + relTime(meta.updatedAt) + ' · ' + sourceBadge(meta) + metaBadges(meta) + '</div>' +
          tagChips(tagsOf(meta)) +
          '  </div>' +
          '  <button type="button" class="lib-card-menu" aria-label="菜单">⋯</button>' +
          '</div>';
      }).join('');
      grid.innerHTML = html;
      this.renderThumbs(grid);
      this.markClippedTitles(grid);
      /* 布局 / 字体度量稳定后复核一次：确实放不下的卡片才挂悬浮气泡，放得下的保持干净 */
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () {
          if (grid.isConnected) self.markClippedTitles(grid);
        });
      }

      grid.querySelectorAll('.lib-card').forEach(function (card) {
        card.addEventListener('click', function (e) {
          if (e.target.closest('.lib-card-menu')) return;
          var id = card.getAttribute('data-id');
          global.ResumeRouter.navigate('/editor/' + id);
        });
      });
      grid.querySelectorAll('.lib-card-menu').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var card = btn.closest('.lib-card');
          var id = card.getAttribute('data-id');
          self.openMenu(btn, id);
        });
      });
    },

    /* 名称两行仍被截断的卡片 → 加 is-clipped，hover 时用 CSS 气泡显示完整名称。
       判定方式是实测：line-clamp 生效时内容高度会超出可见高度。 */
    markClippedTitles: function (grid) {
      if (!grid) return;
      var cards = grid.querySelectorAll('.lib-card');
      Array.prototype.forEach.call(cards, function (card) {
        var el = card.querySelector('.lib-card-title');
        if (!el) return;
        var clipped = (el.scrollHeight > el.clientHeight + 1) || (el.scrollWidth > el.clientWidth + 1);
        if (clipped) card.classList.add('is-clipped');
        else card.classList.remove('is-clipped');
      });
    },

    renderThumbs: function (grid) {
      var self = this;
      if (!grid) return;
      var nodes = grid.querySelectorAll('.lib-card-thumb[data-thumb-id]');
      Array.prototype.forEach.call(nodes, function (el) {
        var id = el.getAttribute('data-thumb-id');
        var meta = self.listCache.filter(function (m) { return m.id === id; })[0];
        if (!meta) return;
        var key = id + '|' + (meta.updatedAt || 0);
        /* 命中缓存（内容未变）→ 直接回填，零异步 */
        if (self.thumbCache[key]) { el.innerHTML = self.thumbCache[key]; el.classList.remove('is-empty'); return; }
        el.classList.add('is-empty');
        if (!global.ResumeRender || typeof global.ResumeRender.buildResumeHtml !== 'function') return;
        if (!global.ResumeLibrary || typeof global.ResumeLibrary.load !== 'function') return;
        global.ResumeLibrary.load(id).then(function (payload) {
          /* 元素可能已被重渲染（re-render / 筛选切换 / 离开页面）→ 仅当它仍连在本文档才回填 */
          if (!el.isConnected) return;
          var html = global.ResumeRender.buildResumeHtml(payload);
          if (!html) { el.classList.add('is-empty'); return; }
          self.thumbCache[key] = html;
          el.classList.remove('is-empty');
          el.innerHTML = html;
        }).catch(function () { el.classList.add('is-empty'); });
      });
    },

    openMenu: function (anchor, id) {
      var self = this;
      this.closeMenu();

      var meta = this.listCache.filter(function (m) { return m.id === id; })[0] || {};
      var S = shareApi();
      var locked = isLockedMeta(meta);
      var pub = isPublicMeta(meta);
      var hasToken = !!(S && S.tokenOf(meta));

      var menu = document.createElement('div');
      menu.className = 'lib-menu';
      menu.innerHTML =
        '<button type="button" data-act="rename">重命名</button>' +
        '<button type="button" data-act="tags">🏷 编辑标签</button>' +
        '<button type="button" data-act="master">' + (meta.isMaster ? '取消主简历' : '设为主简历') + '</button>' +
        '<button type="button" data-act="lock">' + (locked ? '解锁编辑' : '🔒 锁定防误改') + '</button>' +
        '<button type="button" data-act="public">' + (pub ? '关闭分享' : '开启分享') + '</button>' +
        (pub && hasToken ? '<button type="button" data-act="token">复制分享标识</button>' : '') +
        '<button type="button" data-act="duplicate">复制一份</button>' +
        '<button type="button" data-act="remove" class="danger">删除</button>';
      menu.style.position = 'absolute';
      var rect = anchor.getBoundingClientRect();
      menu.style.top = (rect.bottom + window.scrollY + 4) + 'px';
      menu.style.left = (rect.right + window.scrollX - 120) + 'px';

      menu.addEventListener('click', function (e) {
        var actBtn = e.target.closest('[data-act]');
        if (!actBtn) return;
        var act = actBtn.getAttribute('data-act');
        self.closeMenu();
        if (act === 'rename') self.handleRename(id);
        else if (act === 'tags') self.handleSetTags(id);
        else if (act === 'master') self.handleSetMaster(id);
        else if (act === 'lock') self.handleToggleLock(id);
        else if (act === 'public') self.handleTogglePublic(id);
        else if (act === 'token') self.handleCopyToken(id);
        else if (act === 'duplicate') self.handleDuplicate(id);
        else if (act === 'remove') self.handleRemove(id);
      });

      document.body.appendChild(menu);
      this.menuEl = menu;
    },

    closeMenu: { /* placeholder */ },

    handleNew: function () {
      var self = this;
      if (!global.ResumeEditor || typeof global.ResumeEditor.resumeNew !== 'function') return;
      Promise.resolve(global.ResumeEditor.resumeNew()).then(function (meta) {
        if (meta && meta.id) {
          global.ResumeRouter.navigate('/editor/' + meta.id);
        }
      });
    },

    handleImport: function (e) {
      var self = this;
      var input = e.target;
      if (!input.files || !input.files[0]) return;
      if (global.ResumeEditor && typeof global.ResumeEditor.importResumeFile === 'function') {
        Promise.resolve(global.ResumeEditor.importResumeFile(input)).then(function () {
          setTimeout(function () { self.refresh(); }, 1200);
        });
      }
    },

    handleRename: function (id) {
      var self = this;
      var meta = this.listCache.filter(function (m) { return m.id === id; })[0];
      var oldTitle = meta ? meta.title : '';
      var title = prompt('新名称：', oldTitle);
      if (title === null) return;
      title = title.trim();
      if (!title) return;
      if (global.ResumeEditor && typeof global.ResumeEditor.resumeRename === 'function') {
        Promise.resolve(global.ResumeEditor.resumeRename(id, title)).then(function () {
          self.refresh();
        });
      }
    },

    handleSetTags: function (id) {
      var self = this;
      if (global.ResumeEditor && typeof global.ResumeEditor.resumeSetTags === 'function') {
        Promise.resolve(global.ResumeEditor.resumeSetTags(id)).then(function () {
          self.refresh();
        });
      }
    },

    /* 主简历：设 / 取消（互斥，库里唯一）。改完重渲染卡片网格（角标 + 排序即时更新） */
    handleSetMaster: function (id) {
      var self = this;
      if (global.ResumeLibrary && typeof global.ResumeLibrary.setMaster === 'function') {
        Promise.resolve(global.ResumeLibrary.setMaster(id)).then(function () {
          self.refresh();
        });
      }
    },

    handleDuplicate: function (id) {
      var self = this;
      if (global.ResumeEditor && typeof global.ResumeEditor.resumeDuplicate === 'function') {
        Promise.resolve(global.ResumeEditor.resumeDuplicate(id)).then(function (meta) {
          self.refresh();
        });
      }
    },

    /* N3-F1 锁定 / 解锁 */
    handleToggleLock: function (id) {
      var self = this;
      if (global.ResumeEditor && typeof global.ResumeEditor.resumeToggleLock === 'function') {
        Promise.resolve(global.ResumeEditor.resumeToggleLock(id)).then(function () { self.refresh(); });
      }
    },

    /* N3-F2 开启 / 关闭分享 */
    handleTogglePublic: function (id) {
      var self = this;
      if (global.ResumeEditor && typeof global.ResumeEditor.resumeTogglePublic === 'function') {
        Promise.resolve(global.ResumeEditor.resumeTogglePublic(id)).then(function () { self.refresh(); });
      }
    },

    /* N3-F3 复制分享标识 */
    handleCopyToken: function (id) {
      var self = this;
      if (global.ResumeEditor && typeof global.ResumeEditor.copyShareToken === 'function') {
        Promise.resolve(global.ResumeEditor.copyShareToken(id)).then(function () { self.refresh(); });
      }
    },

    handleRemove: function (id) {
      var self = this;
      if (global.ResumeEditor && typeof global.ResumeEditor.resumeRemove === 'function') {
        Promise.resolve(global.ResumeEditor.resumeRemove(id)).then(function () {
          self.refresh();
        });
      }
    }
  };

  LibraryView.closeMenu = function () {
    if (this.menuEl && this.menuEl.parentNode) {
      this.menuEl.parentNode.removeChild(this.menuEl);
    }
    this.menuEl = null;
  };

  global.LibraryView = LibraryView;
})(window);
