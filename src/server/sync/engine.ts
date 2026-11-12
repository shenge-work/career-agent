import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import {
  applications,
  attachments,
  changeLog,
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
  syncState,
  tracker,
} from '../db/schema';
import type { BlobStore } from '../storage/blob-store';
import {
  blobObjectKey,
  openBlob,
  openEvent,
  sealBlob,
  sealEvent,
  type VaultKeys,
} from './crypto';
import { applyRemoteUpsert, withSyncImport } from './sync-import';
import {
  INITIAL_SEQ,
  type SyncEvent,
  type SyncEnvelope,
  type SyncTransport,
} from './transport';

/**
 * Sync Engine：本地 outbox ↔ 哑云 的事件搬运工。
 *
 * 一次 syncOnce = pull → push → GC，三个阶段各自独立推进游标，中断可续：
 *   · pull  —— 按云端 seq 拉增量，openEvent 解密后走 applyRemoteUpsert 回灌
 *              （withSyncImport 窗口内保留远端 hlc、吞掉 change_log 防回环）；
 *   · push  —— pushedCursor 为空 = 首次：把 15 张同步表的当前活跃行做基线全量首传；
 *              否则读 change_log 增量，按 entity/entityId 读完整行快照再封包上云；
 *   · GC    —— 本地 blob 按引用集清理；云端 blob 按 knownBlobs 比对引用集删除。
 *
 * 三序号铁律（与 transport.ts 的注释一致，别写歪）：
 *   change_log.hlc = 本地拉取游标；业务行 hlc = 跨设备 LWW 时钟；云端 seq = 断点续传。
 *
 * CAS 语义：push 用 expectedSeq = 云端当前 head；409 时先 pull 再重试（最多 5 轮），
 * 绝不猜游标。push 成功后 pulledSeq 直接推进到 nextSeq —— CAS 保证该区间严格是
 * 本机这批事件，不会被跳过遗漏其他设备的变更。
 */

/** 15 张参与同步的表：14 张可变实体 + attachments。entity 名 = change_log.entity = 表名。 */
const SYNCED_TABLES: Record<string, any> = {
  resumes,
  companies,
  company_jds: companyJds,
  referrals,
  tracker,
  applications,
  portfolios,
  interview_notes: interviewNotes,
  interview_kb: interviewKb,
  practice_sessions: practiceSessions,
  practice_questions: practiceQuestions,
  practice_answers: practiceAnswers,
  practice_evaluations: practiceEvaluations,
  practice_weaknesses: practiceWeaknesses,
  attachments,
};

/** 回灌时需要从 ISO 字符串复活成 Date 的 timestamptz 列（JSON 往返会退化成字符串）。 */
const TIMESTAMP_KEYS = new Set([
  'deletedAt',
  'createdAt',
  'updatedAt',
  'appliedAt',
  'interviewAt',
  'startedAt',
  'completedAt',
  'submittedAt',
  'lastPracticeAt',
]);

const PULL_BATCH = 200;
const PUSH_BATCH = 200;
const MAX_PULL_ROUNDS = 200;
const MAX_CAS_RETRIES = 5;

export interface SyncStats {
  pulled: number;
  applied: number;
  rejected: number;
  skipped: number;
  pushed: number;
  baseline: boolean;
  blobsUploaded: number;
  blobsDownloaded: number;
  localBlobsGc: number;
  cloudBlobsGc: number;
  pulledSeq: string;
  pushedCursor: string;
  headSeq: string;
}

export class SyncEngine {
  constructor(
    private readonly db: Database,
    private readonly blobStore: BlobStore,
    private readonly transport: SyncTransport,
    private readonly keys: VaultKeys,
    private readonly deviceId: string
  ) {}

  /** 本轮 syncOnce 拉到的远端行版本；每轮开始时清空（实例非并发安全，service 层有状态门禁）。 */
  private seenRemote: Map<string, string> = new Map();

  /** 本轮累积的 blob key（内存态）；syncOnce 结束时统一落一次 sync_state，避免每批都读写整行。 */
  private blobKeysBuf: Set<string> = new Set();

  /** 本轮起始时从 DB 读出的 knownBlobs，作为累积的基准。 */
  private knownBlobsBase: string[] = [];

  // ------------------------------------------------------------ 状态存取

  async loadState(userId: string) {
    const rows = await this.db.select().from(syncState).where(eq(syncState.userId, userId)).limit(1);
    return rows[0] ?? null;
  }

