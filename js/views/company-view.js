/* =============================================================
 * CompanyView —— 公司档案（纯背景参考）
 * -------------------------------------------------------------
 * 以「公司」为主体，只沉淀公司本身的信息，与投递进度无关：
 *   基本信息 + 调研信息（按业务维度：公司简介/团队/盈利/融资/竞品/风险）
 *   + 对应公司的 JD。
 * 投递相关的平台 / 状态 / 入库 / 锁简历 / IM 聊天记录，统一在「投递管理」板块维护。
 * 调研信息来源平台（BOSS / 猎聘 / 脉脉 / 看准 / 企查查 / 官网 …）仍逐条标注。
 *
 * 数据：ResumeCompanyStore（http 后端 + localStorage 自动降级，与简历库同源）。
 * 视图骨架与样式复用 .tk-* / .lib-btn / .settings-*，新增少量 .co-* 微调。
 * ============================================================= */
(function (global) {
  'use strict';

  var Store = null; // 延迟取 global.ResumeCompanyStore

  function S() { return global.ResumeCompanyStore; }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function platformOptions(sel) {
    return S().PLATFORMS.map(function (p) {
      return '<option' + (p === sel ? ' selected' : '') + '>' + esc(p) + '</option>';
    }).join('');
  }
  /* 时间戳 → YYYY-MM-DD（详情页用） */
  function fmtTs(ts) {
    if (!ts) return '';
    var d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function dimOptions(sel) {
    return S().DIMS.map(function (d) {
      return '<option' + (d === sel ? ' selected' : '') + '>' + esc(d) + '</option>';
    }).join('');
  }
  /* 时间戳 → YYYY-MM-DD HH:MM（JD 投递时刻展示用） */
  function fmtTsTime(ts) {
    if (!ts) return '';
    var d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* 单条投递岗位 JD：仿 BOSS 直聘信息架构的卡片（严格黑 / 白 / 灰，不用红橙） */
  function jdCardHtml(jd) {
    jd = jd || {};
    var metaParts = [jd.city, jd.experience, jd.education].filter(Boolean);
    var metaHtml = metaParts.map(function (m) { return '<span>' + esc(m) + '</span>'; }).join('<i class="co-jd-sep">·</i>');

    var recName = jd.recruiter || '';
    var recInitial = recName ? esc(recName.charAt(0)) : '招';
    var recHtml = recName
      ? '<div class="co-jd-rec"><span class="co-jd-rec-avatar">' + recInitial + '</span>' +
        '<span class="co-jd-rec-name">' + esc(recName) + '</span>' +
        '<span class="co-jd-rec-active">刚刚活跃</span></div>'
      : '';

    var dutyItems = (jd.duties || []).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
    var reqItems = (jd.requirements || []).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
    var descHtml = (dutyItems || reqItems)
      ? '<div class="co-jd-block"><h3>职位描述</h3>' +
        (dutyItems ? '<h4>岗位职责</h4><ul class="co-jd-list">' + dutyItems + '</ul>' : '') +
        (reqItems ? '<h4>任职要求</h4><ul class="co-jd-list">' + reqItems + '</ul>' : '') +
        '</div>'
      : '';

    var skillsHtml = (jd.skills || []).length
      ? '<div class="co-jd-block"><h3>技能要求</h3><div class="co-jd-chips">' +
        jd.skills.map(function (s) { return '<span class="co-jd-chip">' + esc(s) + '</span>'; }).join('') + '</div></div>'
      : '';
    var benefitsHtml = (jd.benefits || []).length
      ? '<div class="co-jd-block"><h3>福利待遇</h3><div class="co-jd-chips">' +
        jd.benefits.map(function (s) { return '<span class="co-jd-chip">' + esc(s) + '</span>'; }).join('') + '</div></div>'
      : '';

    var companyHtml = jd.companyInfo
      ? '<div class="co-jd-company"><span class="co-jd-company-k">公司</span>' + esc(jd.companyInfo) + '</div>' : '';
    var timeText = jd.appliedAt
      ? '记录于 ' + fmtTsTime(jd.appliedAt) + (jd.source ? ' · 来源 ' + esc(jd.source) : '')
      : (jd.source ? '来源 ' + esc(jd.source) : '');
    var timeHtml = timeText ? '<div class="co-jd-time">' + timeText + '</div>' : '';
    var urlHtml = jd.url
      ? '<a class="co-ext" href="' + esc(jd.url) + '" target="_blank" rel="noopener">岗位链接 ↗</a>' : '';

    return '<div class="co-jd-card" id="jd-' + esc(jd.id) + '">' +
      '<div class="co-jd-card-top">' +
        '<div class="co-jd-title">' + esc(jd.title || '未命名岗位') + '</div>' +
        (jd.salary ? '<div class="co-jd-salary">' + esc(jd.salary) + '</div>' : '') +
      '</div>' +
      (metaHtml ? '<div class="co-jd-meta">' + metaHtml + '</div>' : '') +
      recHtml + descHtml + skillsHtml + benefitsHtml +
      '<div class="co-jd-foot">' + companyHtml + timeHtml + urlHtml + '</div>' +
    '</div>';
  }
  function jdIndexHtml(jds) {
    if (!jds || jds.length <= 1) return '';
    return '<div class="co-jd-index">' + jds.map(function (j, i) {
      return '<button type="button" class="co-jd-pill" data-target="jd-' + esc(j.id) + '">' +
        esc(j.title || ('岗位' + (i + 1))) + (j.salary ? ' · ' + esc(j.salary) : '') + '</button>';
    }).join('') + '</div>';
  }

  var CompanyView = {
    root: null,
    list: [],
    editingId: null,   // null=新建，字符串=编辑
    mode: 'list',      // 'list' | 'detail'
    currentId: null,   // 详情模式下的公司 id
    _degraded: false,

    onEnter: function (params) {
      if (!this.root) this.root = global.ResumeLayout.getViewRoot();
      document.body.classList.remove('route-editor');
      document.body.classList.add('route-library'); // 隐藏编辑器本体、显示 view-root

      var self = this;
      self._degraded = false;
      S().onDegrade(function () { self._degraded = true; });

      this.root.innerHTML = this.skeleton();
      this.bindStatic();

      S().loadAll().then(function (list) {
        self.list = Array.isArray(list) ? list : [];
        if (params && params.id) self.renderDetail(params.id);
        else self.renderList();
      }).catch(function () {
        self.list = [];
        if (params && params.id) self.renderDetail(params.id);
        else self.renderList();
      });
    },

    onLeave: function () {
      this.closeEditor();
      if (this.root) this.root.innerHTML = '';
    },

    /* 页面骨架（静态部分）；列表与弹层内容由 renderList / openEditor 填充 */
    skeleton: function () {
      return '' +
      '<div class="tk-page">' +
      '  <div id="coBody"></div>' +

      /* 编辑弹层 */
      '  <div class="tk-modal" id="coModal">' +
      '    <div class="tk-modal-box co-modal-box">' +
      '      <div class="tk-modal-bar">' +
      '        <span id="coModalTitle">新建公司</span>' +
      '        <span style="flex:1"></span>' +
      '        <button type="button" class="tk-x" id="coCancelBtn">取消</button>' +
      '      </div>' +
      '      <div class="tk-modal-body">' +
      '        <label class="tk-field"><span>公司名称 *</span><input type="text" id="coName" placeholder="如 字节跳动"></label>' +
      '        <label class="tk-field"><span>行业</span><input type="text" id="coIndustry" placeholder="如 互联网 / 电商"></label>' +
      '        <label class="tk-field"><span>规模</span><input type="text" id="coScale" placeholder="如 1000-9999人"></label>' +
      '        <label class="tk-field"><span>地点</span><input type="text" id="coLocation" placeholder="如 北京"></label>' +
      '        <label class="tk-field"><span>官网</span><input type="text" id="coWebsite" placeholder="https://..."></label>' +
      '        <label class="tk-field"><span>备注</span><textarea id="coNote" rows="2" placeholder="可选：公司印象、HR 备注、待办等"></textarea></label>' +
      '        <div class="co-research-head">' +
      '          <span>调研信息（来源平台 + 业务维度）</span>' +
      '          <button type="button" class="lib-btn" id="coAddResearch">＋ 添加</button>' +
      '        </div>' +
      '        <div id="coResearch" class="co-research-list"></div>' +
      '        <div class="co-jd-head">' +
      '          <span>岗位 / JD（仿 BOSS 直聘）</span>' +
      '          <button type="button" class="lib-btn" id="coAddJd">＋ 添加岗位</button>' +
      '        </div>' +
      '        <div id="coJds" class="co-jd-list"></div>' +
      '      </div>' +
      '      <div class="tk-modal-foot">' +
      '        <button type="button" class="lib-btn primary" id="coSaveBtn">保存</button>' +
      '      </div>' +
      '    </div>' +
      '  </div>' +
      '</div>';
    },

    bindStatic: function () {
      var self = this;
      // 仅绑定「弹层」相关（列表/详情的元素在各自 render 内绑定，避免重复监听）
      this.root.querySelector('#coCancelBtn').addEventListener('click', function () { self.closeEditor(); });
      this.root.querySelector('#coSaveBtn').addEventListener('click', function () { self.saveEditor(); });
      this.root.querySelector('#coAddResearch').addEventListener('click', function () { self.addResearch(); });
      this.root.querySelector('#coAddJd').addEventListener('click', function () { self.addJd(); });

      // JD 条目容器事件委托（删除）
      this.root.querySelector('#coJds').addEventListener('click', function (e) {
        var item = e.target.closest('.co-jd-item');
        if (!item) return;
        var btn = e.target.closest('[data-act]');
        if (btn && btn.getAttribute('data-act') === 'del') self.removeJd(item.getAttribute('data-jid'));
      });

      // 点遮罩关闭
      this.root.querySelector('#coModal').addEventListener('click', function (e) {
        if (e.target.id === 'coModal') self.closeEditor();
      });

      // 研究条目容器事件委托（删除 / 上下移）
      this.root.querySelector('#coResearch').addEventListener('click', function (e) {
        var item = e.target.closest('.co-research-item');
        if (!item) return;
        var rid = item.getAttribute('data-rid');
        var btn = e.target.closest('[data-act]');
        if (!btn) return;
        var act = btn.getAttribute('data-act');
        if (act === 'del') self.removeResearch(rid);
        else if (act === 'up') self.moveResearch(rid, -1);
        else if (act === 'down') self.moveResearch(rid, 1);
      });
    },

    /* 过滤（搜索） */
    filtered: function () {
      var q = (this.root.querySelector('#coSearch').value || '').trim().toLowerCase();
      if (!q) return this.list;
      return this.list.filter(function (c) {
        return (c.name + ' ' + (c.industry || '') + ' ' + (c.location || '') + ' ' + (c.note || ''))
          .toLowerCase().indexOf(q) >= 0;
      });
    },

    renderList: function () {
      this.mode = 'list';
      this.currentId = null;
      this.root.querySelector('#coBody').innerHTML = this.listPageHtml();
      this.bindList();
      this.updateList();
    },

    /* 列表页骨架（注入 #coBody）；统计 / 表格内容由 updateList 填 */
    listPageHtml: function () {
      return '' +
      '<div class="tk-list">' +
      '  <div class="settings-header">' +
      '    <button type="button" class="settings-back" data-list-back>← 返回</button>' +
      '    <h1 class="settings-title">公司档案</h1>' +
      '    <div style="flex:1"></div>' +
      '    <span class="co-degrade" id="coDegrade" style="display:none">本地存储模式</span>' +
      '    <input type="search" class="co-search" id="coSearch" placeholder="搜索公司 / 行业 / 地点">' +
      '    <button type="button" class="lib-btn primary" id="coNewBtn">＋ 新建公司</button>' +
      '  </div>' +
      '  <div class="tk-stats" id="coStats"></div>' +
      '  <div class="tk-table-wrap">' +
      '    <table class="tk-table co-table">' +
      '      <thead><tr>' +
      '        <th>公司</th><th>行业</th><th>地点</th>' +
      '        <th>调研</th><th>JD</th><th></th>' +
      '      </tr></thead>' +
      '      <tbody id="coTbody"></tbody>' +
      '    </table>' +
      '  </div>' +
      '</div>';
    },

    bindList: function () {
      var self = this;
      var body = this.root.querySelector('#coBody');
      body.querySelector('[data-list-back]').addEventListener('click', function (e) {
        e.preventDefault();
        global.ResumeRouter.navigate('/library');
      });
      body.querySelector('#coNewBtn').addEventListener('click', function () { self.openEditor(null); });
      body.querySelector('#coSearch').addEventListener('input', function () { self.updateList(); });
      // 行内：点「编辑 / 删除」按钮执行对应操作；点行其余区域 → 进入详情
      body.querySelector('#coTbody').addEventListener('click', function (e) {
        var tr = e.target.closest('tr[data-id]');
        if (!tr) return;
        var id = tr.getAttribute('data-id');
        var actBtn = e.target.closest('[data-act]');
        if (actBtn) {
          var act = actBtn.getAttribute('data-act');
          if (act === 'del') { self.deleteRow(id); return; }
          if (act === 'edit') { self.openEditor(id); return; }
          return;
        }
        global.ResumeRouter.navigate('/companies/' + id);
      });
    },

    /* 统计 + 表格 + 降级提示（列表页动态部分；不重建 header，避免清空搜索框） */
    updateList: function () {
      var list = this.list.slice().sort(function (a, b) {
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
      var view = this.filtered();

      // 统计（基于全量，不受搜索影响）
      var st = S().computeStats(this.list);
      var researchCount = this.list.reduce(function (n, c) { return n + (c.research ? c.research.length : 0); }, 0);
      var jdCount = this.list.reduce(function (n, c) { return n + (c.jds ? c.jds.length : 0); }, 0);
      this.root.querySelector('#coStats').innerHTML =
        '<div class="tk-stat"><div class="tk-stat-num">' + st.total + '</div><div class="tk-stat-label">公司档案</div></div>' +
        '<div class="tk-stat"><div class="tk-stat-num">' + st.applied + '</div><div class="tk-stat-label">曾投递</div></div>' +
        '<div class="tk-stat"><div class="tk-stat-num">' + researchCount + '</div><div class="tk-stat-label">调研条目</div></div>' +
        '<div class="tk-stat"><div class="tk-stat-num">' + jdCount + '</div><div class="tk-stat-label">关联JD</div></div>';

      // 降级提示
      this.root.querySelector('#coDegrade').style.display = this._degraded ? 'inline-block' : 'none';

      var rows = view.length ? view.map(function (c) {
        var rc = c.research ? c.research.length : 0;
        var jc = c.jds ? c.jds.length : 0;
        return '<tr data-id="' + esc(c.id) + '">' +
          '<td class="co-name">' + (esc(c.name) || '<span class="tk-empty">未命名</span>') + '</td>' +
          '<td>' + esc(c.industry || '') + '</td>' +
          '<td>' + esc(c.location || '') + '</td>' +
          '<td>' + (rc ? ('<span class="co-rcount">' + rc + '</span>') : '—') + '</td>' +
          '<td>' + (jc ? ('<span class="co-rcount">' + jc + '</span>') : '—') + '</td>' +
          '<td class="tk-ops">' +
            '<button type="button" class="tk-op" data-act="edit">编辑</button>' +
            '<button type="button" class="tk-op danger" data-act="del">删除</button>' +
          '</td>' +
        '</tr>';
      }).join('') :
      '<tr><td colspan="6" class="tk-empty">还没有公司档案。点右上角「＋ 新建公司」开始整理公司背景调研。</td></tr>';

      this.root.querySelector('#coTbody').innerHTML = rows;
    },

    renderDetail: function (id) {
      var c = this.list.filter(function (x) { return x.id === id; })[0];
      if (!c) { this.renderList(); return; }
      this.mode = 'detail';
      this.currentId = id;
      this.root.querySelector('#coBody').innerHTML = this.detailHtml(c);
      this.bindDetail(c);
    },

    /* 调研信息按业务维度分区块 */
    researchSectionsHtml: function (c) {
      c = c || {};
      var order = S().DIM_ORDER;
      var groups = {};
      (c.research || []).forEach(function (r) {
        var k = (r.dim && order.indexOf(r.dim) >= 0) ? r.dim : '其他';
        (groups[k] = groups[k] || []).push(r);
      });
      var sectionsHtml = order.map(function (dim) {
        var items = groups[dim];
        if (!items || !items.length) return '';
        var cards = items.map(function (r) {
          var tag = '<span class="co-rtag">' + esc(r.platform || '其他') + '</span>';
          var date = r.date ? '<span class="co-rdate">' + esc(r.date) + '</span>' : '';
          var url = r.url ? '<a class="co-ext" href="' + esc(r.url) + '" target="_blank" rel="noopener">来源链接 ↗</a>' : '';
          return '<div class="co-rcard">' +
            '<div class="co-rcard-head">' + tag + date + '</div>' +
            '<div class="co-rcard-body">' + esc(r.content || '') + '</div>' +
            (url ? '<div class="co-rcard-foot">' + url + '</div>' : '') +
          '</div>';
        }).join('');
        return '<section class="co-sec"><h2 class="co-sec-title">' + esc(dim) +
          ' <span class="co-count">(' + items.length + ')</span></h2>' +
          '<div class="co-rcards">' + cards + '</div></section>';
      }).join('');
      return sectionsHtml || '<div class="tk-empty">暂无调研信息</div>';
    },

    /* JD 区域 HTML */
    jdAreaHtml: function (c) {
      c = c || {};
      var rcTotal = (c.research || []).length;
      return '<div class="co-jd-area">' +
          '<h2 class="co-sec-title">岗位 / JD <span class="co-count">(' + ((c.jds || []).length) + ')</span></h2>' +
          jdIndexHtml(c.jds) +
          ((c.jds && c.jds.length)
            ? '<div class="co-jd-cards">' + c.jds.map(jdCardHtml).join('') + '</div>'
            : '<div class="tk-empty">暂无岗位 JD（可在「编辑」里补充）</div>') +
        '</div>';
    },

    /* 公司档案简介（纯背景：meta + 备注 + JD + 调研）——投递板块内嵌复用，不含任何投递状态 */
    companyBriefHtml: function (c) {
      c = c || {};
      var meta = [
        ['行业', c.industry],
        ['规模', c.scale],
        ['地点', c.location],
        ['官网', c.website]
      ];
      var metaHtml = meta.map(function (m) {
        var v = m[1];
        var val;
        if (m[0] === '官网' && v) {
          val = '<a class="co-ext" href="' + esc(v) + '" target="_blank" rel="noopener">' + esc(v) + '</a>';
        } else {
          val = v ? esc(v) : '<span class="tk-empty">—</span>';
        }
        return '<div class="co-meta-item"><span class="co-meta-k">' + esc(m[0]) + '</span><span class="co-meta-v">' + val + '</span></div>';
      }).join('');

      var note = c.note
        ? '<div class="co-note">' + esc(c.note) + '</div>'
        : '<div class="co-note tk-empty">暂无备注</div>';

      return '<div class="co-detail-meta">' + metaHtml + '</div>' +
        '<section class="co-sec"><h2 class="co-sec-title">备注</h2>' + note + '</section>' +
        this.jdAreaHtml(c) +
        '<div class="co-research-area">' +
          '<h2 class="co-sec-title">调研信息 <span class="co-count">(' + ((c.research || []).length) + ')</span></h2>' +
          '<div class="co-dim-hint">按业务维度分组 · 每条标注来源平台</div>' +
          this.researchSectionsHtml(c) +
        '</div>';
    },

    /* 详情页 HTML（纯字符串，便于单测）；公司档案纯背景，无投递状态 */
    detailHtml: function (c) {
      c = c || {};
      var upd = c.updatedAt ? fmtTs(c.updatedAt) : '';
      return '' +
      '<div class="co-detail">' +
        '<div class="settings-header co-detail-head">' +
          '<button type="button" class="settings-back" id="coBackBtn">← 返回列表</button>' +
          '<h1 class="settings-title co-detail-name">' + esc(c.name || '未命名公司') + '</h1>' +
          '<div style="flex:1"></div>' +
          (upd ? '<span class="co-upd">更新于 ' + upd + '</span>' : '') +
          '<button type="button" class="lib-btn" id="coEditBtn">编辑</button>' +
          '<button type="button" class="lib-btn danger" id="coDelBtn">删除</button>' +
        '</div>' +
        this.companyBriefHtml(c) +
      '</div>';
    },

    bindDetail: function (c) {
      var self = this;
      this.root.querySelector('#coBackBtn').addEventListener('click', function () {
        global.ResumeRouter.navigate('/companies');
      });
      this.root.querySelector('#coEditBtn').addEventListener('click', function () { self.openEditor(c.id); });
      this.root.querySelector('#coDelBtn').addEventListener('click', function () { self.deleteRow(c.id); });
      // JD 索引药丸：点击滚动到对应卡片
      var idx = this.root.querySelector('.co-jd-index');
      if (idx) idx.addEventListener('click', function (e) {
        var pill = e.target.closest('.co-jd-pill');
        if (!pill) return;
        var t = document.getElementById(pill.getAttribute('data-target'));
        if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    },

    addResearch: function (r) {
      r = r || { id: S().genRid(), platform: S().PLATFORMS[0], dim: '其他', content: '', date: '', url: '' };
      var box = this.root.querySelector('#coResearch');
      var el = document.createElement('div');
      el.className = 'co-research-item';
      el.setAttribute('data-rid', r.id);
      el.innerHTML =
        '<div class="co-research-top">' +
        '  <select class="co-dim">' + dimOptions(r.dim) + '</select>' +
        '  <select class="co-platform">' + platformOptions(r.platform) + '</select>' +
        '  <input type="date" class="co-rdate" value="' + esc(r.date || '') + '">' +
        '  <span class="co-research-move">' +
        '    <button type="button" class="co-move" data-act="up" title="上移">↑</button>' +
        '    <button type="button" class="co-move" data-act="down" title="下移">↓</button>' +
        '    <button type="button" class="co-move danger" data-act="del" title="删除">✕</button>' +
        '  </span>' +
        '</div>' +
        '<textarea class="co-rcontent" rows="2" placeholder="收集到的信息 / 评价 / 要点">' + esc(r.content) + '</textarea>' +
        '<input type="text" class="co-rurl" placeholder="来源链接（可选）" value="' + esc(r.url || '') + '">';
      box.appendChild(el);
    },

    removeResearch: function (rid) {
      var el = this.root.querySelector('.co-research-item[data-rid="' + rid + '"]');
      if (el) el.parentNode.removeChild(el);
    },

    moveResearch: function (rid, dir) {
      var el = this.root.querySelector('.co-research-item[data-rid="' + rid + '"]');
      if (!el) return;
      if (dir < 0 && el.previousElementSibling) el.parentNode.insertBefore(el, el.previousElementSibling);
      else if (dir > 0 && el.nextElementSibling) el.parentNode.insertBefore(el.nextElementSibling, el);
    },

    collectResearch: function () {
      var items = this.root.querySelectorAll('.co-research-item');
      var out = [];
      for (var i = 0; i < items.length; i++) {
        var el = items[i];
        var content = (el.querySelector('.co-rcontent').value || '').trim();
        if (!content && !el.querySelector('.co-rurl').value.trim()) continue; // 跳过空行
        out.push({
          id: el.getAttribute('data-rid') || S().genRid(),
          platform: el.querySelector('.co-platform').value,
          dim: el.querySelector('.co-dim').value,
          content: content,
          date: el.querySelector('.co-rdate').value || '',
          url: (el.querySelector('.co-rurl').value || '').trim()
        });
      }
      return out;
    },

    addJd: function (j) {
      j = j || { id: S().genJid(), title: '', salary: '', city: '', experience: '', education: '', recruiter: '', source: 'BOSS直聘', appliedAt: '', skills: [], benefits: [], duties: [], requirements: [], companyInfo: '', url: '' };
      var box = this.root.querySelector('#coJds');
      var el = document.createElement('div');
      el.className = 'co-jd-item';
      el.setAttribute('data-jid', j.id);
      el.innerHTML =
        '<div class="co-jd-item-bar">' +
          '<span class="co-jd-item-title">岗位</span>' +
          '<span style="flex:1"></span>' +
          '<button type="button" class="co-move danger" data-act="del" title="删除岗位">✕</button>' +
        '</div>' +
        '<label class="tk-field"><span>岗位名称</span><input type="text" class="co-jd-title-i" placeholder="如 Agent 研发高级工程师" value="' + esc(j.title) + '"></label>' +
        '<label class="tk-field"><span>薪资</span><input type="text" class="co-jd-salary-i" placeholder="如 30-60K" value="' + esc(j.salary) + '"></label>' +
        '<div class="co-jd-grid">' +
          '<label class="tk-field"><span>城市</span><input type="text" class="co-jd-city-i" value="' + esc(j.city) + '"></label>' +
          '<label class="tk-field"><span>经验</span><input type="text" class="co-jd-exp-i" value="' + esc(j.experience) + '"></label>' +
          '<label class="tk-field"><span>学历</span><input type="text" class="co-jd-edu-i" value="' + esc(j.education) + '"></label>' +
        '</div>' +
        '<label class="tk-field"><span>招聘者（姓名·职位）</span><input type="text" class="co-jd-rec-i" placeholder="如 刘女士·HRBP" value="' + esc(j.recruiter) + '"></label>' +
        '<div class="co-jd-grid">' +
          '<label class="tk-field"><span>来源</span><input type="text" class="co-jd-src-i" value="' + esc(j.source || 'BOSS直聘') + '"></label>' +
          '<label class="tk-field"><span>投递时间</span><input type="datetime-local" class="co-jd-at-i" value="' + esc(S().toDateTimeLocal(j.appliedAt)) + '"></label>' +
        '</div>' +
        '<label class="tk-field"><span>技能标签（逗号分隔）</span><input type="text" class="co-jd-skills-i" placeholder="如 Java, Python, MySQL" value="' + esc((j.skills || []).join(', ')) + '"></label>' +
        '<label class="tk-field"><span>福利标签（逗号分隔）</span><input type="text" class="co-jd-benefits-i" placeholder="如 节日福利, 餐补" value="' + esc((j.benefits || []).join(', ')) + '"></label>' +
        '<label class="tk-field"><span>岗位职责（每行一条）</span><textarea class="co-jd-duties-i" rows="4" placeholder="每行一条职责">' + esc((j.duties || []).join('\n')) + '</textarea></label>' +
        '<label class="tk-field"><span>任职要求（每行一条）</span><textarea class="co-jd-reqs-i" rows="4" placeholder="每行一条要求">' + esc((j.requirements || []).join('\n')) + '</textarea></label>' +
        '<label class="tk-field"><span>公司补充（已上市·规模·行业）</span><input type="text" class="co-jd-info-i" placeholder="如 已上市 · 1000-9999人 · 互联网" value="' + esc(j.companyInfo) + '"></label>' +
        '<label class="tk-field"><span>岗位链接</span><input type="text" class="co-jd-url-i" placeholder="https://..." value="' + esc(j.url) + '"></label>';
      box.appendChild(el);
    },

    removeJd: function (jid) {
      var el = this.root.querySelector('.co-jd-item[data-jid="' + jid + '"]');
      if (el) el.parentNode.removeChild(el);
    },

    collectJds: function () {
      var items = this.root.querySelectorAll('.co-jd-item');
      var out = [];
      for (var i = 0; i < items.length; i++) {
        var el = items[i];
        var title = (el.querySelector('.co-jd-title-i').value || '').trim();
        if (!title) continue; // 跳过空岗位
        var lines = function (sel) {
          return (el.querySelector(sel).value || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
        };
        var csv = function (sel) {
          return (el.querySelector(sel).value || '').split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
        };
        out.push({
          id: el.getAttribute('data-jid') || S().genJid(),
          title: title,
          salary: (el.querySelector('.co-jd-salary-i').value || '').trim(),
          city: (el.querySelector('.co-jd-city-i').value || '').trim(),
          experience: (el.querySelector('.co-jd-exp-i').value || '').trim(),
          education: (el.querySelector('.co-jd-edu-i').value || '').trim(),
          recruiter: (el.querySelector('.co-jd-rec-i').value || '').trim(),
          source: (el.querySelector('.co-jd-src-i').value || '').trim(),
          appliedAt: S().fromDateTimeLocal(el.querySelector('.co-jd-at-i').value),
          skills: csv('.co-jd-skills-i'),
          benefits: csv('.co-jd-benefits-i'),
          duties: lines('.co-jd-duties-i'),
          requirements: lines('.co-jd-reqs-i'),
          companyInfo: (el.querySelector('.co-jd-info-i').value || '').trim(),
          url: (el.querySelector('.co-jd-url-i').value || '').trim()
        });
      }
      return out;
    },

    openEditor: function (id) {
      this.editingId = id;
      var modal = this.root.querySelector('#coModal');
      this.root.querySelector('#coModalTitle').textContent = id ? '编辑公司' : '新建公司';

      var c = null;
      if (id) c = this.list.filter(function (x) { return x.id === id; })[0];
      c = S().normalizeCompany(c || {});

      this.root.querySelector('#coName').value = c.name;
      this.root.querySelector('#coIndustry').value = c.industry;
      this.root.querySelector('#coScale').value = c.scale;
      this.root.querySelector('#coLocation').value = c.location;
      this.root.querySelector('#coWebsite').value = c.website;
      this.root.querySelector('#coNote').value = c.note;

      // 研究条目
      var box = this.root.querySelector('#coResearch');
      box.innerHTML = '';
      var self = this;
      (c.research || []).forEach(function (r) { self.addResearch(r); });

      // 投递岗位 JD
      var jbox = this.root.querySelector('#coJds');
      jbox.innerHTML = '';
      (c.jds || []).forEach(function (j) { self.addJd(j); });

      modal.style.display = 'flex';
      setTimeout(function () { try { self.root.querySelector('#coName').focus(); } catch (e) {} }, 0);
    },

    closeEditor: function () {
      var modal = this.root.querySelector('#coModal');
      if (modal) modal.style.display = 'none';
      this.editingId = null;
    },

    saveEditor: function () {
      var name = (this.root.querySelector('#coName').value || '').trim();
      if (!name) { alert('公司名称必填'); return; }

      var research = this.collectResearch();
      var data = {
        name: name,
        industry: (this.root.querySelector('#coIndustry').value || '').trim(),
        scale: (this.root.querySelector('#coScale').value || '').trim(),
        location: (this.root.querySelector('#coLocation').value || '').trim(),
        website: (this.root.querySelector('#coWebsite').value || '').trim(),
        note: (this.root.querySelector('#coNote').value || '').trim(),
        research: research,
        jds: this.collectJds(),
        updatedAt: Date.now()
      };

      if (this.editingId) {
        this.list = this.list.map(function (c) {
          return c.id === this.editingId ? Object.assign({}, c, data) : c;
        }, this);
      } else {
        data.id = S().genId();
        data.createdAt = Date.now();
        this.list.push(data);
      }

      var self = this;
      S().saveAll(this.list).then(function () {
        self.closeEditor();
        if (self.mode === 'detail' && self.currentId) self.renderDetail(self.currentId);
        else self.renderList();
      }).catch(function (e) {
        alert('保存失败：' + (e && e.message ? e.message : e));
      });
    },

    deleteRow: function (id) {
      var c = this.list.filter(function (x) { return x.id === id; })[0];
      if (!c) return;
      if (!confirm('删除公司「' + (c.name || '未命名') + '」及其全部调研信息？')) return;
      this.list = this.list.filter(function (x) { return x.id !== id; });
      var self = this;
      S().saveAll(this.list).then(function () { self.renderList(); })
        .catch(function (e) { alert('删除失败：' + (e && e.message ? e.message : e)); });
    }
  };

  global.CompanyView = CompanyView;
})(window);
