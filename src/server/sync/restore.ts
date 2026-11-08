import { getTableColumns } from 'drizzle-orm';
import {
  applications,
  companies,
  companyJds,
  interviewKb,
  interviewNotes,
  portfolios,
  resumes,
  tracker,
} from '../db/schema';

/**
 * 冲突恢复的列映射（0012）。
 *
 * 快照是 0011 的 ca_safe_row_json(to_jsonb(行))，键为**数据库列名**（snake_case），
 * 且敏感列已被剔除。恢复时只把这些键翻译回 drizzle 属性名，绝不把快照里的
 * hlc / device_id / deleted_at 写回去 —— 恢复是一次新的本地写，时钟必须由
 * BEFORE 守卫重新领号并写 change_log，否则云端会把它当成过期变更直接拒收。
 *
 * 只开放 8 张「有 (user_id,id) 复合主键、支持软删除」的可变实体表；
 * versions / application_events / settings / ai_configs 是流水或单例，
 * 没有可安全覆盖的行身份，交给人工处理（前端禁用恢复按钮）。
 */
export const RESTORABLE_TABLES = {
  resumes,
  companies,
  company_jds: companyJds,
  tracker,
  applications,
  portfolios,
  interview_notes: interviewNotes,
  interview_kb: interviewKb,
} as const;
export type RestorableEntity = keyof typeof RESTORABLE_TABLES;

export function restorableTable(entity: string): any | null {
  return Object.prototype.hasOwnProperty.call(RESTORABLE_TABLES, entity)
    ? (RESTORABLE_TABLES as Record<string, any>)[entity]
    : null;
}

/** 一律不回写：身份列、同步三元组、墙钟展示列、敏感列。 */
const SKIP_COLUMNS = new Set([
  'user_id',
  'id',
  'hlc',
  'device_id',
  'deleted_at',
  'created_at',
  'updated_at',
  'saved_at',
  'api_key',
  'password_hash',
  'token_hash',
  'ip',
  'user_agent',
]);

interface ColumnMeta {
  name: string;
  dataType: string;
  notNull: boolean;
  hasDefault: boolean;
}

function columnsOf(table: any): Array<[string, ColumnMeta]> {
  return Object.entries(getTableColumns(table)) as unknown as Array<[string, ColumnMeta]>;
}

/**
 * 快照 → 可写入的 drizzle 行。
 * 返回 null 表示快照不完整（缺少 NOT NULL 且无默认值的业务列），调用方应拒绝恢复
 * 而不是让 INSERT 半途抛错。deletedAt 一律置 null：恢复就是「把内容拿回来」，
 * 即使落败方原本是一条删除墓碑也复活成活跃行。
 */
export function buildRestoreRow(
  entity: string,
  snapshot: Record<string, unknown>,
  userId: string,
  entityId: string
): Record<string, unknown> | null {
  const table = restorableTable(entity);
  if (!table || !snapshot || typeof snapshot !== 'object') return null;

  const columns = columnsOf(table);
  const row: Record<string, unknown> = { id: entityId, userId, deletedAt: null };

  for (const [prop, col] of columns) {
    if (SKIP_COLUMNS.has(col.name)) continue;
    if (!Object.prototype.hasOwnProperty.call(snapshot, col.name)) continue;
    const value = snapshot[col.name];
    if (value === undefined) continue;
    // jsonb 里 timestamptz 是 ISO 字符串，drizzle 的 timestamp 列需要 Date。
    row[prop] =
      col.dataType === 'date' && value !== null
        ? (() => {
            const d = new Date(String(value));
            return Number.isNaN(d.getTime()) ? null : d;
          })()
        : value;
  }

  // 墙钟只服务 UI 排序：恢复是「刚刚发生的一次编辑」，不能让列表按旧时间倒退。
  const props = new Set(columns.map(([p]) => p));
  if (props.has('updatedAt')) row.updatedAt = new Date();
  if (props.has('savedAt')) row.savedAt = Date.now();

  // 缺任何必需业务列都视为快照损坏（正常快照是整行，不会走到这里）。
  for (const [prop, col] of columns) {
    if (col.notNull && !col.hasDefault && !Object.prototype.hasOwnProperty.call(row, prop)) {
      return null;
    }
  }
  return row;
}

/**
 * 当前行 → 与 0011 快照同构的 JSON（DB 列名键、Date→ISO、剔除敏感列）。
 * 恢复前用它给「即将被替换的当前版本」留底，于是恢复可以来回切换、永不丢改动。
 */
export function rowToSnapshotJson(entity: string, row: Record<string, unknown>): Record<string, unknown> {
  const table = restorableTable(entity);
  if (!table) return {};
  const out: Record<string, unknown> = {};
  const sensitive = new Set(['api_key', 'password_hash', 'token_hash', 'ip', 'user_agent']);
  for (const [prop, col] of columnsOf(table)) {
    // 身份列 / 墙钟列 / 同步三元组照常留底：恢复时会跳过，但人工查看快照需要完整上下文。
    // 只有敏感列必须剔除，与 ca_safe_row_json 保持一致。
    if (sensitive.has(col.name)) continue;
    const value = row[prop];
    out[col.name] = value instanceof Date ? value.toISOString() : (value ?? null);
  }
  return out;
}
