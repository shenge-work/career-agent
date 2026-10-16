/*
 * adapter-local.js —— 本地数据源适配器（M4）
 * -----------------------------------------------------------------------------
 * 把「本地 IndexedDB（ResumeLibrary）」包装成 DataSourceAdapter。
 * 本地是「锚点」数据源：永远可用、零门槛、离线兜底（设计文档 2.4 节）。
 *
 * 能力：list/read/write 全支持；versions true（N11 本地版本历史，接 ResumeLocalHistory）；
 *       export true（本地导出文件即手动导出场景）；无授权概念。
 * 依赖：window.ResumeLibrary（js/store/resume-library.js，须在本文件之前加载）；
 *       window.ResumeLocalHistory（js/store/local-history.js，须在本文件之前加载）。
 */
(function (global) {
  'use strict';

  var Lib = global.ResumeLibrary;
  if (!Lib || typeof Lib.list !== 'function') {
    return; // resume-library 未加载：不注册（保持零回归）
  }

  var LH = global.ResumeLocalHistory;   // 可选：未加载时版本能力退回 false（保守降级）

  /* 版本契约里 datasource.js 约定字段是 version_id / create_time / size，
     这里把本地版本（versionId/timestamp/label/snapshot）映射成该契约形态。 */
  function toContract(v) {
    return {
      version_id: v.versionId,
      create_time: Math.floor((Number(v.timestamp) || 0) / 1000),   // 契约用秒
      size: (v.snapshot ? String(v.snapshot).length : 0),
      _local: { label: v.label || '编辑', source: v.source || 'auto', name: v.name || null }
    };
  }

  global.ResumeDataSourceRegistry.register({
    id: 'local',
    displayName: '本地',
    capabilities: { list: true, read: true, write: true, versions: !!LH, export: true, oauth: 'none' },

    listDocuments: function () {
      return Lib.list().then(function (items) {
        return items.map(function (m) {
          return { docId: m.id, title: m.title, updatedAt: m.updatedAt, source: 'local' };
        });
      });
    },

    readDocument: function (docId) {
      return Lib.load(docId);
    },

    writeDocument: function (docId, payload) {
      return Lib.save(docId, payload).then(function () { return { docId: docId }; });
    },

    /* N11：列出本地版本（时间倒序，映射为 datasource 契约形态） */
    listVersions: function (docId) {
      if (!LH || typeof LH.list !== 'function') return Promise.resolve([]);
      return LH.list(docId).then(function (versions) {
        return versions.map(toContract);
      });
    },

    /* N11：回滚本地版本，返回 {data,fonts,spacing,v} 载荷对象 */
    restoreVersion: function (docId, versionId) {
      if (!LH || typeof LH.restore !== 'function') return Promise.reject(new Error('本地版本不可用'));
      return LH.restore(docId, versionId).then(function (payload) {
        if (!payload || !payload.data) throw new Error('版本不存在或已归档');
        return payload;
      });
    },

    loadConfig: function () { return Promise.resolve(null); },
    saveConfig: function () { return Promise.resolve({ configured: true }); }
  });
})(typeof window !== 'undefined' ? window : this);

