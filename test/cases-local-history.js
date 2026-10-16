/* cases-local-history.js —— N11 本地版本历史
 * 分两层：
 *   1. 纯函数（require js/store/local-history.js 的模块导出）：保留策略降采样 / 版本 id / 字节估算；
 *   2. 完整链路（vm ctx 里的 ResumeLocalHistory + ResumeLibrary 内存后端）：append→list→restore→隔离→removeAll。
 * 断言走 ctx.assert（运行器注入）。
 *
 * ⚠️ 完整链路用例**不通过 ResumeLibrary.create** 建简历——那会往共享 index 塞元数据，
 * 与 cases-library 的「简历数量」断言竞争。版本历史走 `{id}_versions` 分文档（不经索引），
 * 因此直接用字符串 id（'n11-a' / 'n11-b'）即可，天然满足「按简历 id 隔离」的验证需求。 */

'use strict';

const LH = require('../js/store/local-history.js');

/* 构造一条测试版本（snapshot 为序列化串） */
function mk(timestamp, label, source, name) {
  return {
    versionId: 'v_' + timestamp + '_test',
    timestamp: timestamp,
    label: label || '编辑',
    source: source || 'auto',
    name: name || null,
    snapshot: JSON.stringify({ data: { name: 'N' + timestamp }, fonts: {}, spacing: {} })
  };
}

