/* =============================================================
 * TrackerView —— 投递管理（整合「公司内容」+ IM 聊天记录）
 * -------------------------------------------------------------
 * 数据存 localStorage（key: resume_tracker_v1），不建后端；公司背景
 * 通过 /api/companies（同源）拉取并内嵌展示，实现「公司内容合并进投递板块」。
 *
 * 每条投递记录：
 *   { id, company(名称), companyId(关联公司档案), position, platform(投递平台),
 *     appliedAt, status(流程), inPool(入库), locked(锁简历),
 *     resumeTitle, note, chat:[{id, role('me'|'hr'|'sys'), name, ts, text}] }
 *
 * 状态机（灰度配色，遵循项目黑/白/灰规范）：
 *   applied → written → interview1 → interview2 → hr → offer
 *   任意 → rejected / gaveup
 * ============================================================= */
(function (global) {
  'use strict';

  var LS_KEY = 'resume_tracker_v1';
  /* 已并入的「聊天种子包」版本号（后端 /api/tracker-seed 提供，见 data/tracker/seed.json） */
  var SEED_KEY = 'resume_tracker_seed_v1';

  /* 投递平台（下拉选项）—— 回答「在哪投的」 */
  var PLATFORMS = ['BOSS直聘', '猎聘', '脉脉', '内推', '官网', '猎头', '校招', '其他'];

  /* 流程状态：全部用灰度，避免彩色（项目规范：仅黑/白/灰） */
  var STATUS = {
    applied:    { label: '已投递', tone: 'a' },
    written:    { label: '笔试中', tone: 'b' },
    interview1: { label: '一面',   tone: 'b' },
    interview2: { label: '二面',   tone: 'b' },
    hr:         { label: 'HR面',  tone: 'b' },
    offer:      { label: 'Offer',  tone: 'strong' },
    rejected:   { label: '已拒',   tone: 'c' },
    gaveup:     { label: '放弃',   tone: 'c' }
  };
  var STATUS_ORDER = ['applied','written','interview1','interview2','hr','offer','rejected','gaveup'];

  /* 聊天角色：me=我(右侧)，hr=对方(左侧)，sys=系统/时间分割(居中) */
  var ROLES = [
    { key: 'me', label: '我' },
    { key: 'hr', label: '对方' },
    { key: 'sys', label: '系统' }
  ];

  function loadAll() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function saveAll(list) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch (e) {}
  }
  function genId() {
    return 'tk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function genMid() {
    return 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function seedVersion() {
    try { return Number(localStorage.getItem(SEED_KEY)) || 0; } catch (e) { return 0; }
  }
  function markSeedVersion(v) {
    try { localStorage.setItem(SEED_KEY, String(v)); } catch (e) {}
  }
  function fmtDate(ts) {
    if (!ts) return '';
    var d = new Date(Number(ts));
    var m = (d.getMonth() + 1).toString().padStart(2, '0');
    var day = d.getDate().toString().padStart(2, '0');
    return m + '-' + day;
  }
  function fmtDateTime(ts) {
    if (!ts) return '';
    var d = new Date(Number(ts));
    return (d.getMonth()+1) + '/' + d.getDate() + ' ' +
      d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
  }
  function toDateTimeLocal(ts) {
    if (!ts) return '';
    var d = new Date(Number(ts));
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function fromDateTimeLocal(v) {
    if (!v) return null;
    var t = Date.parse(v);
    return isNaN(t) ? null : t;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function statusLabel(k) { return (STATUS[k] && STATUS[k].label) || k; }
  function statusTone(k) { return (STATUS[k] && STATUS[k].tone) || 'a'; }

  /* 记录规整：兼容旧版 channel 字段，补齐新字段 */
  function normalizeRecord(r) {
    r = r || {};
    return {
      id: r.id || genId(),
      company: (r.company || '').trim(),
      companyId: r.companyId || '',
      position: (r.position || '').trim(),
      platform: r.platform || r.channel || PLATFORMS[0],
      appliedAt: r.appliedAt ? Number(r.appliedAt) : null,
      status: r.status || 'applied',
      inPool: !!r.inPool,
      locked: !!r.locked,
      resumeTitle: (r.resumeTitle || '').trim(),
      note: (r.note || '').trim(),
      chat: Array.isArray(r.chat) ? r.chat.map(function (m) {
        return {
          id: m.id || genMid(),
          role: (m.role === 'me' || m.role === 'hr' || m.role === 'sys') ? m.role : 'hr',
          name: (m.name || '').trim(),
          ts: m.ts ? Number(m.ts) : null,
          text: (m.text || '').trim()
        };
      }) : []
    };
  }

  function platformOptions(sel) {
    return PLATFORMS.map(function (p) {
      return '<option' + (p === sel ? ' selected' : '') + '>' + esc(p) + '</option>';
    }).join('');
  }
  function statusOptions(sel) {
    return STATUS_ORDER.map(function (k) {
      return '<option value="' + k + '"' + (k === sel ? ' selected' : '') + '>' + STATUS[k].label + '</option>';
    }).join('');
  }
  function roleOptions(sel) {
    return ROLES.map(function (x) {
      return '<option value="' + x.key + '"' + (x.key === sel ? ' selected' : '') + '>' + x.label + '</option>';
    }).join('');
  }

  var TrackerView = {
    root: null,
    list: [],         // 投递记录
    companies: [],    // 公司档案（来自 /api/companies）
    companiesById: {},
    editingId: null,
    mode: 'list',
    currentId: null,

    onEnter: function (params) {
      if (!this.root) this.root = global.ResumeLayout.getViewRoot();
      document.body.classList.remove('route-editor');
      document.body.classList.add('route-library');

      var self = this;
      this.list = loadAll().map(normalizeRecord);

      // 拉取公司档案（用于内嵌公司背景 + 自动建档 + 名称联想）→ 并入聊天种子包 → 渲染
      var go = function () {
        if (params && params.id) self.renderDetail(params.id);
        else self.renderList();
      };
      this.loadCompanies().then(function () {
        self.autoCreateFromCompanies();
        return self.loadSeed();
      }).then(go).catch(function () {
        // 离线 / 无后端：仍可用，只是没有公司背景内嵌
        go();
      });
    },

    onLeave: function () {
      this.closeEditor();
      if (this.root) this.root.innerHTML = '';
    },

    loadCompanies: function () {
      var self = this;
      if (typeof fetch !== 'function') return Promise.reject(new Error('no fetch'));
      return fetch('/api/companies', { cache: 'no-store' }).then(function (r) {
        return r.json().then(function (j) {
          var arr = (j && j.companies) || [];
          self.companies = arr;
          self.companiesById = {};
          arr.forEach(function (c) { self.companiesById[c.id] = c; });
          return arr;
        });
      });
    },

    /* 为「曾投递」的公司自动建立投递记录（避免手动重复录入） */
    autoCreateFromCompanies: function () {
      var self = this;
      var changed = false;
      this.companies.forEach(function (c) {
        if (!c.applied) return;
        var exists = self.list.some(function (t) {
          return t.companyId === c.id || (t.company && t.company === c.name);
        });
        if (exists) return;
        var jd = (c.jds && c.jds[0]) || null;
        self.list.push(normalizeRecord({
          company: c.name,
          companyId: c.id,
          position: jd ? jd.title : '',
          platform: jd ? (jd.source || 'BOSS直聘') : 'BOSS直聘',
          appliedAt: jd ? jd.appliedAt : null,
          status: 'applied',
          inPool: false,
          locked: false,
          chat: []
        }));
        changed = true;
      });
      if (changed) { saveAll(this.list); }
    },

    /* ---------- 聊天种子包（截图整理好的聊天记录，一次性并入）----------
     * 后端 GET /api/tracker-seed → data/tracker/seed.json
     * 只往「已存在的投递记录」里追加聊天，不新建记录、不覆盖用户改动；
     * 同角色+同文本视作同一条（重复并入不会产生副本）。 */
    loadSeed: function () {
      var self = this;
      if (typeof fetch !== 'function') return Promise.resolve(0);
      return fetch('/api/tracker-seed', { cache: 'no-store' }).then(function (resp) {
        if (!resp.ok) return null;
        return resp.json();
      }).then(function (seed) {
        return self.applySeed(seed);
      }).catch(function () { return 0; });
    },

    applySeed: function (seed) {
      if (!seed || !Array.isArray(seed.records) || !seed.records.length) return 0;
      var v = Number(seed.version) || 0;
      if (v <= seedVersion()) return 0;

      var self = this;
      var added = 0, matched = 0;
      // 岗位名比较：忽略空格，避免「Agent 研发高级工程师」与「Agent研发高级工程师」错配
      var norm = function (s) { return String(s || '').replace(/\s+/g, ''); };
      seed.records.forEach(function (s) {
        var target = self.list.filter(function (r) {
          if (s.companyId && r.companyId === s.companyId) return true;
          if (!s.company || r.company !== s.company) return false;
          return !s.position || !r.position || norm(r.position) === norm(s.position);
        })[0];
        if (!target) return;
        matched++;
        target.chat = target.chat || [];
        // 空字段顺手补齐（不覆盖用户已填内容）
        if (!target.position && s.position) target.position = s.position;
        if (!target.resumeTitle && s.resumeTitle) target.resumeTitle = s.resumeTitle;
        if (!target.note && s.note) target.note = s.note;
        (s.chat || []).forEach(function (m) {
          var dup = target.chat.some(function (x) {
            return x.role === m.role && x.text === (m.text || '') &&
              (m.ts ? x.ts === m.ts : !x.ts);
          });
          if (dup) return;
          target.chat.push({
            id: genMid(),
            role: (m.role === 'me' || m.role === 'hr' || m.role === 'sys') ? m.role : 'hr',
            name: (m.name || '').trim(),
            ts: m.ts ? Number(m.ts) : null,
            text: (m.text || '').trim()
          });
          added++;
        });
      });

      if (added) this.persist();
      // 有记录被匹配上才记版本号；否则下次仍会重试（防止公司档案尚未建好时漏数据）
      if (matched) markSeedVersion(v);
      this.seededCount = added;
      return added;
    },

    /* ---------- 列表页 ---------- */
    renderList: function () {
      this.mode = 'list';
      this.currentId = null;
      var self = this;
      var list = this.list;

      var now = new Date();
      var thisMonth = list.filter(function (r) {
        var d = new Date(r.appliedAt);
        return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
      }).length;
      var active = list.filter(function (r) {
        return ['applied','written','interview1','interview2','hr'].indexOf(r.status) >= 0;
      }).length;
      var offers = list.filter(function (r) { return r.status === 'offer'; }).length;
      var chatTotal = list.reduce(function (n, r) { return n + (r.chat ? r.chat.length : 0); }, 0);

      var rowsHtml = list.length ? list.slice().sort(function (a, b) {
        return (b.appliedAt || 0) - (a.appliedAt || 0);
      }).map(function (r) {
        var chatN = (r.chat || []).length;
        return '<tr data-id="' + esc(r.id) + '">' +
          '<td class="tk-co-cell">' + esc(r.company) + '</td>' +
          '<td>' + esc(r.position) + '</td>' +
          '<td><span class="tk-platform">' + esc(r.platform) + '</span></td>' +
          '<td><span class="tk-status tk-tone-' + statusTone(r.status) + '">' + statusLabel(r.status) + '</span></td>' +
          '<td>' + fmtDate(r.appliedAt) + '</td>' +
          '<td>' + (chatN ? ('<span class="co-rcount">' + chatN + '</span>') : '—') + '</td>' +
          '<td class="tk-ops">' +
            '<button type="button" class="tk-op" data-act="edit">编辑</button>' +
            '<button type="button" class="tk-op danger" data-act="del">删除</button>' +
          '</td>' +
        '</tr>';
      }).join('') :
      '<tr><td colspan="7" class="tk-empty">还没有投递记录。点右上角「＋ 新建记录」开始追踪，或先到「公司档案」建立公司背景。</td></tr>';

      this.root.innerHTML =
        '<div class="tk-page">' +
        '  <div class="settings-header">' +
        '    <button type="button" class="settings-back" data-nav="/library">← 返回</button>' +
        '    <h1 class="settings-title">投递管理</h1>' +
        '    <div style="flex:1"></div>' +
        '    <button type="button" class="lib-btn primary" id="tkNewBtn">＋ 新建记录</button>' +
        '  </div>' +

        '  <div class="tk-stats">' +
        '    <div class="tk-stat"><div class="tk-stat-num">' + thisMonth + '</div><div class="tk-stat-label">本月投递</div></div>' +
        '    <div class="tk-stat"><div class="tk-stat-num">' + active + '</div><div class="tk-stat-label">在流程中</div></div>' +
        '    <div class="tk-stat"><div class="tk-stat-num">' + offers + '</div><div class="tk-stat-label">Offer</div></div>' +
        '    <div class="tk-stat"><div class="tk-stat-num">' + chatTotal + '</div><div class="tk-stat-label">聊天记录</div></div>' +
        '  </div>' +

        '  <div class="tk-table-wrap">' +
        '    <table class="tk-table">' +
        '      <thead><tr>' +
        '        <th>公司</th><th>岗位</th><th>投递平台</th>' +
        '        <th>状态</th><th>投递日期</th><th>聊天</th><th></th>' +
        '      </tr></thead>' +
        '      <tbody>' + rowsHtml + '</tbody>' +
        '    </table>' +
        '  </div>' +

        /* 编辑弹层 */
        this.editorSkeleton() +
        '</div>';

      // 绑定
      this.root.querySelector('.settings-back').addEventListener('click', function (e) {
        e.preventDefault();
        global.ResumeRouter.navigate('/library');
      });
      this.root.querySelector('#tkNewBtn').addEventListener('click', function () { self.openEditor(null); });
      this.root.querySelectorAll('tbody tr[data-id]').forEach(function (tr) {
        tr.addEventListener('click', function (e) {
          var btn = e.target.closest('[data-act]');
          if (btn) {
            var id = tr.getAttribute('data-id');
            if (btn.getAttribute('data-act') === 'edit') self.openEditor(id);
            else if (btn.getAttribute('data-act') === 'del') self.deleteRow(id);
            return;
          }
          global.ResumeRouter.navigate('/tracker/' + tr.getAttribute('data-id'));
        });
      });
      this.bindEditor();
    },

    /* ---------- 详情页（内嵌公司背景 + 聊天记录） ---------- */
    renderDetail: function (id) {
      var r = this.list.filter(function (x) { return x.id === id; })[0];
      if (!r) { this.renderList(); return; }
      this.mode = 'detail';
      this.currentId = id;
      var self = this;

      var company = r.companyId ? this.companiesById[r.companyId] : null;
      if (!company) {
        // 按名称兜底匹配
        company = this.companies.filter(function (c) { return c.name === r.company; })[0] || null;
      }
      var briefHtml = company
        ? '<div class="tk-company-brief"><h2 class="co-sec-title">公司背景（来自公司档案）' +
          (company.id ? ' <a class="co-ext" href="#/companies/' + esc(company.id) + '">查看完整档案 ↗</a>' : '') +
          '</h2>' + global.CompanyView.companyBriefHtml(company) + '</div>'
        : '<div class="tk-notebox">未关联到公司档案。可在「公司档案」中建立同名公司，或在下方编辑里修正公司名。</div>';

      var detail =
        '<div class="tk-detail">' +
          '<div class="settings-header">' +
            '<button type="button" class="settings-back" id="tkBackBtn">← 返回列表</button>' +
            '<h1 class="settings-title">' + esc(r.company) + '</h1>' +
            '<div style="flex:1"></div>' +
            '<button type="button" class="lib-btn" id="tkEditBtn">编辑</button>' +
            '<button type="button" class="lib-btn danger" id="tkDelBtn">删除</button>' +
          '</div>' +

          '<div class="tk-detail-card">' +
            '<div class="tk-detail-row"><span class="tk-detail-k">岗位</span><span class="tk-detail-v">' + esc(r.position || '—') + '</span></div>' +
            '<div class="tk-detail-row"><span class="tk-detail-k">投递平台</span><span class="tk-detail-v"><span class="tk-platform">' + esc(r.platform) + '</span></span></div>' +
            '<div class="tk-detail-row"><span class="tk-detail-k">状态</span><span class="tk-detail-v"><span class="tk-status tk-tone-' + statusTone(r.status) + '">' + statusLabel(r.status) + '</span></span></div>' +
            '<div class="tk-detail-row"><span class="tk-detail-k">投递日期</span><span class="tk-detail-v">' + (r.appliedAt ? esc(fmtDate(r.appliedAt)) : '—') + '</span></div>' +
            '<div class="tk-detail-row"><span class="tk-detail-k">入库</span><span class="tk-detail-v">' + (r.inPool ? '是' : '否') + '</span></div>' +
            '<div class="tk-detail-row"><span class="tk-detail-k">锁简历</span><span class="tk-detail-v">' + (r.locked ? '是' : '否') + '</span></div>' +
            (r.resumeTitle ? '<div class="tk-detail-row"><span class="tk-detail-k">关联简历</span><span class="tk-detail-v">' + esc(r.resumeTitle) + '</span></div>' : '') +
            (r.note ? '<div class="tk-detail-row"><span class="tk-detail-k">备注</span><span class="tk-detail-v">' + esc(r.note) + '</span></div>' : '') +
          '</div>' +

          briefHtml +

          this.chatSectionHtml(r) +
          this.editorSkeleton() +
        '</div>';

      this.root.innerHTML = detail;

      this.root.querySelector('#tkBackBtn').addEventListener('click', function () {
        global.ResumeRouter.navigate('/tracker');
      });
      this.root.querySelector('#tkEditBtn').addEventListener('click', function () { self.openEditor(r.id); });
      this.root.querySelector('#tkDelBtn').addEventListener('click', function () { self.deleteRow(r.id); });
      this.bindChat(r);
      this.bindEditor();
    },

    /* 聊天记录区 HTML */
    chatSectionHtml: function (r) {
      var msgs = r.chat || [];
      var items = msgs.length ? msgs.map(function (m) {
        var time = m.ts ? '<span class="tk-msg-time">' + esc(fmtDateTime(m.ts)) + '</span>' : '';
        var name = m.name ? '<span class="tk-msg-name">' + esc(m.name) + '</span>' : '';
        if (m.role === 'sys') {
          return '<div class="tk-msg sys"><span>' + esc(m.text) + '</span></div>';
        }
        return '<div class="tk-msg ' + m.role + '">' +
          '<div class="tk-msg-bubble">' +
            (name ? name : '') +
            '<div class="tk-msg-text">' + esc(m.text) + '</div>' +
            time +
          '</div>' +
          '<button type="button" class="tk-msg-del" data-mid="' + esc(m.id) + '" title="删除">✕</button>' +
        '</div>';
      }).join('') : '<div class="tk-empty">暂无聊天记录。可手动添加，或点「从 BOSS 直聘采集」。</div>';

      return '<div class="tk-chat-block">' +
        '<div class="tk-chat-head">' +
          '<h2 class="co-sec-title">IM 聊天记录 <span class="co-count">(' + msgs.length + ')</span></h2>' +
          '<button type="button" class="lib-btn" id="tkCollectBtn">从 BOSS 直聘采集</button>' +
        '</div>' +
        '<div class="tk-chat-list" id="tkChatList">' + items + '</div>' +
        '<div class="tk-chat-form">' +
          '<div class="tk-chat-form-row">' +
            '<select id="tkMsgRole">' + roleOptions('hr') + '</select>' +
            '<input type="text" id="tkMsgName" placeholder="对方姓名 / 职位（可选）">' +
            '<input type="datetime-local" id="tkMsgTime" title="时间（可选）">' +
          '</div>' +
          '<textarea id="tkMsgText" rows="2" placeholder="聊天内容，每行或整段一条"></textarea>' +
          '<div class="tk-chat-form-row">' +
            '<span style="flex:1"></span>' +
            '<button type="button" class="lib-btn" id="tkAddMsgBtn">添加记录</button>' +
          '</div>' +
        '</div>' +
        '<div class="tk-collect-status" id="tkCollectStatus" style="display:none"></div>' +
      '</div>';
    },

    bindChat: function (r) {
      var self = this;
      var list = this.root.querySelector('#tkChatList');
      if (list) list.addEventListener('click', function (e) {
        var btn = e.target.closest('.tk-msg-del');
        if (!btn) return;
        self.removeMessage(r.id, btn.getAttribute('data-mid'));
      });
      this.root.querySelector('#tkAddMsgBtn').addEventListener('click', function () { self.addMessage(r.id); });
      this.root.querySelector('#tkCollectBtn').addEventListener('click', function () { self.collectChat(r.id); });
    },

    addMessage: function (rid) {
      var r = this.findRec(rid);
      if (!r) return;
      var role = this.root.querySelector('#tkMsgRole').value;
      var name = this.root.querySelector('#tkMsgName').value.trim();
      var ts = fromDateTimeLocal(this.root.querySelector('#tkMsgTime').value);
      var text = this.root.querySelector('#tkMsgText').value.trim();
      if (!text) { alert('请输入聊天内容'); return; }
      r.chat = r.chat || [];
      r.chat.push({ id: genMid(), role: role, name: name, ts: ts, text: text });
      this.persist();
      this.renderDetail(rid);
    },

    removeMessage: function (rid, mid) {
      var r = this.findRec(rid);
      if (!r) return;
      r.chat = (r.chat || []).filter(function (m) { return m.id !== mid; });
      this.persist();
      this.renderDetail(rid);
    },

    /* 调用后端 /api/collect-chat 从已登录的 BOSS 直聘 Chrome 采集聊天 */
    collectChat: function (rid) {
      var r = this.findRec(rid);
      if (!r) return;
      var status = this.root.querySelector('#tkCollectStatus');
      status.style.display = 'block';
      status.textContent = '正在从 BOSS 直聘采集「' + r.company + '」的聊天记录…（需要本机 Chrome 已开启远程调试且登录 BOSS）';
      status.className = 'tk-collect-status';

      var self = this;
      fetch('/api/collect-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company: r.company, platform: r.platform || 'BOSS直聘' })
      }).then(function (resp) {
        return resp.json().then(function (j) {
          if (!resp.ok) throw new Error((j && j.error) || ('HTTP ' + resp.status));
          return j;
        });
      }).then(function (j) {
        var msgs = (j && j.messages) || [];
        if (!msgs.length) {
          status.textContent = (j && j.hint) || '未采集到聊天记录。请确认：① Chrome 已用你的登录档案启动并带 --remote-debugging-port=9222；② 已打开与该公司 HR 的对话。';
          status.className = 'tk-collect-status warn';
          return;
        }
        r.chat = r.chat || [];
        msgs.forEach(function (m) {
          r.chat.push({
            id: genMid(),
            role: (m.role === 'me' || m.role === 'hr' || m.role === 'sys') ? m.role : (m.self ? 'me' : 'hr'),
            name: (m.name || '').trim(),
            ts: m.ts || null,
            text: (m.text || '').trim()
          });
        });
        self.persist();
        status.textContent = '成功采集 ' + msgs.length + ' 条聊天记录。';
        status.className = 'tk-collect-status ok';
        self.renderDetail(rid);
      }).catch(function (e) {
        status.textContent = '采集失败：' + (e && e.message ? e.message : e) +
          '。也可直接把聊天截图发给我，我帮你整理进记录。';
        status.className = 'tk-collect-status warn';
      });
    },

    findRec: function (rid) {
      return this.list.filter(function (x) { return x.id === rid; })[0] || null;
    },
    persist: function () {
      saveAll(this.list);
    },

    /* ---------- 编辑弹层 ---------- */
    editorSkeleton: function () {
      var self = this;
      var opts = (this.companies || []).map(function (c) { return '<option value="' + esc(c.name) + '">'; }).join('');
      return '' +
      '  <div class="tk-modal" id="tkModal">' +
      '    <div class="tk-modal-box">' +
      '      <div class="tk-modal-bar">' +
      '        <span id="tkModalTitle">新建记录</span>' +
      '        <span style="flex:1"></span>' +
      '        <button type="button" class="tk-x" id="tkCancelBtn">取消</button>' +
      '      </div>' +
      '      <div class="tk-modal-body">' +
      '        <label class="tk-field"><span>公司 *</span><input type="text" id="tkCompany" list="tkCompanyList" placeholder="如 字节跳动"><datalist id="tkCompanyList">' + opts + '</datalist></label>' +
      '        <label class="tk-field"><span>岗位 *</span><input type="text" id="tkPosition" placeholder="如 后端工程师"></label>' +
      '        <label class="tk-field"><span>投递平台</span><select id="tkPlatform">' + platformOptions(PLATFORMS[0]) + '</select></label>' +
      '        <label class="tk-field"><span>状态</span><select id="tkStatus">' + statusOptions('applied') + '</select></label>' +
      '        <label class="tk-field"><span>投递日期</span><input type="datetime-local" id="tkAppliedAt"></label>' +
      '        <div class="co-flags">' +
      '          <label class="co-check"><input type="checkbox" id="tkInPool"> 已入库</label>' +
      '          <label class="co-check"><input type="checkbox" id="tkLocked"> 锁简历</label>' +
      '        </div>' +
      '        <label class="tk-field"><span>关联简历</span><input type="text" id="tkResume" placeholder="如 简历标题 · 目标岗位"></label>' +
      '        <label class="tk-field"><span>备注</span><textarea id="tkNote" rows="2" placeholder="可选"></textarea></label>' +
      '      </div>' +
      '      <div class="tk-modal-foot">' +
      '        <button type="button" class="lib-btn primary" id="tkSaveBtn">保存</button>' +
      '      </div>' +
      '    </div>' +
      '  </div>';
    },

    bindEditor: function () {
      var self = this;
      var modal = this.root.querySelector('#tkModal');
      if (!modal) return;
      modal.querySelector('#tkCancelBtn').addEventListener('click', function () { self.closeEditor(); });
      modal.querySelector('#tkSaveBtn').addEventListener('click', function () { self.saveEditor(); });
      modal.addEventListener('click', function (e) {
        if (e.target.id === 'tkModal') self.closeEditor();
      });
    },

    openEditor: function (id) {
      this.editingId = id;
      var modal = this.root.querySelector('#tkModal');
      this.root.querySelector('#tkModalTitle').textContent = id ? '编辑记录' : '新建记录';

      var r = id ? this.findRec(id) : null;
      r = normalizeRecord(r || {});
      this.root.querySelector('#tkCompany').value = r.company;
      this.root.querySelector('#tkPosition').value = r.position;
      this.root.querySelector('#tkPlatform').value = r.platform;
      this.root.querySelector('#tkStatus').value = r.status;
      this.root.querySelector('#tkAppliedAt').value = toDateTimeLocal(r.appliedAt);
      this.root.querySelector('#tkInPool').checked = r.inPool;
      this.root.querySelector('#tkLocked').checked = r.locked;
      this.root.querySelector('#tkResume').value = r.resumeTitle;
      this.root.querySelector('#tkNote').value = r.note;

      modal.style.display = 'flex';
      setTimeout(function () { try { self.root.querySelector('#tkCompany').focus(); } catch (e) {} }, 0);
    },

    closeEditor: function () {
      var modal = this.root.querySelector('#tkModal');
      if (modal) modal.style.display = 'none';
      this.editingId = null;
    },

    saveEditor: function () {
      var company = this.root.querySelector('#tkCompany').value.trim();
      var position = this.root.querySelector('#tkPosition').value.trim();
      if (!company || !position) { alert('公司和岗位必填'); return; }

      // 关联公司档案（按名称匹配）
      var matched = this.companies.filter(function (c) { return c.name === company; })[0];
      var data = {
        company: company,
        companyId: matched ? matched.id : '',
        position: position,
        platform: this.root.querySelector('#tkPlatform').value,
        status: this.root.querySelector('#tkStatus').value,
        appliedAt: fromDateTimeLocal(this.root.querySelector('#tkAppliedAt').value),
        inPool: this.root.querySelector('#tkInPool').checked,
        locked: this.root.querySelector('#tkLocked').checked,
        resumeTitle: this.root.querySelector('#tkResume').value.trim(),
        note: this.root.querySelector('#tkNote').value.trim(),
        updatedAt: Date.now()
      };

      if (this.editingId) {
        this.list = this.list.map(function (r) {
          return r.id === this.editingId ? Object.assign({}, r, data) : r;
        }, this);
      } else {
        data.id = genId();
        data.chat = [];
        data.appliedAt = data.appliedAt || Date.now();
        this.list.push(data);
      }
      this.persist();
      this.closeEditor();
      if (this.mode === 'detail' && this.currentId) this.renderDetail(this.currentId);
      else this.renderList();
    },

    deleteRow: function (id) {
      var r = this.findRec(id);
      if (!r) return;
      if (!confirm('删除投递记录「' + r.company + ' · ' + r.position + '」？聊天记录也会一并删除。')) return;
      this.list = this.list.filter(function (x) { return x.id !== id; });
      this.persist();
      if (this.mode === 'detail') global.ResumeRouter.navigate('/tracker');
      else this.renderList();
    }
  };

  global.TrackerView = TrackerView;
})(window);
