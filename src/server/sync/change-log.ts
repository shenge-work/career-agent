import { changeLog } from '../db/schema';

/**
 * 同步 outbox 的应用层记账口（附件模块走这里）。
 *
 * 两条写入路径，最终都落到同一张 change_log：
 *   1. 附件模块：本函数与业务行在**同一事务**里写，payload 带完整元数据；
 *   2. 其余业务表：0010 迁移的 AFTER INSERT/UPDATE/DELETE 触发器自动记账，
 *      与业务写天然同事务，对 61 个 TenantDb 方法零侵入，物理删除也会留下墓碑。
 *
 * 注意 hlc 会被 0010 的 ca_change_log_cursor 触发器统一改写为「严格单调的本地
 * 拉取游标」：本函数传入的 hlc 只是占位，避免同一毫秒多条写重复导致按游标漏记录。
 * 业务行自己的 hlc（attachments.hlc 等，应用层 HLC）才是跨设备冲突判定用的时钟。
 *
 * 这不是 pgDump / WAL 物理复制：PGlite 的 pgdata 是 WASM 数据目录，
 * 原生 PostgreSQL 打不开，云端同步必须走应用级逻辑增量。
 */
export interface ChangeInput {
  userId: string;
  entity: string;
  entityId: string;
  op: 'upsert' | 'delete';
  hlc: string;
  deviceId: string;
  payload?: Record<string, unknown>;
}

/** tx 可以是 drizzle db 或 transaction（两者 insert 签名一致）。 */
export async function recordChange(tx: any, input: ChangeInput): Promise<void> {
  await tx.insert(changeLog).values({
    userId: input.userId,
    entity: input.entity,
    entityId: input.entityId,
    op: input.op,
    hlc: input.hlc,
    deviceId: input.deviceId,
    payload: input.payload ?? {},
  });
}