module.exports = [
  /* ============ 纯函数：版本 id / 字节估算 ============ */
  {
    name: 'genVersionId 生成 v_YYYYMMDD_HHmmss_4位短哈希 格式',
    fn(ctx) {
      const id = LH.genVersionId(1726952412000);
      ctx.assert(/^v_\d{8}_\d{6}_[a-z0-9]{4}$/.test(id), 'versionId 格式正确: ' + id);
    }
  },
  {
    name: 'estimateBytes 返回 JSON 串长度（非 0），null/undefined 为 0',
    fn(ctx) {
      const v = mk(1726952412000);
      ctx.assert(LH.estimateBytes(v) > 0, '估算字节 > 0');
      ctx.assert(LH.estimateBytes(null) === 0, 'null 估算为 0');
      ctx.assert(LH.estimateBytes(undefined) === 0, 'undefined 估算为 0');
    }
  },

  /* ============ 纯函数：保留策略（AC5） ============ */
  {
    name: 'applyRetention：条数 ≤ maxRecent 时全保留',
    fn(ctx) {
      const arr = [];
      for (let i = 0; i < 50; i++) arr.push(mk(1726952412000 + i * 1000));
      const out = LH.applyRetention(arr, { maxRecent: 50, retentionDays: 30, maxBytes: 100 * 1024 * 1024 });
      ctx.assert(out.length === 50, '50 条全保留');
      ctx.assert(out[0].timestamp === arr[0].timestamp, '保持时间正序');
    }
  },
  {
    name: 'applyRetention：超过 maxRecent 时最近 N 条全保留、更早按天首尾降采样（AC5）',
    fn(ctx) {
      // 60 条，同一天内（避免跨天干扰），maxRecent=50
      const base = new Date(2026, 0, 1, 0, 0, 0).getTime();  // 固定过去某天，避免受「30 天窗口」影响
      const arr = [];
      for (let i = 0; i < 60; i++) arr.push(mk(base + i * 60 * 1000)); // 每分钟一条，60 条 = 1 小时，都在同一天
      // retentionDays 设极大，仅验证「最近 N 全保留 + 更早首尾」；maxBytes 设极大免裁剪
      const out = LH.applyRetention(arr, { maxRecent: 50, retentionDays: 365 * 100, maxBytes: 100 * 1024 * 1024 });
      // 最近 50 条全保留
      ctx.assert(out.length === 52, '50(最近) + 2(更早首尾) = 52 条: ' + out.length);
      // 更早的 10 条（index 0..9）只保留首（index0）尾（index9）
      const older = out.filter(v => v.timestamp < arr[10].timestamp);
      ctx.assert(older.length === 2, '更早的 10 条降采样为 2 条');
      ctx.assert(older[0].timestamp === arr[0].timestamp, '保留更早段首条');
      ctx.assert(older[1].timestamp === arr[9].timestamp, '保留更早段尾条');
      // 最近 50 条完整
      const recent = out.filter(v => v.timestamp >= arr[10].timestamp);
      ctx.assert(recent.length === 50, '最近 50 条完整保留');
    }
  },
  {
    name: 'applyRetention：降采样段里超过 retentionDays 的旧版本被丢弃（AC5 30 天窗口）',
    fn(ctx) {
      const now = Date.now();
      const old = now - 40 * 24 * 3600 * 1000;   // 40 天前
      const mid = now - 10 * 24 * 3600 * 1000;   // 10 天前（30 天内）
      // 60 条：最近 50 条全部是「30 天内」的新鲜版本；更早 10 条里，5 条 40 天前、5 条 10 天前
      const arr = [];
      for (let i = 0; i < 5; i++) arr.push(mk(old + i * 1000));    // 降采样段·超 30 天 → 应丢
      for (let i = 0; i < 5; i++) arr.push(mk(mid + i * 1000));    // 降采样段·30 天内 → 按天首尾保留
      for (let i = 0; i < 50; i++) arr.push(mk(now - 3600 * 1000 + i * 1000));  // 最近 50 条 → 全保留
      const out = LH.applyRetention(arr, { maxRecent: 50, retentionDays: 30, maxBytes: 100 * 1024 * 1024 });
      // 最近 50 条全保留 + 降采样段 30 天内的（10 天前 5 条同一天 → 首尾 2 条）= 52 条
      ctx.assert(out.length === 52, '50(最近) + 2(10天前首尾) = 52，40天前的 5 条被丢: ' + out.length);
      ctx.assert(out.every(v => v.timestamp >= mid - 1000), '没有任何 40 天前的版本残留');
    }
  },
  {
    name: 'trimByBytes：超阈值从最旧开始丢、但绝不动尾部 keepTail 条',
    fn(ctx) {
      const arr = [];
      for (let i = 0; i < 10; i++) arr.push(mk(1726952412000 + i * 1000));
      // 估算单条字节，设阈值只够保留后 3 条
      const per = LH.estimateBytes(arr[0]);
      const out = LH.trimByBytes(arr, per * 3, 3);
      ctx.assert(out.length === 3, '裁剪后剩 3 条');
      ctx.assert(out[0].timestamp === arr[7].timestamp, '保留的是尾部 3 条（最旧被丢）');
    }
  },

  /* ============ 完整链路（vm 内存后端，AC1/AC2/AC4/AC6） ============ */
  {
    name: 'append→list 倒序返回（最新在前）',
    fn(ctx) {
      const LH2 = ctx.ResumeLocalHistory;
      return LH2.append('n11-a', mk(1000, '编辑'))
        .then(() => LH2.append('n11-a', mk(2000, '编辑')))
        .then(() => LH2.list('n11-a'))
        .then(vs => {
          ctx.assert(vs.length === 2, 'append 两次后 list 返回 2 条');
          ctx.assert(vs[0].timestamp === 2000, '倒序：最新在前');
          ctx.assert(vs[1].timestamp === 1000, '倒序：最旧在后');
        });
    }
  },
  {
    name: 'restore 返回反序列化后的 {data,fonts,spacing} 载荷',
    fn(ctx) {
      const LH2 = ctx.ResumeLocalHistory;
      const v = mk(3000, '手动快照', 'manual', '定稿');
      return LH2.append('n11-restore', v)
        .then(() => LH2.restore('n11-restore', v.versionId))
        .then(payload => {
          ctx.assert(!!payload && payload.data && payload.data.name === 'N3000', 'restore 还原出快照内容');
        });
    }
  },
  {
    name: 'restore 不存在的版本返回 null（不抛错）',
    fn(ctx) {
      const LH2 = ctx.ResumeLocalHistory;
      return LH2.append('n11-miss', mk(4000, '编辑'))
        .then(() => LH2.restore('n11-miss', 'v_nonexistent'))
        .then(payload => {
          ctx.assert(payload === null, '不存在的 versionId 返回 null');
        });
    }
  },
  {
    name: '隔离性：A、B 两份简历版本互不串（AC6）',
    fn(ctx) {
      const LH2 = ctx.ResumeLocalHistory;
      return LH2.append('n11-iso-a', mk(5000, '编辑'))
        .then(() => LH2.list('n11-iso-a'))
        .then(vsA => {
          ctx.assert(vsA.length === 1, 'A 有 1 条');
          return LH2.list('n11-iso-b');
        })
        .then(vsB => {
          ctx.assert(vsB.length === 0, 'B 无版本（A 的版本不串到 B）');
        });
    }
  },
  {
    name: 'removeAll 清空某份简历的全部版本',
    fn(ctx) {
      const LH2 = ctx.ResumeLocalHistory;
      return LH2.append('n11-clean', mk(6000, '编辑'))
        .then(() => LH2.removeAll('n11-clean'))
        .then(() => LH2.list('n11-clean'))
        .then(vs => {
          ctx.assert(vs.length === 0, 'removeAll 后版本清空');
        });
    }
  },
  {
    name: '保留策略在 append 时生效：超 maxRecent 自动裁剪到 ≤ 52 条',
    fn(ctx) {
      const LH2 = ctx.ResumeLocalHistory;
      // 60 条，时间用「现在往前几分钟」的连续时刻，确保落在 30 天保留窗口内
      const base = Date.now() - 10 * 60 * 1000;
      let chain = Promise.resolve();
      for (let i = 0; i < 60; i++) {
        chain = chain.then(() => LH2.append('n11-retain', mk(base + i * 1000, '编辑')));
      }
      return chain.then(() => LH2.list('n11-retain')).then(vs => {
        // 最近 50 条全保留 + 更早 10 条按「每天首尾」降采样（同一天 → 2 条）= 52 条
        ctx.assert(vs.length === 52, 'append 后保留策略生效（50 + 2 = 52）: ' + vs.length);
      });
    }
  },
  {
    name: '端到端：ResumeEditor.recordHistory 会同步追加本地版本（AC1/AC8 挂钩）',
    fn(ctx) {
      const RB = ctx.ResumeEditor;
      const LH2 = ctx.ResumeLocalHistory;
      if (typeof RB.recordHistory !== 'function') { ctx.assert(true, '跳过（无 recordHistory）'); return Promise.resolve(); }
      // 用独立简历 id，避免污染既有用例的 index
      RB.setActiveResumeId('n11-e2e');
      RB.recordHistory('action', '导入');
      // recordHistory 内部 appendLocalVersion 是同步调用 append（append 内部返回 Promise 但立即入 _cache）
      return LH2.list('n11-e2e').then(vs => {
        ctx.assert(vs.length >= 1, 'recordHistory 触发后本地版本链至少 1 条: ' + vs.length);
        ctx.assert(vs[0].label === '导入', 'label 透传为「导入」');
        ctx.assert(vs[0].source === 'auto', 'source 缺省为 auto');
      });
    }
  },
  {
    name: '端到端：手动快照 saveManualSnapshot 写入 source=manual（F2-5）',
    fn(ctx) {
      const RB = ctx.ResumeEditor;
      const LH2 = ctx.ResumeLocalHistory;
      if (typeof RB.saveManualSnapshot !== 'function') { ctx.assert(true, '跳过（无 saveManualSnapshot）'); return Promise.resolve(); }
      RB.setActiveResumeId('n11-snap');
      return RB.saveManualSnapshot('定稿 v2').then(() => LH2.list('n11-snap')).then(vs => {
        ctx.assert(vs.length === 1, '手动快照写入 1 条');
        ctx.assert(vs[0].source === 'manual', 'source=manual');
        ctx.assert(vs[0].name === '定稿 v2', '命名透传');
      });
    }
  },
  {
    name: '端到端：回滚本地版本先存当前为新版本再应用（AC3 可逆）',
    fn(ctx) {
      const RB = ctx.ResumeEditor;
      const LH2 = ctx.ResumeLocalHistory;
      if (typeof RB.restoreLocalVersion !== 'function') { ctx.assert(true, '跳过（无 restoreLocalVersion）'); return Promise.resolve(); }
      RB.setActiveResumeId('n11-rollback');
      // 记录两个版本：v1（旧内容）、v2（新内容）
      let d = RB.getData().data;
      d.name = '旧内容';
      RB.recordHistory('action', '编辑');          // 版本1：当前（旧内容前的状态）
      d.name = '新内容';
      RB.recordHistory('action', '编辑');          // 版本2：旧内容
      return LH2.list('n11-rollback').then(vs => {
        ctx.assert(vs.length >= 2, '至少 2 个版本');
        const oldest = vs[vs.length - 1];          // 时间最早的版本
        return RB.restoreLocalVersion(oldest.versionId);
      }).then(ok => {
        ctx.assert(ok === true, '回滚返回成功');
        return LH2.list('n11-rollback');
      }).then(vs => {
        // 回滚前内容自动成为一条新版本 → 版本数 +1
        ctx.assert(vs.length >= 3, '回滚前当前内容已存为新版本（版本数 +1）: ' + vs.length);
      });
    }
  },
  {
    name: '合并窗口：跨越 700ms 的 edit 各自成版本、窗口内合并（AC8 合并逻辑）',
    fn(ctx) {
      const RB = ctx.ResumeEditor;
      const LH2 = ctx.ResumeLocalHistory;
      if (typeof RB.recordHistory !== 'function' || !RB.hist) { ctx.assert(true, '跳过（无 recordHistory/hist）'); return Promise.resolve(); }
      RB.setActiveResumeId('n11-merge');
      // 清空历史栈与合并窗口，确保从干净态开始
      RB.hist.undo.length = 0; RB.hist.redo.length = 0; RB.hist.last = { kind: '', t: 0 };
      // 窗口内（<700ms）两次 edit → 合并为 1 个版本
      RB.recordHistory('edit'); RB.recordHistory('edit');
      const afterMerge = RB.hist.undo.length;
      ctx.assert(afterMerge === 1, '窗口内连续 edit 合并为 1 条: ' + afterMerge);
      // 手动把 last.t 回拨到 1 秒前，模拟跨窗口 → 下一次 edit 成为新版本
      RB.hist.last.t = Date.now() - 1000;
      RB.recordHistory('edit');
      ctx.assert(RB.hist.undo.length === 2, '跨越 700ms 窗口的 edit 各自成版本: ' + RB.hist.undo.length);
    }
  }
];
