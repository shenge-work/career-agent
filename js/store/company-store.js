/* =============================================================
 * CompanyStore —— 公司调研数据层（独立新板块）
 * -------------------------------------------------------------
 * 存储策略与简历库同源：优先走 http 后端（npm start → /api/companies →
 * data/companies/companies.json，持久、跨刷新不丢）；任一请求失败（file:// 双击、
 * 静态托管、写服务未启动）即永久降级 localStorage（key: resume_companies_v1），
 * 保证离线 / 双击打开也能用、刷新不丢。
 *
 * 双环境模块（IIFE + CommonJS）：浏览器挂 window.ResumeCompanyStore；
 * Node 侧 require 可直接拿纯函数用于测试（不触发 fetch / localStorage）。
 *
 * 数据模型（单家公司 · 纯档案，投递相关状态已迁移至「投递板块」）：
 *   { id, name(必填), industry, scale, location, website,
 *     applied:bool(隐藏关联标记：是否曾投递，供投递板块建档),
 *     note, research:[{id,platform,dim,content,date,url}], jds:[...], createdAt, updatedAt }
 * ============================================================= */
(function (global) {
  'use strict';

  var LS_KEY = 'resume_companies_v1';

  /* 调研信息来源平台（下拉选项）—— 回答「这条信息从哪来」 */
  var PLATFORMS = ['BOSS直聘', '猎聘', '脉脉', '看准', '企查查', '天眼查', '官网', '公众号', '牛客', '其他'];

  /* 调研信息业务维度（下拉选项）—— 回答「这条信息讲什么」，详情页按此分区块 */
  var DIMS = ['公司简介', '团队情况', '盈利情况', '融资情况', '竞品分析', '风险与挑战', '其他'];
  /* 详情页分区展示时的固定顺序（不在列表里的归到「其他」之后） */
  var DIM_ORDER = ['公司简介', '团队情况', '盈利情况', '融资情况', '竞品分析', '风险与挑战', '其他'];

  function lsLoad() {
    try {
      var raw = global.localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function lsSave(arr) {
    try { global.localStorage.setItem(LS_KEY, JSON.stringify(arr)); } catch (e) { /* 配额满等：吞掉 */ }
    return Promise.resolve(arr);
  }

  function httpGet() {
    return fetch('/api/companies', { cache: 'no-store' }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
        return (j && j.companies) || [];
      });
    });
  }
  function httpPost(arr) {
    return fetch('/api/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(arr)
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
        return arr;
      });
    });
  }

  /* http 后端 + 自动降级（与简历库同构）：任一请求失败即永久切到 localStorage */
  var _lsFallback = false;
  var _degradeHandler = null;
  function backend() {
    var ls = { load: function () { return Promise.resolve(lsLoad()); }, save: function (a) { return lsSave(a); } };
    if (typeof fetch !== 'function') return ls; // 无 fetch（Node / 极旧环境）直接走 localStorage
    return {
      load: function () {
        if (_lsFallback) return ls.load();
        return httpGet().catch(function () {
          if (!_lsFallback) { _lsFallback = true; if (typeof _degradeHandler === 'function') { try { _degradeHandler(); } catch (e) {} } }
          return ls.load();
        });
      },
      save: function (a) {
        if (_lsFallback) return ls.save(a);
        return httpPost(a).catch(function () {
          if (!_lsFallback) { _lsFallback = true; if (typeof _degradeHandler === 'function') { try { _degradeHandler(); } catch (e) {} } }
          return ls.save(a);
        });
      }
    };
  }

  function genId() {
    return 'co_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function genRid() {
    return 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function genJid() {
    return 'jd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* 显示为 MM-DD（列表用） */
  function fmtDate(ts) {
    if (!ts) return '';
    var d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '';
    var m = (d.getMonth() + 1).toString().padStart(2, '0');
    var day = d.getDate().toString().padStart(2, '0');
    return m + '-' + day;
  }
  /* 显示为 YYYY-MM-DD（<input type="date"> 回显用） */
  function toDateInput(ts) {
    if (!ts) return '';
    var d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '';
    var m = (d.getMonth() + 1).toString().padStart(2, '0');
    var day = d.getDate().toString().padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }
  /* YYYY-MM-DD → 时间戳（保存时用） */
  function fromDateInput(v) {
    if (!v) return null;
    var t = Date.parse(v);
    return isNaN(t) ? null : t;
  }
  /* 时间戳 → YYYY-MM-DDTHH:MM（<input type="datetime-local"> 回显用，保留投递时刻） */
  function toDateTimeLocal(ts) {
    if (!ts) return '';
    var d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  /* YYYY-MM-DDTHH:MM → 时间戳 */
  function fromDateTimeLocal(v) {
    if (!v) return null;
    var t = Date.parse(v);
    return isNaN(t) ? null : t;
  }

  /* 缺省补全：保证任何来源（空 / 旧数据 / 外部）进来的对象都有完整字段 */
  function normalizeCompany(c) {
    c = c || {};
    return {
      id: c.id || genId(),
      name: (c.name || '').trim(),
      industry: (c.industry || '').trim(),
      scale: (c.scale || '').trim(),
      location: (c.location || '').trim(),
      website: (c.website || '').trim(),
      applied: !!c.applied,
      note: (c.note || '').trim(),
      research: Array.isArray(c.research) ? c.research.map(function (r) {
        return {
          id: r.id || genRid(),
          platform: r.platform || PLATFORMS[0],
          dim: (r.dim && DIMS.indexOf(r.dim) >= 0) ? r.dim : '其他',
          content: (r.content || '').trim(),
          date: r.date || '',
          url: (r.url || '').trim()
        };
      }) : [],
      createdAt: c.createdAt ? Number(c.createdAt) : Date.now(),
      updatedAt: c.updatedAt ? Number(c.updatedAt) : Date.now(),
      jds: Array.isArray(c.jds) ? c.jds.map(normalizeJd) : []
    };
  }

  /* 单条投递岗位 JD 规整（仿 BOSS 直聘岗位卡的结构化字段） */
  function normalizeJd(j) {
    j = j || {};
    function toArr(x) {
      if (Array.isArray(x)) return x.map(function (s) { return String(s == null ? '' : s).trim(); }).filter(Boolean);
      if (typeof x === 'string') return x.split(/[\n,，、]/).map(function (s) { return s.trim(); }).filter(Boolean);
      return [];
    }
    return {
      id: j.id || genJid(),
      title: (j.title || '').trim(),
      salary: (j.salary || '').trim(),
      city: (j.city || '').trim(),
      experience: (j.experience || '').trim(),
      education: (j.education || '').trim(),
      recruiter: (j.recruiter || '').trim(),
      source: (j.source || '').trim(),
      appliedAt: (function () {
        if (j.appliedAt === null || j.appliedAt === undefined || j.appliedAt === '') return null;
        var n = Number(j.appliedAt);
        return isNaN(n) ? null : n;
      })(),
      skills: toArr(j.skills),
      benefits: toArr(j.benefits),
      duties: toArr(j.duties),
      requirements: toArr(j.requirements),
      companyInfo: (j.companyInfo || '').trim(),
      url: (j.url || '').trim()
    };
  }

  /* 统计：公司总数 / 曾投递数 */
  function computeStats(list) {
    list = Array.isArray(list) ? list : [];
    var applied = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].applied) applied++;
    }
    return { total: list.length, applied: applied };
  }

  var CompanyStore = {
    PLATFORMS: PLATFORMS,
    DIMS: DIMS,
    DIM_ORDER: DIM_ORDER,
    loadAll: function () { return backend().load(); },
    saveAll: function (arr) { return backend().save(arr || []); },
    onDegrade: function (fn) { _degradeHandler = fn; },
    /* 纯函数（可单测） */
    genId: genId,
    genRid: genRid,
    genJid: genJid,
    fmtDate: fmtDate,
    toDateInput: toDateInput,
    fromDateInput: fromDateInput,
    toDateTimeLocal: toDateTimeLocal,
    fromDateTimeLocal: fromDateTimeLocal,
    normalizeCompany: normalizeCompany,
    normalizeJd: normalizeJd,
    computeStats: computeStats
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CompanyStore;
  global.ResumeCompanyStore = CompanyStore;
})(typeof window !== 'undefined' ? window : this);