  private async patchState(userId: string, patch: Partial<typeof syncState.$inferInsert>) {
    // 状态行由 service 在启用时创建（含全部 NOT NULL 字段）；引擎只做字段级补丁。
    await this.db
      .update(syncState)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(syncState.userId, userId));
  }

  // ------------------------------------------------------------ 主流程

  async syncOnce(userId: string): Promise<SyncStats> {
    const state = await this.loadState(userId);
    if (!state) throw new Error('同步未配置：请先在设置里启用云同步');
    if (state.vaultId !== this.keys.vaultId) {
      throw new Error('本地密钥与已配置的 vault 不一致');
    }
    // 本轮拉到的远端行版本（entity:id -> rowHlc）：基线推送跳过与之完全一致的行，
    // 防止「加入设备把刚拉到的数据原样推回去」形成回声事件。
    this.seenRemote = new Map();
    this.blobKeysBuf = new Set();
    this.knownBlobsBase = state.knownBlobs || [];

    const stats: SyncStats = {
      pulled: 0,
      applied: 0,
      rejected: 0,
      skipped: 0,
      pushed: 0,
      baseline: !state.pushedCursor,
      blobsUploaded: 0,
      blobsDownloaded: 0,
      localBlobsGc: 0,
      cloudBlobsGc: 0,
      pulledSeq: state.pulledSeq || INITIAL_SEQ,
      pushedCursor: state.pushedCursor,
      headSeq: INITIAL_SEQ,
    };

    await this.patchState(userId, { status: 'syncing', lastError: null });
    try {
      // ---------- 1) pull：云端 → 本地 ----------
      await this.pullPhase(userId, stats);

      // ---------- 2) push：本地 → 云端 ----------
      if (!state.pushedCursor) {
        await this.baselinePush(userId, stats);
      } else {
        await this.incrementalPush(userId, state.pushedCursor, stats);
      }

      // ---------- 3) GC ----------
      await this.flushKnownBlobs(userId); // 先落累积的 blob key，GC 用到的引用集才完整
      stats.localBlobsGc = await this.gcLocalBlobs();
      stats.cloudBlobsGc = await this.gcCloudBlobs(userId);

      stats.headSeq = (await this.transport.head()).seq;
      await this.patchState(userId, {
        status: 'idle',
        lastSyncAt: new Date(),
        lastError: null,
        pulledSeq: stats.pulledSeq,
        pushedCursor: stats.pushedCursor,
      });
      return stats;
    } catch (err) {
      await this.patchState(userId, {
        status: 'error',
        lastError: String((err as Error)?.message || err).slice(0, 500),
        // 游标保留已推进的部分，下次从断点续传
        pulledSeq: stats.pulledSeq,
        pushedCursor: stats.pushedCursor,
      });
      throw err;
    }
  }

  /** 只读 AAD（不解密），判断封包是否属于当前账号。解析失败一律按「不匹配」处理。 */
  private envelopeScopeMatches(envelope: SyncEnvelope): boolean {
    if (!this.keys.accountScope) return true;
    try {
      const aad = JSON.parse(envelope.aad) as { accountScope?: string };
      // 存量升级前的事件没有指纹：同一 vault 内视为本账号历史数据，保持可读。
      return !aad.accountScope || aad.accountScope === this.keys.accountScope;
    } catch {
      return false;
    }
  }

  /** 拉取并回灌；每批落一次游标，中断只重放最后一小段。 */
  private async pullPhase(userId: string, stats: SyncStats): Promise<void> {
    for (let round = 0; round < MAX_PULL_ROUNDS; round += 1) {
      const result = await this.transport.pull(stats.pulledSeq, PULL_BATCH);
      for (const envelope of result.envelopes) {
        stats.pulled += 1;
        // 本机自己推的事件不再回灌（push 成功后游标通常已越过，这里是兜底）。
        // deviceId 是机器级的，同机多账号会共享；只有 AAD 的账号隔离指纹也匹配时
        // 才认定是「本账号这台设备」推的，否则继续走 openEvent（密钥不同必然解封
        // 失败，绝不会把别账号的数据落库，也不会误跳过本账号该拉的事件）。
        if (envelope.deviceId === this.deviceId && this.envelopeScopeMatches(envelope)) {
          stats.skipped += 1;
          continue;
        }
        let outcome: 'applied' | 'rejected' | 'skipped';
        try {
          const { event } = openEvent(this.keys, envelope);
          // 第二道防线：密文内的账号指纹与本地不符，拒绝回灌。
          if (this.keys.accountScope && event.scope && event.scope !== this.keys.accountScope) {
            throw new Error('事件账号隔离指纹不匹配：拒绝跨账号回灌');
          }
          if (event.rowHlc) {
            this.seenRemote.set(`${event.entity}:${event.entityId}`, String(event.rowHlc));
          }
          outcome = await this.applyEvent(userId, event, stats);
        } catch (err) {
          // 单条事件损坏不拖垮整轮同步：跳过并计入 skipped，问题事件可人工排查
          console.error('[sync-engine] apply event failed', envelope.seq, err);
          outcome = 'skipped';
        }
        if (outcome === 'applied') stats.applied += 1;
        else if (outcome === 'rejected') stats.rejected += 1;
        else stats.skipped += 1;
      }
      stats.pulledSeq = result.nextSeq;
      await this.patchState(userId, { pulledSeq: stats.pulledSeq });
      if (result.envelopes.length < PULL_BATCH) break;
    }
  }

  // ------------------------------------------------------------ push：基线 / 增量

  /** 首次启用：把 15 张表当前全部活跃行推上去（墓碑行不推，远端从零开始不需要历史）。 */
  private async baselinePush(userId: string, stats: SyncStats): Promise<void> {
    for (const entity of Object.keys(SYNCED_TABLES)) {
      const table = SYNCED_TABLES[entity];
      const rows = await this.db
        .select()
        .from(table)
        .where(and(eq(table.userId, userId), isNull(table.deletedAt)));
      // 跳过与本轮拉到的远端版本完全一致的行：加入设备不把云上已有的数据推回去
      const fresh = rows.filter(
        (row) => this.seenRemote.get(`${entity}:${row.id}`) !== String(row.hlc || '')
      );
      for (let i = 0; i < fresh.length; i += PUSH_BATCH) {
        const chunk = fresh.slice(i, i + PUSH_BATCH);
        const events = chunk.map((row) => this.rowToEvent(entity, row, '', 'upsert'));
        await this.pushWithRetry(userId, events, stats);
      }
    }
    // 基线完成：游标直接推进到当前最大 hlc，之后的增量从这继续
    stats.pushedCursor = await this.maxChangeCursor(userId);
    await this.patchState(userId, { pushedCursor: stats.pushedCursor });
  }

  /** 日常增量：读 change_log → 按行快照封包。未同步实体的记录直接越过游标。 */
  private async incrementalPush(userId: string, cursor: string, stats: SyncStats): Promise<void> {
    for (;;) {
      const changes = await this.db
        .select()
        .from(changeLog)
        .where(and(eq(changeLog.userId, userId), gt(changeLog.hlc, cursor)))
        .orderBy(changeLog.hlc)
        .limit(PUSH_BATCH);
      if (!changes.length) break;

      // 按 entity 分组，同一张表用一次 IN(...) 批量拉行快照，避免逐条 SELECT 的 N+1。
      const byEntity = new Map<string, typeof changeLog.$inferSelect[]>();
      for (const change of changes) {
        if (!SYNCED_TABLES[change.entity]) continue;
        const list = byEntity.get(change.entity) || [];
        list.push(change);
        byEntity.set(change.entity, list);
      }
      const rowCache = new Map<string, Record<string, unknown> | null>();
      for (const [entity, list] of byEntity) {
        const table = SYNCED_TABLES[entity];
        const ids = list.map((c) => c.entityId);
        const rows = await this.db
          .select()
          .from(table)
          .where(and(eq(table.userId, userId), inArray(table.id, ids)));
        const byId = new Map(rows.map((r) => [String(r.id), r as Record<string, unknown>]));
        for (const c of list) rowCache.set(`${entity}:${c.entityId}`, byId.get(c.entityId) || null);
      }

      const events: SyncEvent[] = [];
      let lastCursor = cursor;
      for (const change of changes) {
        lastCursor = change.hlc;
        const table = SYNCED_TABLES[change.entity];
        if (!table) continue; // versions / application_events / settings / ai_configs 暂不同步
        const row = rowCache.get(`${change.entity}:${change.entityId}`);
        if (!row) continue; // 软删除表不该出现；防御性跳过
        events.push(this.rowToEvent(change.entity, row, change.hlc, change.op));
      }
      if (events.length) {
        await this.pushWithRetry(userId, events, stats);
      }
      cursor = lastCursor;
      stats.pushedCursor = lastCursor;
      await this.patchState(userId, { pushedCursor: lastCursor });
      if (changes.length < PUSH_BATCH) break;
    }
  }

  private rowToEvent(
    entity: string,
    row: Record<string, unknown>,
    localCursor: string,
    op: 'upsert' | 'delete'
  ): SyncEvent {
    const blobKeys: string[] = [];
    if (entity === 'attachments' && op === 'upsert' && row.sha256) {
      blobKeys.push(blobObjectKey(this.keys, String(row.sha256)));
    }
    return {
      localCursor,
      entity,
      entityId: String(row.id),
      op,
      rowHlc: String(row.hlc || ''),
      deviceId: String(row.deviceId || ''),
      row,
      blobKeys,
      // 账号隔离指纹进密文：对端回灌时校验，杜绝跨账号数据串库。
      ...(this.keys.accountScope ? { scope: this.keys.accountScope } : {}),
    };
  }

  /** 封包上云（含附件 blob 先传后推）；CAS 冲突先 pull 再重试。 */
  private async pushWithRetry(userId: string, events: SyncEvent[], stats: SyncStats): Promise<void> {
    for (const event of events) {
      if (event.entity === 'attachments' && event.op === 'upsert' && event.blobKeys.length) {
        if (await this.uploadAttachmentBlob(userId, event)) stats.blobsUploaded += 1;
      }
    }
    const batchId = randomUUID();
    const envelopes = events.map((event, index) =>
      sealEvent(this.keys, event, { deviceId: this.deviceId, batchId, index })
    );

    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
      const head = await this.transport.head();
      try {
        const result = await this.transport.push(envelopes, head.seq);
        stats.pushed += envelopes.length;
        // CAS 成功 ⇒ (head.seq, nextSeq] 严格是本机这批；游标直接越过，不重复拉自己
        stats.pulledSeq = result.nextSeq;
        await this.patchState(userId, { pulledSeq: result.nextSeq });
        await this.rememberBlobKeys(
          userId,
          events
            .filter((e) => e.entity === 'attachments' && e.op === 'upsert')
            .map((e) => blobObjectKey(this.keys, String((e.row as Record<string, unknown>)?.sha256 || '')))
            .filter(Boolean)
        );
        return;
      } catch (err) {
        if (err instanceof Error && err.name === 'SeqConflictError' && attempt < MAX_CAS_RETRIES - 1) {
          await this.pullPhase(userId, stats);
          continue;
        }
        throw err;
      }
    }
  }

  /** 附件字节：本地读明文 → sealBlob 加密 → 上云（已存在则跳过）。 */
  private async uploadAttachmentBlob(userId: string, event: SyncEvent): Promise<boolean> {
    const sha256 = String((event.row as Record<string, unknown>)?.sha256 || '');
    if (!sha256) return false;
    const key = blobObjectKey(this.keys, sha256);
    if (await this.transport.hasBlob(key)) return false;
    if (!(await this.blobStore.exists(sha256))) {
      // 本地字节缺失（remote_only 降级）：行照推，blob 由拥有字节的一侧补传
      return false;
    }
    const plain = await streamToBuffer(await this.blobStore.get(sha256));
    const sealed = sealBlob(this.keys, sha256, plain);
    await this.transport.putBlob(key, Readable.from([sealed]), sealed.length);
    await this.rememberBlobKeys(userId, [key]);
    return true;
  }

  /** 记住本机已上云 / 回灌过的 blob key；只累积到内存，flushKnownBlobs 统一落库。 */
  private async rememberBlobKeys(userId: string, keys: string[]): Promise<void> {
    void userId;
    for (const k of keys) this.blobKeysBuf.add(k);
  }

  /** 本轮结束前把累积的 blob key 合并进 knownBlobs 并一次落库（避免每批重复读整行）。 */
  private async flushKnownBlobs(userId: string): Promise<void> {
    if (!this.blobKeysBuf.size) return;
    const merged = [...new Set([...this.knownBlobsBase, ...this.blobKeysBuf])];
    await this.patchState(userId, { knownBlobs: merged });
    this.blobKeysBuf = new Set();
    this.knownBlobsBase = merged;
  }

  // ------------------------------------------------------------ 回灌

  private async applyEvent(
    userId: string,
    event: SyncEvent,
    stats: SyncStats
  ): Promise<'applied' | 'rejected' | 'skipped'> {
    if (event.entity === 'attachments') {
      return this.applyAttachment(userId, event, stats);
    }
    if (!SYNCED_TABLES[event.entity] || !event.row) return 'skipped';
    const row = reviveRow(event.row);
    // 跨设备时 user_id 是各设备本地生成的 UUID，必须改写成本地账号归属。
    // 安全性由上文两道账号指纹校验保证：能走到这里的事件一定属于当前账号。
    row.userId = userId;
    const result = await applyRemoteUpsert(this.db, {
      entity: event.entity as 'resumes',
      row,
    });
    return result.applied ? 'applied' : 'rejected';
  }

  /** 附件回灌：先补字节再上行；blob 缺失不阻塞行落地（下次同步重试）。 */
  private async applyAttachment(
    userId: string,
    event: SyncEvent,
    stats: SyncStats
  ): Promise<'applied' | 'rejected' | 'skipped'> {
    if (!event.row) return 'skipped';
    const row = reviveRow(event.row);
    row.userId = userId;
    const sha256 = String(row.sha256 || '');

    // attachments 无 0011 行守卫（hlc 由应用层维护），LWW 在这里判定：
    // 本地时钟严格更新时保留本地版本；相等视为幂等重放，照常落库。
    const local = await this.db
      .select({ hlc: attachments.hlc })
      .from(attachments)
      .where(and(eq(attachments.userId, userId), eq(attachments.id, String(row.id))))
      .limit(1);
    if (local.length && String(row.hlc || '') < local[0].hlc) return 'rejected';

    if (event.op === 'upsert' && sha256 && !(await this.blobStore.exists(sha256))) {
      const key = blobObjectKey(this.keys, sha256);
      try {
        const sealed = await streamToBuffer(await this.transport.getBlob(key));
        const plain = openBlob(this.keys, sha256, sealed);
        const put = await this.blobStore.put(Readable.from([plain]));
        if (put.sha256 !== sha256) throw new Error('blob 内容指纹不一致');
        stats.blobsDownloaded += 1;
      } catch (err) {
        console.error('[sync-engine] blob download failed', sha256, err);
      }
    }
    row.syncState = 'synced';
    if (sha256) row.remoteKey = blobObjectKey(this.keys, sha256);
    return withSyncImport(this.db, async () => {
      const inserted = await this.db
        .insert(attachments)
        .values(row as never)
        .onConflictDoUpdate({
          target: [attachments.userId, attachments.id],
          set: row as never,
        })
        .returning({ id: attachments.id });
      return inserted.length ? 'applied' : 'rejected';
    });
  }

  // ------------------------------------------------------------ GC

  /** 本地 GC：以全库活跃 attachments 引用集为准（blob 目录跨用户共享；墓碑行不再引用）。 */
  private async gcLocalBlobs(): Promise<number> {
    const referenced = new Set(
      (
        await this.db
          .select({ sha256: attachments.sha256 })
          .from(attachments)
          .where(isNull(attachments.deletedAt))
      ).map((r) => r.sha256)
    );
    let removed = 0;
    for (const sha256 of await this.blobStore.list()) {
      if (!referenced.has(sha256)) {
        await this.blobStore.remove(sha256);
        removed += 1;
      }
    }
    return removed;
  }

  /** 云端 GC：knownBlobs 里已无引用的 key 删除；引用集 = 本账号活跃附件行。 */
  private async gcCloudBlobs(userId: string): Promise<number> {
    // knownBlobsBase 在 flushKnownBlobs 后已含本轮新增 key，直接复用内存态，避免再读整行。
    const known = this.knownBlobsBase;
    if (!known.length) return 0;
    const rows = await this.db
      .select({ sha256: attachments.sha256 })
      .from(attachments)
      .where(and(eq(attachments.userId, userId), isNull(attachments.deletedAt)));
    const referenced = new Set(rows.map((r) => blobObjectKey(this.keys, r.sha256)));
    const keep: string[] = [];
    let removed = 0;
    for (const key of known) {
      if (referenced.has(key)) {
        keep.push(key);
      } else {
        try {
          await this.transport.deleteBlob(key);
          removed += 1;
        } catch (err) {
          console.error('[sync-engine] cloud blob gc failed', key, err);
          keep.push(key); // 删失败保留，下次再试
        }
      }
    }
    if (removed) {
      await this.patchState(userId, { knownBlobs: keep });
      this.knownBlobsBase = keep;
    }
    return removed;
  }

  // ------------------------------------------------------------ 辅助

  private async maxChangeCursor(userId: string): Promise<string> {
    const rows = await this.db
      .select({ max: sql<string>`coalesce(max(${changeLog.hlc}), '0')` })
      .from(changeLog)
      .where(eq(changeLog.userId, userId));
    return rows[0]?.max || '0';
  }
}

/** ISO 字符串 → Date：timestamptz 列经 JSON 往返会退化成字符串，回灌前必须复活。 */
export function reviveRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const key of TIMESTAMP_KEYS) {
    const value = out[key];
    if (typeof value === 'string' && value) out[key] = new Date(value);
  }
  return out;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array | string));
  return Buffer.concat(chunks);
}
