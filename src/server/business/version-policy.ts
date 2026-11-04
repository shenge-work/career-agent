/**
 * 版本历史保留策略（结合 PostgreSQL 的重新设计，取代 v1 飞书云盘版本 / N11 localStorage 版本）。
 *
 * 策略（对齐 Google Docs 的直觉，纯函数、可离线单测）：
 * 1. 手动命名快照（kind === 'manual'）**永不降采样** —— 它们是用户显式标记的节点；
 * 2. 其余（自动留痕 auto / 恢复前快照等）按时间倒序：
 *    - 最近 KEEP_RECENT 条全保留；
 *    - 再往前按自然日分组，每天保留首尾各 KEEP_PER_DAY 条；
 *    - 超过 MAX_AGE_DAYS 天的直接丢弃。
 * 3. 没有总量 5MB 限制 —— PG 行内 jsonb 不是 localStorage 配额，不做大小降采样。
 */

export const KEEP_RECENT = 50;
export const KEEP_PER_DAY = 2;
export const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export interface PolicyVersion {
  id: string;
  kind: string;
  createdAt: Date | string | number;
}

/** 输入任意时间表示，返回 UTC 毫秒。 */
function ms(v: Date | string | number): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : Date.parse(String(v)) || 0;
}

/** 取该时间的「自然日」键（本地时区，与 v1 语义一致）。 */
function dayKey(t: number): string {
  return new Date(t).toLocaleDateString('sv-SE');
}

/**
 * 给出「应保留」的版本 id 集合；不在集合内的是降采样对象。
 * manual 全保；auto 走 50 条 + 每天首尾 2 条 + 30 天窗口。
 */
export function selectVersionIdsToKeep(
  versions: PolicyVersion[],
  now = Date.now()
): Set<string> {
  const keep = new Set<string>();
  const auto = versions
    .filter((v) => v.kind !== 'manual')
    .sort((a, b) => ms(b.createdAt) - ms(a.createdAt)); // 新 → 旧

  // 手动快照永不丢
  for (const v of versions) {
    if (v.kind === 'manual') keep.add(v.id);
  }

  // 超龄直接丢
  const inWindow = auto.filter((v) => now - ms(v.createdAt) <= MAX_AGE_MS);

  // 最近 N 条全保留
  const recent = inWindow.slice(0, KEEP_RECENT);
  for (const v of recent) keep.add(v.id);

  // 更早的：按自然日分组，每天保留首尾各 1 条（组内已按新→旧排序，首=最新、尾=最旧）
  const older = inWindow.slice(KEEP_RECENT);
  const byDay = new Map<string, PolicyVersion[]>();
  for (const v of older) {
    const k = dayKey(ms(v.createdAt));
    const arr = byDay.get(k) || [];
    arr.push(v);
    byDay.set(k, arr);
  }
  for (const arr of byDay.values()) {
    keep.add(arr[0].id);
    if (arr.length > 1) keep.add(arr[arr.length - 1].id);
  }
  return keep;
}
