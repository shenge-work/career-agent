/*
 * ResumeStore —— 统一数据门面（P0 跨平台改造第一步）
 * -----------------------------------------------------------------------------
 * 零依赖纯 JS，可直接被浏览器 <script> 加载（不引入任何 npm 包）。
 * 挂在 window.ResumeStore 上，UI 通过它读写数据，不关心数据到底存在哪：
 *   - 本地持久化：LocalStore —— 统一「分文件」模型下的 default 文档
 *       · 原生壳（Tauri）：invoke('resume_doc_load/save') → <app_data_dir>/resumes/default.json
 *       · 浏览器开发模式（npm start）：fetch /api/library/doc?id=default → data/resumes/default.json
 *       · 均不可用：内存降级（仅当前会话）
 *   - 远端同步：FeishuStore（飞书双写 + 版本历史；纯浏览器模式优雅降级）
 *
 * 设计要点：
 *   - 已移除浏览器持久化（IndexedDB / localStorage 简历数据）——打包安装包后没有浏览器
 *     环境，数据统一落本地文件系统；localStorage 仅保留 UI 偏好（见 app.js）。
 *   - 多份简历由 ResumeLibrary 管理（index.json + <id>.json，与飞书 file_token_<id> 同构）；
 *     本文件只负责「单份 default 文档」的兼容门面。
 *   - 任何持久化错误都在 store 内部被吞掉（save 返回已吞错的 Promise），绝不让异常冒泡到 UI。
 */
