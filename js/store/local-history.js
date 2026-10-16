/* =============================================================
 * local-history.js —— 本地版本历史（N11）
 * -------------------------------------------------------------
 * 把「撤销栈（会话级内存）」升级为「本地持久化、可跨会话、可回溯」的版本链，
 * 不依赖任何云端。核心思路（对齐需求文档 N11）：
 *
 *   - 版本链是 undo 栈的「持久化超集」：recordHistory 每次 undo 快照入栈时，
 *     同时把同款快照（{data,fonts,spacing} 序列化串）追加到版本链，并附加
 *     versionId / timestamp / label / source。回滚一个版本 = restoreSnapshot，
 *     与既有 undo 机制完全同构。
 *   - 存储跟随主存储后端：复用 ResumeLibrary 的 saveDoc / loadDoc 通道，
 *     为每份简历维护一个 `{id}_versions` 分文档（不经索引、不污染简历列表）。
 *   - 保留策略（分级）：最近 N 条全保留；更早的按「每天首尾 2 条」降采样、
 *     最长 30 天；磁盘占用超阈值时从最旧降采样点开始丢弃（绝不动最近 N 条）。
 *   - 任何持久化错误都被吞掉，绝不打断编辑（对齐「写盘失败静默降级」铁律）。
 *
 * 依赖：window.ResumeLibrary（js/store/resume-library.js，须在本文件之前加载）。
 * 双环境：浏览器 IIFE 挂 window.ResumeLocalHistory；Node 里 module.exports 导出
 *         纯函数（applyRetention / genVersionId / estimateBytes）供测试 require。
 * ============================================================= */
