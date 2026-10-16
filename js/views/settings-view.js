/* =============================================================
 * SettingsView —— 设置页（P2）
 * -------------------------------------------------------------
 * 从现有 modal 迁出的分组页面：飞书同步 / 外观 / 数据 / 关于。
 * 飞书配置表单已内联（替代原 #feishuConfigModal）。
 * ============================================================= */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* 飞书配置内联表单（原 #feishuConfigModal 的内容，id 全部保留，app.js 直接 getElementById）
     已合并：方式一（扫码授权）+ 方式二（扫码注册个人应用）→ 单个「连接飞书」入口，
     缺少应用凭证时自动先注册再授权，一气呵成；原「同步目标设置」收进高级设置折叠项。 */
  var FEISHU_FORM_HTML =
    '<div class="fs-form">' +

    /* 飞书连接（合并原「方式一 扫码授权」+「方式二 扫码注册个人应用」） */
    '  <div class="fs-card">' +
    '    <div class="fs-card-title">飞书连接</div>' +
    '    <div id="oauthStatus" class="fs-status">尚未连接飞书。点击「连接飞书」，扫码完成应用注册与授权（一气呵成，无需填写任何配置）。</div>' +
    '    <div id="regQrWrap" class="fs-qr-wrap" style="display:none;">' +
    '      <div id="regQr" class="fs-qr"></div>' +
    '      <div class="fs-qr-hint">第 1 步：用手机飞书扫描上方二维码，确认创建个人应用</div>' +
    '      <div id="regStatus" class="fs-status">等待扫码…</div>' +
    '    </div>' +
    '    <div id="regResult" class="fs-status" style="display:none;"></div>' +
    '    <div class="fs-btn-row">' +
    '      <button type="button" class="lib-btn primary" id="oauthStartBtn" onclick="ResumeEditor.startFeishuOauth()">连接飞书</button>' +
    '      <button type="button" class="lib-btn" id="revokeOauthBtn" style="display:none;" onclick="ResumeEditor.revokeFeishuOauth()">断开连接</button>' +
    '      <button type="button" class="lib-btn" id="regCancelBtn" style="display:none;" onclick="ResumeEditor.cancelFeishuRegister()">取消</button>' +
    '    </div>' +
    '  </div>' +

    /* 高级设置（复用已有应用时展开；扫码注册后这些项已自动配置） */
    '  <details class="fs-card fs-advanced">' +
    '    <summary>高级设置（复用已有应用时展开）</summary>' +
    '    <div class="fs-advanced-body">' +
    '      <div class="fs-card-desc">扫码注册后这些项已自动保存并绑定，通常无需改动；仅当要复用已有飞书应用时才需要手动填写。</div>' +
    '      <label class="fs-field"><span>App ID（形如 cli_xxx）</span><input id="cfgAppId" placeholder="cli_xxxxxxxxxxxx"></label>' +
    '      <label class="fs-field"><span>App Secret（已设置时留空表示不修改）</span><input id="cfgAppSecret" type="password" placeholder="首次配置必填"></label>' +
    '      <label class="fs-field"><span>飞书域名（如 xxx.feishu.cn）</span><input id="cfgDomain" placeholder="feishu.cn"></label>' +
    '      <label class="fs-field"><span>云盘目标文件夹 folder_token（存到根目录填 0）</span><input id="cfgFolder" placeholder="0"></label>' +
    '      <label class="fs-field"><span>备份文档标题</span><input id="cfgDocTitle" placeholder="简历数据备份"></label>' +
    '      <label class="fs-field"><span>云盘文件名</span><input id="cfgFileName" placeholder="resume.json"></label>' +
    '      <label class="fs-check"><input type="checkbox" id="cfgDryRun"> <span>dry-run 模式（走完整链路但不真实写入飞书，用于先验证流程）</span></label>' +
    '      <div id="cfgProbeStatus" class="fs-status" style="display:none;"></div>' +
    '      <div class="fs-btn-row">' +
    '        <button type="button" class="lib-btn" id="cfgProbeBtn" onclick="ResumeEditor.probeFeishuConfig()">自动探测并绑定</button>' +
    '        <button type="button" class="lib-btn primary" id="cfgSaveBtn" onclick="ResumeEditor.saveFeishuConfig()">保存配置</button>' +
    '      </div>' +
    '      <div class="fs-note">所需权限 scope：<b>docx:document</b>、<b>drive:drive</b>（或 drive:file），并完成租户授权。配置保存在本机 gitignored 的 sync.config.json，凭证不会进入浏览器存储或简历数据文件。</div>' +
    '    </div>' +
    '  </details>' +
    '</div>';

  /* —— 数据体检 ——
   * 以服务端上报的磁盘事实为准（/api/library/info）；拿不到时（file:// / 桌面壳 / 未启服务）
   * 回退到 ResumeLibrary 的运行时信息并明确标注「未知」，绝不编造路径。
   * 之所以需要它：「简历库从未真正落盘」在修复前没有任何界面痕迹 ——
   * 用户打开简历库看到「还没有简历」，只会以为是自己做错了什么。 */
  var BACKEND_TEXT = {
    'http+ls': '本地文件（经本地写服务写回磁盘）',
    'localstorage': '⚠ 浏览器本地存储（未连接本地写服务，改动未写入磁盘）',
    'native': '应用数据目录（桌面 / 安卓 App 内）',
    'memory': '仅内存（刷新即丢）'
  };

  function fmtTime(ms) {
    if (!ms) return '—';
    var d = new Date(Number(ms));
    if (isNaN(d.getTime())) return '—';
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function renderStorageCheck(root) {
    var body = root.querySelector('#storageCheckBody');
    if (!body) return;
    var L = global.ResumeLibrary;
    var kind = (L && typeof L.backendKind === 'function') ? L.backendKind() : 'unknown';
    var lines = ['存储位置：' + (BACKEND_TEXT[kind] || kind)];
    if (L && typeof L.isDegraded === 'function' && L.isDegraded()) {
      lines.push('⚠ 当前处于降级态：改动只存在本浏览器，尚未写入磁盘');
    }
    if (typeof fetch !== 'function') {
      lines.push('存储目录：未知（当前环境没有本地写服务）');
      body.textContent = lines.join('\n');
      return;
    }
    body.textContent = lines.join('\n');   // 先给出运行时已知事实，磁盘事实回来后再补

    fetch('/api/library/info', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (info) {
        if (!info || !info.ok) {
          lines.push('存储目录：未知（未连接本地写服务）');
        } else {
          lines.push('存储目录：' + info.base);
          lines.push('简历份数：' + info.docCount);
          lines.push('最近写盘：' + fmtTime(info.lastWriteAt));
          if (info.legacyExists) lines.push('另有一份旧单份数据 resume.json（首次启动已迁移进简历库）');
        }
        body.textContent = lines.join('\n');
      });
  }

  var SettingsView = {
    root: null,

    onEnter: function () {
      if (!this.root) this.root = global.ResumeLayout.getViewRoot();
      document.body.classList.remove('route-editor');
      document.body.classList.add('route-library');
      this.render();
      // 渲染完后填飞书配置字段（openFeishuConfig 现在只填字段，不弹 modal）
      if (global.ResumeEditor && global.ResumeEditor.openFeishuConfig) {
        global.ResumeEditor.openFeishuConfig();
      }
    },

    onLeave: function () {
      if (this.root) this.root.innerHTML = '';
    },

    render: function () {
      var self = this;
      var root = this.root;

      var themeMode = (global.ResumeTheme && global.ResumeTheme.getMode)
        ? global.ResumeTheme.getMode() : 'auto';
      var paperDark = (global.ResumeTheme && global.ResumeTheme.paperFollows)
        ? global.ResumeTheme.paperFollows() : true;

      root.innerHTML =
        '<div class="settings-page">' +
        '  <div class="settings-header">' +
        '    <button type="button" class="settings-back" data-nav="/library">← 返回</button>' +
        '    <h1 class="settings-title">设置</h1>' +
        '  </div>' +

        '  <div class="settings-body">' +

        /* 飞书同步 */
        '  <section class="settings-section">' +
        '    <h2 class="settings-h2">飞书同步</h2>' +
        '    <div class="settings-row">' +
        '      <div class="settings-row-text">' +
        '        <div class="settings-row-title">立即上报</div>' +
        '        <div class="settings-row-desc">把当前简历数据推到飞书</div>' +
        '      </div>' +
        '      <button type="button" class="lib-btn" id="setReportBtn">上报到飞书</button>' +
        '    </div>' +
        '    <div class="settings-row">' +
        '      <div class="settings-row-text">' +
        '        <div class="settings-row-title">拉取最新</div>' +
        '        <div class="settings-row-desc">从飞书云端拉取当前简历的最新版本（覆盖本地，可撤销）</div>' +
        '      </div>' +
        '      <button type="button" class="lib-btn" id="setPullBtn">拉取最新</button>' +
        '    </div>' +
        '    <div class="settings-row">' +
        '      <div class="settings-row-text">' +
        '        <div class="settings-row-title">历史版本</div>' +
        '        <div class="settings-row-desc">查看本地版本历史与飞书云端版本，随时回溯恢复</div>' +
        '      </div>' +
        '      <button type="button" class="lib-btn" id="setHistoryBtn">查看历史版本</button>' +
        '    </div>' +
        FEISHU_FORM_HTML +
        '  </section>' +

        /* 外观 */
        '  <section class="settings-section">' +
        '    <h2 class="settings-h2">外观</h2>' +
        '    <div class="settings-row">' +
        '      <div class="settings-row-text">' +
        '        <div class="settings-row-title">界面主题</div>' +
        '        <div class="settings-row-desc">编辑器外壳的明暗</div>' +
        '      </div>' +
        '      <div class="settings-seg">' +
        '        <button type="button" data-theme="auto"' + (themeMode === 'auto' ? ' class="on"' : '') + '>跟随系统</button>' +
        '        <button type="button" data-theme="light"' + (themeMode === 'light' ? ' class="on"' : '') + '>日间</button>' +
        '        <button type="button" data-theme="dark"' + (themeMode === 'dark' ? ' class="on"' : '') + '>夜间</button>' +
        '      </div>' +
        '    </div>' +
        '    <div class="settings-row">' +
        '      <div class="settings-row-text">' +
        '        <div class="settings-row-title">纸张跟随夜间</div>' +
        '        <div class="settings-row-desc">夜间模式下预览里的简历纸张也变暗（导出仍是白纸）</div>' +
        '      </div>' +
        '      <label class="settings-switch">' +
        '        <input type="checkbox" id="setPaperDark"' + (paperDark ? ' checked' : '') + '>' +
        '        <span class="settings-switch-ui"></span>' +
        '      </label>' +
        '    </div>' +
        '  </section>' +

        /* 数据 */
        '  <section class="settings-section">' +
        '    <h2 class="settings-h2">数据</h2>' +
        /* 数据体检：回答「我的简历存在哪、有几份、最后一次写盘是什么时候」——
           这几个问题此前在界面上都没有答案，用户只能靠猜或自己去翻磁盘。 */
        '    <div class="settings-row">' +
        '      <div class="settings-row-text">' +
        '        <div class="settings-row-title">数据体检</div>' +
        '        <div class="settings-row-desc" id="storageCheckBody" style="white-space:pre-line;">正在读取…</div>' +
        '      </div>' +
        '      <button type="button" class="lib-btn" id="setStorageCheckBtn">重新检测</button>' +
        '    </div>' +
        '    <div class="settings-row">' +
        '      <div class="settings-row-text">' +
        '        <div class="settings-row-title">导出数据</div>' +
        '        <div class="settings-row-desc">把当前简历数据导出为 JSON 文件备份</div>' +
        '      </div>' +
        '      <button type="button" class="lib-btn" id="setExportBtn">导出 JSON</button>' +
        '    </div>' +
        '    <div class="settings-row">' +
        '      <div class="settings-row-text">' +
        '        <div class="settings-row-title">导入数据</div>' +
        '        <div class="settings-row-desc">从此前导出的 JSON 恢复</div>' +
        '      </div>' +
        '      <button type="button" class="lib-btn" id="setImportBtn">导入 JSON</button>' +
        '    </div>' +
        '    <div class="settings-row">' +
        '      <div class="settings-row-text">' +
        '        <div class="settings-row-title danger">清空本地</div>' +
        '        <div class="settings-row-desc">清空浏览器本地保存，回到内置初始数据</div>' +
        '      </div>' +
        '      <button type="button" class="lib-btn danger" id="setClearBtn">清空本地</button>' +
        '    </div>' +
        '  </section>' +

        /* 关于 */
        '  <section class="settings-section">' +
        '    <h2 class="settings-h2">关于</h2>' +
        '    <div class="settings-row">' +
        '      <div class="settings-row-text">' +
        '        <div class="settings-row-title">简历工作台</div>' +
        '        <div class="settings-row-desc">纯前端简历编辑器 · 零后端 · 数据可移植</div>' +
        '      </div>' +
        '    </div>' +
        '  </section>' +

        '  </div>' +
        '</div>';

      // 绑定事件
      root.querySelector('.settings-back').addEventListener('click', function (e) {
        e.preventDefault();
        global.ResumeRouter.navigate('/library');
      });

      root.querySelector('#setReportBtn').addEventListener('click', function () {
        if (global.ResumeEditor && global.ResumeEditor.reportToFeishu) {
          global.ResumeEditor.reportToFeishu();
        }
      });
      root.querySelector('#setPullBtn').addEventListener('click', function () {
        if (global.ResumeEditor && global.ResumeEditor.pullFromFeishu) {
          global.ResumeEditor.pullFromFeishu();
        }
      });
      root.querySelector('#setHistoryBtn').addEventListener('click', function () {
        global.ResumeRouter.navigate('/history');
      });

      // 主题切换
      root.querySelectorAll('[data-theme]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var mode = btn.getAttribute('data-theme');
          if (global.ResumeEditor && global.ResumeEditor.setThemeMode) {
            global.ResumeEditor.setThemeMode(mode);
          }
          root.querySelectorAll('[data-theme]').forEach(function (b) {
            b.classList.toggle('on', b === btn);
          });
        });
      });
      // 纸张暗色
      root.querySelector('#setPaperDark').addEventListener('change', function (e) {
        if (global.ResumeEditor && global.ResumeEditor.togglePaperTheme) {
          global.ResumeEditor.togglePaperTheme();
        }
      });

      // 数据操作
      const storageBtn = root.querySelector('#setStorageCheckBtn');
      if (storageBtn) storageBtn.addEventListener('click', function () { renderStorageCheck(root); });
      renderStorageCheck(root);
      root.querySelector('#setExportBtn').addEventListener('click', function () {
        if (global.ResumeEditor && global.ResumeEditor.exportJSON) {
          global.ResumeEditor.exportJSON();
        }
      });
      root.querySelector('#setImportBtn').addEventListener('click', function () {
        var fi = document.getElementById('importFile');
        if (fi) fi.click();
      });
      root.querySelector('#setClearBtn').addEventListener('click', function () {
        if (global.ResumeEditor && global.ResumeEditor.clearSaved) {
          global.ResumeEditor.clearSaved();
        }
      });
    }
  };

  global.SettingsView = SettingsView;
})(window);
