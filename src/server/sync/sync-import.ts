import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import {
  applications,
  companies,
  companyJds,
  interviewKb,
  interviewNotes,
  portfolios,
  practiceAnswers,
  practiceEvaluations,
  practiceQuestions,
  practiceSessions,
  practiceWeaknesses,
  referrals,
  resumes,
  tracker,
} from '../db/schema';

/**
 * Sync Engine 回灌入口（0011 冲突地基的应用层门面）。
 *
 * 云端变更落回本地时**必须**打开 `app.sync_import`，原因有三：
 *   1. BEFORE 守卫会保留远端 hlc / device_id（本地写则强制领本地时钟），
 *      并 observe 远端时钟，保证后续本地写一定排在所有已见远端写之后；
 *   2. 跨设备并发写按 HLC 做 LWW，落败方整行进 conflict_snapshots，绝不静默丢改动；
 *   3. change_log 的写入被吞掉，避免「云端推来 → 本地又推回云端」的回环。
 *
 * 本地永远可用：这个开关只在回灌的极短窗口内打开，try/finally 保证复位，
 * 断网或云端不可用时所有常规读写完全不经过这里。
 *
 * 注意：这不是完整的 Sync Engine（全量首传、断点续传、账号授权、加密都还没做），
 * 只是把「远端一行变更如何安全落进本地」这条最难的路径先固化并可测试。
 */

/** 14 张可变实体表；流水/快照/单例配置表有各自的写入路径，不走远端 upsert。 */
export const SYNC_TABLES = {
  resumes,
  companies,
  companyJds,
  referrals,
  tracker,
  applications,
  portfolios,
  interviewNotes,
  interviewKb,
  // 键名必须与 change_log.entity（= 数据库表名）一致，applyRemoteUpsert 才能查表。
  practice_sessions: practiceSessions,
  practice_questions: practiceQuestions,
  practice_answers: practiceAnswers,
  practice_evaluations: practiceEvaluations,
  practice_weaknesses: practiceWeaknesses,
} as const;
export type SyncEntity = keyof typeof SYNC_TABLES;

export interface RemoteRowSpec {
  entity: SyncEntity;
  /**
   * drizzle 属性名（camelCase）。必须含 id / userId / hlc / deviceId，
   * 以及该表所有 NOT NULL 且无默认值的列（如 resumes.payload、companies.name）。
   * 远端 delete 事件传 deletedAt: new Date(ts)，同样参与 LWW。
   */
  row: Record<string, unknown>;
}

/** 会话级 GUC；值不含用户输入，用 sql.raw 是安全的。 */
export async function setSyncImportMode(db: Database, on: boolean): Promise<void> {
  await db.execute(sql.raw(on ? "SET app.sync_import = 'on'" : 'RESET app.sync_import'));
}

/** 批量回灌时把多行列在同一个窗口里，减少 GUC 切换。 */
export async function withSyncImport<T>(db: Database, fn: () => Promise<T>): Promise<T> {
  await setSyncImportMode(db, true);
  try {
    return await fn();
  } finally {
    await setSyncImportMode(db, false);
  }
}

function assertRow(row: Record<string, unknown>): void {
  for (const key of ['id', 'userId', 'hlc', 'deviceId']) {
    if (!row[key]) throw new Error(`回灌行缺少 ${key}：远端必须自带业务 HLC 与设备标识`);
  }
}

/**
 * 回灌一行：ON CONFLICT DO UPDATE 触发 0011 的 BEFORE UPDATE 守卫做 LWW。
 * 返回 applied=false 表示远端落败（INSERT 被 RETURN NULL 取消，行保持本地版本），
 * 此时 conflict_snapshots 里已有远端整行留底，可人工恢复。
 */
export async function applyRemoteUpsert(db: Database, spec: RemoteRowSpec): Promise<{ applied: boolean }> {
  return withSyncImport(db, async () => {
    const table: any = SYNC_TABLES[spec.entity];
    if (!table) throw new Error(`不支持回灌的实体: ${spec.entity}`);
    assertRow(spec.row);
    // 远端 upsert 默认复活（清掉本地墓碑）；远端 delete 事件显式传 deletedAt 覆盖此默认值。
    const row = { deletedAt: null, ...spec.row };
    const rows = await db
      .insert(table)
      .values(row as any)
      .onConflictDoUpdate({ target: [table.userId, table.id], set: row as any })
      .returning({ id: table.id });
    return { applied: rows.length > 0 };
  });
}

/** 批量版本：整批共用一个回灌窗口。 */
export async function applyRemoteUpserts(
  db: Database,
  specs: RemoteRowSpec[]
): Promise<{ applied: number; rejected: number }> {
  return withSyncImport(db, async () => {
    let applied = 0;
    let rejected = 0;
    for (const spec of specs) {
      const table: any = SYNC_TABLES[spec.entity];
      if (!table) throw new Error(`不支持回灌的实体: ${spec.entity}`);
      assertRow(spec.row);
      const row = { deletedAt: null, ...spec.row };
      const rows = await db
        .insert(table)
        .values(row as any)
        .onConflictDoUpdate({ target: [table.userId, table.id], set: row as any })
        .returning({ id: table.id });
      if (rows.length) applied += 1;
      else rejected += 1;
    }
    return { applied, rejected };
  });
}