(function (global) {
  'use strict';

  /* ============ 保留策略纯函数（不依赖 DOM / ResumeLibrary，可直接单测） ============ */

  var DEFAULT_CONFIG = {
    maxRecent: 50,                       // 最近 N 条全保留
    retentionDays: 30,                   // 降采样最长保留天数
    maxBytes: 5 * 1024 * 1024            // 单份简历版本历史磁盘阈值
  };

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* 估算单条版本的字节占用（JSON 串长度近似，够用于阈值判定） */
  function estimateBytes(version) {
    if (version == null) return 0;
    try { return JSON.stringify(version).length; } catch (e) { return 0; }
  }

  /* 生成全局唯一 versionId：v_<yyyyMMdd>_<HHmmss>_<4 位短哈希> */
  function genVersionId(ts) {
    var t = ts || Date.now();
    var d = new Date(t);
    var base = 'v_' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      '_' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    var rnd = Math.random().toString(36).slice(2, 6);
    return base + '_' + rnd;
  }

  /* 按天把版本分桶（降采样用）：返回 { 'YYYY-MM-DD': [version,...] }（同天内时间正序） */
  function bucketByDay(versions) {
    var buckets = {};
    (versions || []).forEach(function (v) {
      var ts = Number(v && v.timestamp) || 0;
      var d = new Date(ts);
      var key = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      (buckets[key] = buckets[key] || []).push(v);
    });
    Object.keys(buckets).forEach(function (k) {
      buckets[k].sort(function (a, b) { return (a.timestamp || 0) - (b.timestamp || 0); });
    });
    return buckets;
  }

  /* 磁盘阈值裁剪：从最旧开始丢弃，但绝不丢弃最后 keepTail 条（即最近 N 条）。
     返回裁剪后的数组（保持传入顺序）。 */
  function trimByBytes(versions, maxBytes, keepTail) {
    if (!Array.isArray(versions) || versions.length === 0) return versions;
    var budget = Number(maxBytes) || 0;
    var tail = Number(keepTail) || 0;
    var protectedCount = Math.min(tail, versions.length);
    var protectedArr = versions.slice(versions.length - protectedCount);
    var mutable = versions.slice(0, versions.length - protectedCount);
    // 总占用从最旧开始累计丢弃
    var total = 0;
    for (var i = 0; i < versions.length; i++) total += estimateBytes(versions[i]);
    while (mutable.length > 0 && total > budget) {
      total -= estimateBytes(mutable[0]);
      mutable.shift();
    }
    return mutable.concat(protectedArr);
  }

  /* 核心保留策略（纯函数）：输入时间正序的版本数组，输出裁剪后的数组（仍时间正序）。
     规则：≤ maxRecent 全保留；否则「最近 maxRecent 条」全保留，更早的按「每天首尾 2 条」
     降采样、且只保留 retentionDays 内的；最后按 maxBytes 从最旧降采样点丢弃。 */
  function applyRetention(versions, cfg) {
    cfg = cfg || {};
    var maxRecent = (cfg.maxRecent != null) ? cfg.maxRecent : DEFAULT_CONFIG.maxRecent;
    var retentionDays = (cfg.retentionDays != null) ? cfg.retentionDays : DEFAULT_CONFIG.retentionDays;
    var maxBytes = (cfg.maxBytes != null) ? cfg.maxBytes : DEFAULT_CONFIG.maxBytes;

    if (!Array.isArray(versions)) return [];
    // 时间正序 + 剔除无 timestamp 的脏数据
    var arr = versions.filter(function (v) { return v && (Number(v.timestamp) || 0) > 0; })
                       .sort(function (a, b) { return (a.timestamp || 0) - (b.timestamp || 0); });

    if (arr.length <= maxRecent) {
      return trimByBytes(arr, maxBytes, arr.length);   // 未超条数，仅按字节兜底
    }

    var recent = arr.slice(arr.length - maxRecent);            // 最近 N 条（全保留）
    var older = arr.slice(0, arr.length - maxRecent);          // 更早的（降采样）
    var cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;

    // 降采样：超期丢弃；同一天只留首尾
    var sampled = [];
    var buckets = bucketByDay(older);
    Object.keys(buckets).sort().forEach(function (key) {
      var list = buckets[key];
      // 用该天最后一条的 timestamp 判断是否在保留窗口内（首条可能跨天边界）
      if (list.length && (list[list.length - 1].timestamp || 0) < cutoff) return;
      if (list.length <= 2) { sampled = sampled.concat(list); }
      else { sampled.push(list[0], list[list.length - 1]); }
    });

    var result = sampled.concat(recent);
    // 磁盘阈值：从最旧降采样点丢弃，但绝不动最近 maxRecent 条
    return trimByBytes(result, maxBytes, maxRecent);
  }

  /* ============ 存储：复用 ResumeLibrary 的 saveDoc/loadDoc 通道 ============ */

  var Lib = function () { return global.ResumeLibrary; };

  function docIdOf(resumeId) { return resumeId + '_versions'; }

  // 内存缓存：resumeId -> 版本数组（时间正序）；_dirty 标记待写盘；_timers 防抖
  var _cache = {};
  var _dirty = {};
  var _timers = {};
  var FLUSH_DEBOUNCE_MS = 400;

  function readRaw(resumeId) {
    var L = Lib();
    if (!L) return Promise.resolve(null);
    try {
      if (typeof L.loadDocRaw === 'function') return Promise.resolve(L.loadDocRaw(docIdOf(resumeId)));
      if (typeof L.load === 'function') return Promise.resolve(L.load(docIdOf(resumeId)));
    } catch (e) { return Promise.resolve(null); }
    return Promise.resolve(null);
  }
  function writeRaw(resumeId, doc) {
    var L = Lib();
    if (!L) return Promise.resolve(null);
    try {
      if (typeof L.saveDocRaw === 'function') return Promise.resolve(L.saveDocRaw(docIdOf(resumeId), doc));
      if (typeof L.save === 'function') return Promise.resolve(L.save(docIdOf(resumeId), doc));
    } catch (e) { return Promise.resolve(null); }
    return Promise.resolve(null);
  }

  /* 载入某份简历的版本数组（优先内存缓存；进行中的加载去重，避免 append 与 list 竞态） */
  var _loads = {};   // resumeId -> 进行中的加载 Promise
  function load(resumeId) {
    if (_cache[resumeId]) return Promise.resolve(_cache[resumeId]);
    if (_loads[resumeId]) return _loads[resumeId];   // 复用进行中的加载，保证 push/read 同序
    _loads[resumeId] = readRaw(resumeId).then(function (doc) {
      var versions = (doc && Array.isArray(doc.versions)) ? doc.versions : [];
      _cache[resumeId] = versions;
      delete _loads[resumeId];
      return versions;
    }).catch(function () {
      _cache[resumeId] = [];
      delete _loads[resumeId];
      return _cache[resumeId];
    });
    return _loads[resumeId];
  }

  /* 写盘（防抖）：同一份简历 400ms 内的多次追加合并成一次写盘 */
  function schedulePersist(resumeId) {
    if (_timers[resumeId]) clearTimeout(_timers[resumeId]);
    _timers[resumeId] = setTimeout(function () {
      _timers[resumeId] = null;
      flush(resumeId);
    }, FLUSH_DEBOUNCE_MS);
  }

  function flush(resumeId) {
    if (!_dirty[resumeId]) return Promise.resolve();
    _dirty[resumeId] = false;
    var versions = _cache[resumeId] || [];
    var doc = { docId: resumeId, versions: versions };
    return writeRaw(resumeId, doc).catch(function () { /* 静默降级：绝不打断编辑 */ });
  }

  function removeAll(resumeId) {
    if (_timers[resumeId]) { clearTimeout(_timers[resumeId]); _timers[resumeId] = null; }
    delete _cache[resumeId]; delete _dirty[resumeId];
    var L = Lib();
    if (!L) return Promise.resolve();
    try {
      if (typeof L.removeDocRaw === 'function') return Promise.resolve(L.removeDocRaw(docIdOf(resumeId)));
      if (typeof L.remove === 'function') return Promise.resolve(L.remove(docIdOf(resumeId)));
    } catch (e) { return Promise.resolve(); }
    return Promise.resolve();
  }

  /* ============ 公开门面 ResumeLocalHistory ============ */
  var ResumeLocalHistory = {
    config: DEFAULT_CONFIG,

    /* 追加一条版本记录（自动跑保留策略）。version = {versionId,timestamp,label,source,name,snapshot}
       snapshot 是已序列化的字符串（由 app.js 的 snapshot() 生成）。返回 Promise<裁剪后的版本数组>。 */
    append: function (resumeId, version) {
      if (!resumeId || !version || version.snapshot == null) return Promise.resolve([]);
      return load(resumeId).then(function (versions) {
        versions.push(version);
        var kept = applyRetention(versions, DEFAULT_CONFIG);
        _cache[resumeId] = kept;
        _dirty[resumeId] = true;
        schedulePersist(resumeId);
        return kept;
      }).catch(function () { return []; });
    },

    /* 列出某份简历的版本（时间倒序，最新的在前）。返回 Promise<versions> */
    list: function (resumeId) {
      return load(resumeId).then(function (versions) {
        return versions.slice().sort(function (a, b) { return (b.timestamp || 0) - (a.timestamp || 0); });
      });
    },

    /* 取某份简历的单个版本（含完整 snapshot 字符串） */
    get: function (resumeId, versionId) {
      return load(resumeId).then(function (versions) {
        for (var i = 0; i < versions.length; i++) {
          if (versions[i].versionId === versionId) return versions[i];
        }
        return null;
      });
    },

    /* 回滚到某版本：返回反序列化后的 {data,fonts,spacing} 载荷对象（供 app.js restoreSnapshot 用） */
    restore: function (resumeId, versionId) {
      return load(resumeId).then(function (versions) {
        for (var i = 0; i < versions.length; i++) {
          if (versions[i].versionId === versionId) {
            try { return JSON.parse(versions[i].snapshot); } catch (e) { return null; }
          }
        }
        return null;
      });
    },

    /* 删除某份简历的全部版本历史（删除简历时调用） */
    removeAll: removeAll,

    /* 立即写盘（切换简历 / 关闭前等场景，返回 Promise） */
    flush: flush,

    /* 写盘是否已排程（测试用） */
    _hasPending: function (resumeId) { return !!_timers[resumeId]; },

    /* 测试/调试：清内存缓存 */
    _reset: function () { _cache = {}; _dirty = {}; _timers = {}; _loads = {}; },

    /* 纯函数导出（供测试直接断言降采样 / 裁剪） */
    applyRetention: applyRetention,
    genVersionId: genVersionId,
    estimateBytes: estimateBytes,
    bucketByDay: bucketByDay,
    trimByBytes: trimByBytes
  };

  global.ResumeLocalHistory = ResumeLocalHistory;
  if (typeof module !== 'undefined' && module.exports) module.exports = ResumeLocalHistory;
})(typeof window !== 'undefined' ? window : this);