(function (global) {
  'use strict';

  /* 原生桥：若存在 window.__RESUME_NATIVE__ 且含对应方法，则委托；否则浏览器模式不可用 */
  var NATIVE = (global.__RESUME_NATIVE__ && typeof global.__RESUME_NATIVE__ === 'object') ? global.__RESUME_NATIVE__ : null;

  var memDefault = null; // 无任何后端时的内存降级

  /* ============ LocalStore（单份 default 文档，统一分文件模型） ============ */
  /* 与 ResumeLibrary 同一套「文档 = resumeId」概念，default 是未接入多份时的固定文档 id。 */
  var LocalStore = {
    get: function () {
      if (NATIVE && typeof NATIVE.resumeDocLoad === 'function') {
        return Promise.resolve(NATIVE.resumeDocLoad('default'));
      }
      if (typeof fetch === 'function') {
        return fetch('/api/library/doc?id=default', { cache: 'no-store' })
          .then(function (r) { return r.json().then(function (j) { return (j && j.doc) || null; }); })
          .catch(function () { return memDefault; });
      }
      return Promise.resolve(memDefault);
    },
    set: function (payload) {
      memDefault = payload;
      if (NATIVE && typeof NATIVE.resumeDocSave === 'function') {
        return Promise.resolve(NATIVE.resumeDocSave('default', payload)).catch(function () { /* 静默 */ });
      }
      if (typeof fetch === 'function') {
        return fetch('/api/library/doc?id=default', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true
        }).catch(function () { /* 服务不可写：静默，依赖内存 */ });
      }
      return Promise.resolve();
    }
  };

  /* ============ FeishuStore ============ */
  var FEISHU_UNAVAILABLE_MSG = '飞书同步需在安装包（原生壳）中启用；当前浏览器模式仅本地保存';
  // 原生桥：若存在 window.__RESUME_NATIVE__ 且含对应方法，则委托；否则浏览器模式不可用
  // （native-bridge.js 加载后会做迟绑定重定向，见该文件 rebindFacade）

  /* 浏览器模式 HTTP 后端：直连本地 serve.js 的 /api/sync*（凭证仍在服务端，不进浏览器）。
     仅当「无原生壳 + 有 fetch」时启用；file:// 或静态服务器下 fetch 失败则走下面的 reject 分支。 */
  function httpJson(method, path, body) {
    return fetch(path, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j && j.error ? j.error : ('HTTP ' + r.status));
        return j;
      });
    });
  }
  /* 版本列表 / 恢复 / 拉取均按「简历 id」定位远端文件；缺省 'default'（兼容单份简历）。
     resumeId 来自 ResumeLibrary 的简历 id，经 reportToFeishu 的 payload.id 写入
     sync.state.json 的 file_token_<id> 键，两边必须一致才能读到同一份数据。 */
  function syncQS(resumeId) {
    return resumeId ? ('?resumeId=' + encodeURIComponent(resumeId)) : '';
  }

  var FeishuStore = {
    available: !!NATIVE,  // 纯浏览器无原生壳 → false
    push: function (payload) {
      if (NATIVE && typeof NATIVE.feishuPush === 'function') return Promise.resolve(NATIVE.feishuPush(payload));
      if (typeof fetch === 'function') {
        return httpJson('POST', '/api/sync', payload).then(function (j) {
          return { ok: true, docUrl: j.docUrl, fileUrl: j.fileUrl, size: j.size, dryRun: !!j.dryRun, authMode: j.authMode };
        });
      }
      return Promise.reject(new Error(FEISHU_UNAVAILABLE_MSG));
    },
    pull: function (resumeId) {
      if (NATIVE && typeof NATIVE.feishuPull === 'function') return Promise.resolve(NATIVE.feishuPull(resumeId));
      if (typeof fetch === 'function') {
        // 浏览器 HTTP 后端：等价「取该简历最新版本并恢复」
        return httpJson('GET', '/api/sync/versions' + syncQS(resumeId)).then(function (j) {
          var vs = j.versions || [];
          if (!vs.length) throw new Error('飞书中还没有可用版本，请先「上报到飞书」');
          return httpJson('POST', '/api/sync/restore', { versionId: vs[0].version_id, resumeId: resumeId }).then(function (r) {
            try { return JSON.parse(r.json); } catch (e) { return r.json; }
          });
        });
      }
      return Promise.reject(new Error(FEISHU_UNAVAILABLE_MSG));
    },
    listVersions: function (resumeId) {
      if (NATIVE && typeof NATIVE.feishuListVersions === 'function') return Promise.resolve(NATIVE.feishuListVersions(resumeId));
      if (typeof fetch === 'function') {
        return httpJson('GET', '/api/sync/versions' + syncQS(resumeId)).then(function (j) { return j.versions || []; });
      }
      return Promise.reject(new Error(FEISHU_UNAVAILABLE_MSG));
    },
    restore: function (versionId, resumeId) {
      if (NATIVE && typeof NATIVE.feishuRestore === 'function') return Promise.resolve(NATIVE.feishuRestore(versionId, resumeId));
      if (typeof fetch === 'function') {
        return httpJson('POST', '/api/sync/restore', { versionId: versionId, resumeId: resumeId }).then(function (r) {
          try { return JSON.parse(r.json); } catch (e) { return r.json; }
        });
      }
      return Promise.reject(new Error(FEISHU_UNAVAILABLE_MSG));
    },
    loadConfig: function () {
      // 浏览器模式：优先直连本地服务读取；无服务（file:// 等）返回 null
      if (NATIVE && typeof NATIVE.feishuLoadConfig === 'function') return Promise.resolve(NATIVE.feishuLoadConfig());
      if (typeof fetch === 'function') {
        return httpJson('GET', '/api/sync/config').then(function (j) { return j.config || null; }).catch(function () { return null; });
      }
      return Promise.resolve(null);
    },
    saveConfig: function (cfg) {
      if (NATIVE && typeof NATIVE.feishuSaveConfig === 'function') return Promise.resolve(NATIVE.feishuSaveConfig(cfg));
      if (typeof fetch === 'function') {
        return httpJson('POST', '/api/sync/config', cfg).then(function (j) { return { configured: !!j.configured }; });
      }
      return Promise.reject(new Error(FEISHU_UNAVAILABLE_MSG));
    },
    probe: function (req) {
      if (NATIVE && typeof NATIVE.feishuProbe === 'function') return Promise.resolve(NATIVE.feishuProbe(req));
      if (typeof fetch === 'function') {
        return httpJson('POST', '/api/sync/probe', req);
      }
      return Promise.reject(new Error(FEISHU_UNAVAILABLE_MSG));
    }
  };

  /* ============ 公开门面 ResumeStore ============ */
  var ResumeStore = {
    /* 读取本地 default 文档 {data,fonts,spacing,v}，无则返回 null */
    load: function () {
      return LocalStore.get();
    },
    /* 写入本地 default 文档（防抖由调用方做）。失败被吞掉，绝不让异常冒泡到 UI。 */
    save: function (payload) {
      return LocalStore.set(payload).catch(function () { /* 静默兜底 */ });
    },
    /* 从飞书拉最新（可用时）；resumeId 缺省 'default'；浏览器模式抛出友好 Error */
    pull: function (resumeId) {
      return FeishuStore.pull(resumeId);
    },
    /* 推到飞书（可用时），返回 {ok,docUrl,dryRun}；不可用抛友好 Error */
    push: function (payload) {
      return FeishuStore.push(payload);
    },
    /* 返回某份简历的飞书版本数组；不可用抛友好 Error */
    listVersions: function (resumeId) {
      return FeishuStore.listVersions(resumeId);
    },
    /* 返回该版本的 {data,fonts,spacing} 载荷对象；不可用抛友好 Error */
    restore: function (versionId, resumeId) {
      return FeishuStore.restore(versionId, resumeId);
    },
    /* 返回飞书配置对象或 null */
    loadConfig: function () {
      return FeishuStore.loadConfig();
    },
    /* 保存飞书配置，返回 {configured:boolean} */
    saveConfig: function (cfg) {
      return FeishuStore.saveConfig(cfg);
    },
    /* 一键绑定探测：验证凭证 + 自动建文件夹，返回默认项 */
    probe: function (req) {
      return FeishuStore.probe(req);
    }
  };

  // 暴露调试/测试用后端引用（不强制使用）
  ResumeStore._stores = { LocalStore: LocalStore, BrowserStore: LocalStore, FeishuStore: FeishuStore };

  global.ResumeStore = ResumeStore;
})(typeof window !== 'undefined' ? window : this);
