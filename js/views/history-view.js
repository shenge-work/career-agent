/* =============================================================
 * HistoryView —— 历史版本页（本地 + 飞书双来源，N11）
 * -------------------------------------------------------------
 * 从 #feishuRestoreModal 迁出。原先只列飞书云端版本；
 * N11 升级为「先列本地版本（local），再列飞书云端版本（feishu）」，
 * 未连飞书时本地版本依然可用（file:// 直开也有历史）。
 *
 * 交互（对齐飞书范式）：
 *   - 列表按时间倒序，每条显示「时间 + 来源标签（自动/手动/导入/恢复）+ 可选名称」；
 *   - 点选某版本 → 右侧预览该版本渲染（只读，不污染当前编辑态）；
 *   - 「恢复此版本」→ 二次确认 → 恢复（app.js 内部先存当前为新版本再应用）；
 *   - 「保存为命名快照」→ 手动打版本点。
 * ============================================================= */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* 兼容两种时间格式：本地版本 timestamp 是毫秒，飞书 create_time 是秒 */
  function fmtTime(ms) {
    if (!ms) return '';
    try {
      // 本地版本 timestamp ≥ 1e12 视为毫秒；飞书 create_time 是秒级（1e9~1e10）
      var t = Number(ms);
      if (t > 1e12) t = t; else t = t * 1000;
      return new Date(t).toLocaleString();
    } catch (e) { return ''; }
  }

  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function sourceBadge(v) {
    // 本地版本：label（编辑/导入/重置/恢复/手动快照） + source（auto/manual）
    if (v.label != null) {
      var src = v.source === 'manual' ? '手动' : '自动';
      return '<span class="hist-badge hist-badge-' + (v.source === 'manual' ? 'manual' : 'auto') + '">' + esc(src) + ' · ' + esc(v.label) + '</span>';
    }
    // 飞书版本：无 label，标「云端」
    return '<span class="hist-badge hist-badge-feishu">云端</span>';
  }

  var HistoryView = {
    root: null,

    onEnter: function () {
      if (!this.root) this.root = global.ResumeLayout.getViewRoot();
      document.body.classList.remove('route-editor');
      document.body.classList.add('route-library');
      this.render();
      this.load();
    },

    onLeave: function () {
      if (this.root) this.root.innerHTML = '';
    },

    render: function () {
      this.root.innerHTML =
        '<div class="history-page">' +
        '  <div class="settings-header">' +
        '    <button type="button" class="settings-back" data-nav="/settings">← 返回</button>' +
        '    <h1 class="settings-title">历史版本</h1>' +
        '    <button type="button" class="lib-btn primary" id="histSnapshotBtn">保存为命名快照</button>' +
        '  </div>' +
        '  <div class="history-layout">' +
        '    <div class="history-list" id="historyList"><div class="lib-loading"><span class="spinner"></span>正在加载版本历史…</div></div>' +
        '    <div class="history-preview" id="historyPreview">' +
        '      <div class="lib-empty"><div class="lib-empty-title">选择一个版本</div>' +
        '      <div class="lib-empty-sub">点击左侧任一版本，在这里预览该版本的简历效果（只读）</div></div>' +
        '    </div>' +
        '  </div>' +
        '</div>';
      this.root.querySelector('.settings-back').addEventListener('click', function (e) {
        e.preventDefault();
        global.ResumeRouter.navigate('/settings');
      });
      var snapBtn = this.root.querySelector('#histSnapshotBtn');
      if (snapBtn) snapBtn.addEventListener('click', this.onSnapshot.bind(this));
    },

    /* 当前简历 id（与飞书同步分键一致，多份简历互不串数据） */
    currentResumeId: function () {
      return (global.ResumeEditor && global.ResumeEditor.getActiveResumeId) ? (global.ResumeEditor.getActiveResumeId() || 'default') : 'default';
    },

    onSnapshot: function () {
      var name = (global.prompt && prompt('给这个版本起个名字（可选）：')) || '';
      var fn = global.ResumeEditor && global.ResumeEditor.saveManualSnapshot;
      if (typeof fn !== 'function') { alert('当前环境不支持手动快照'); return; }
      Promise.resolve(fn(name)).then(function (ok) {
        if (ok) { alert('✓ 已保存为命名快照'); this.load(); }
      }.bind(this));
    },

    load: function () {
      var self = this;
      var list = this.root.querySelector('#historyList');
      var resumeId = this.currentResumeId();
      var localVersions = [];
      var feishuVersions = [];

      var hasLocal = global.ResumeEditor && typeof global.ResumeEditor.listLocalVersions === 'function';
      var hasFeishu = global.ResumeStore && typeof global.ResumeStore.listVersions === 'function';

      var localP = hasLocal
        ? global.ResumeEditor.listLocalVersions().then(function (vs) { localVersions = vs || []; }).catch(function () { localVersions = []; })
        : Promise.resolve();
      var feishuP = hasFeishu
        ? global.ResumeStore.listVersions(resumeId).then(function (vs) { feishuVersions = vs || []; }).catch(function () { feishuVersions = []; })
        : Promise.resolve();

      Promise.all([localP, feishuP]).then(function () {
        if (!localVersions.length && !feishuVersions.length) {
          list.innerHTML = '<div class="lib-empty"><div class="lib-empty-title">还没有版本</div>' +
            '<div class="lib-empty-sub">开始编辑后，每次输入停顿都会自动留下一个版本；也可以点右上角「保存为命名快照」手动标记重要节点</div></div>';
          return;
        }
        var html = '';
        if (localVersions.length) {
          html += '<div class="history-group">本地版本</div>';
          html += localVersions.map(function (v, i) { return self.itemHtml('local', v, i); }).join('');
        }
        if (feishuVersions.length) {
          html += '<div class="history-group">飞书云端版本</div>';
          html += feishuVersions.map(function (v, i) { return self.itemHtml('feishu', v, i); }).join('');
        }
        list.innerHTML = html;

        // 点选预览（只读）：本地版本取 snapshot 反序列化，飞书版本取 version_id 交给恢复预览
        list.querySelectorAll('[data-preview]').forEach(function (el) {
          el.addEventListener('click', function () { self.preview(el); });
        });
        list.querySelectorAll('[data-restore]').forEach(function (btn) {
          btn.addEventListener('click', function () { self.restore(btn); });
        });
      }).catch(function (e) {
        list.innerHTML = '<div class="lib-empty"><div class="lib-empty-title">拉取失败</div>' +
          '<div class="lib-empty-sub">' + esc(e && e.message ? e.message : String(e)) + '</div></div>';
      });
    },

    /* 本地版本用 v.label/v.source/v.name；飞书版本用 v.version_id/create_time/size */
    itemHtml: function (source, v, i) {
      if (source === 'local') {
        var name = v.name ? '<span class="history-item-name">' + esc(v.name) + '</span>' : '';
        return '<div class="history-item" data-preview="' + esc(v.versionId) + '" data-source="local">' +
          '  <div class="history-item-info">' +
          '    <div class="history-item-title">' + name + esc(v.label || '版本 ' + (i + 1)) + '</div>' +
          '    <div class="history-item-meta">' + esc(fmtTime(v.timestamp)) + '</div>' +
          '  </div>' +
          '  ' + sourceBadge(v) +
          '  <button type="button" class="lib-btn" data-restore="' + esc(v.versionId) + '">恢复</button>' +
          '</div>';
      }
      return '<div class="history-item" data-preview="' + esc(v.version_id || '') + '" data-source="feishu">' +
        '  <div class="history-item-info">' +
        '    <div class="history-item-title">版本 ' + esc(v.version_id || ('#' + (i + 1))) + '</div>' +
        '    <div class="history-item-meta">' + esc(fmtTime(v.create_time)) + ' · ' + esc(fmtSize(v.size)) + '</div>' +
        '  </div>' +
        '  ' + sourceBadge(v) +
        '  <button type="button" class="lib-btn" data-restore="' + esc(v.version_id || '') + '">恢复</button>' +
        '</div>';
    },

    /* 预览（只读）：本地版本从 snapshot 还原出 {data,fonts,spacing} 渲染；飞书版本提示需恢复才能看 */
    preview: function (el) {
      var source = el.getAttribute('data-source');
      var vid = el.getAttribute('data-preview');
      var box = this.root.querySelector('#historyPreview');
      var self = this;

      // 高亮选中项
      this.root.querySelectorAll('.history-item.is-active').forEach(function (x) { x.classList.remove('is-active'); });
      el.classList.add('is-active');

      if (source === 'local') {
        var fn = global.ResumeEditor && global.ResumeEditor.listLocalVersions;
        if (typeof fn !== 'function') return;
        // 本地版本列表里已含 snapshot，直接反序列化预览（不触碰当前编辑态）
        fn().then(function (vs) {
          var v = vs.filter(function (x) { return x.versionId === vid; })[0];
          if (!v || v.snapshot == null) { box.innerHTML = '<div class="lib-empty"><div class="lib-empty-sub">该版本无内容</div></div>'; return; }
          try {
            var payload = JSON.parse(v.snapshot);
            self.renderPreviewPayload(box, payload);
          } catch (e) {
            box.innerHTML = '<div class="lib-empty"><div class="lib-empty-sub">版本内容损坏，无法预览</div></div>';
          }
        });
      } else {
        box.innerHTML = '<div class="lib-empty"><div class="lib-empty-sub">飞书云端版本需点「恢复」下载后才能预览（恢复前会自动保存当前内容为新版本）</div></div>';
      }
    },

    /* 只读预览：用 ResumeRender.buildResumeHtml（N5 缩略图同款，纯字符串构建、无副作用）
       渲染一份只读简历，不写入当前编辑态。 */
    renderPreviewPayload: function (box, payload) {
      var build = global.ResumeRender && global.ResumeRender.buildResumeHtml;
      if (typeof build !== 'function') {
        box.innerHTML = '<div class="lib-empty"><div class="lib-empty-sub">预览不可用</div></div>';
        return;
      }
      try {
        var html = build(payload);
        if (!html) {
          box.innerHTML = '<div class="lib-empty"><div class="lib-empty-sub">该版本是空简历</div></div>';
          return;
        }
        box.innerHTML = '<div class="history-preview-paper">' + html + '</div>';
      } catch (e) {
        box.innerHTML = '<div class="lib-empty"><div class="lib-empty-sub">渲染失败：' + esc(e && e.message ? e.message : e) + '</div></div>';
      }
    },

    restore: function (btn) {
      var source = btn.parentElement.getAttribute('data-source');
      var vid = btn.getAttribute('data-restore');
      if (!confirm('恢复该版本将覆盖当前编辑器内容。\n\n恢复前会自动把当前内容保存为一个新版本，之后仍可撤销 / 再次恢复。确定继续？')) return;

      if (source === 'local') {
        var fn = global.ResumeEditor && global.ResumeEditor.restoreLocalVersion;
        if (typeof fn !== 'function') { alert('当前环境不支持本地版本恢复'); return; }
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>恢复中…';
        Promise.resolve(fn(vid)).then(function (ok) {
          if (!ok) { btn.disabled = false; btn.textContent = '恢复'; alert('恢复失败：版本不存在或已归档'); return; }
          var id = (global.ResumeEditor.getActiveResumeId && global.ResumeEditor.getActiveResumeId()) || '';
          global.ResumeRouter.navigate('/editor/' + id);
        });
      } else {
        // 飞书版本：沿用原 restoreFromFeishu 路径
        if (btn.disabled) return;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>恢复中…';
        Promise.resolve(global.ResumeEditor && global.ResumeEditor.restoreFromFeishu
          ? global.ResumeEditor.restoreFromFeishu(vid) : null).then(function () {
          var id = (global.ResumeEditor.getActiveResumeId && global.ResumeEditor.getActiveResumeId()) || '';
          global.ResumeRouter.navigate('/editor/' + id);
        });
      }
    }
  };

  global.HistoryView = HistoryView;
})(window);
