import type { Readable } from 'node:stream';

/**
 * 云端选型定稿（2026-11-08）：哑云（dumb pipe）+ 端到端加密 + 可替换 Transport。
 *
 * 为什么云端不建业务库：
 *   · HLC 授时 / LWW 判定 / 软删除墓碑 / 冲突快照 / 人工恢复已在本地 0010~0012 全部完成；
 *   · E2EE 下云端只见密文，托管 PG 的触发器 / RLS / Realtime / 全文检索全部无从发挥；
 *   · 云端只做「设备授权 + 分配严格递增序号 + 存密文」，换厂商只换一个 SyncTransport 实现。
 *
 * 三个序号职责必须分清（最容易写歪的地方）：
 *   1. change_log.hlc —— 本地增量拉取游标（0010 单序列授时），只在本机有效；
 *   2. 业务行 hlc —— 跨设备 LWW 的因果时钟（0011），随事件一起封包；
 *   3. 云端 seq —— 全局严格递增的事件顺序，只决定 push/pull 断点续传，
 *      绝不参与冲突判定。0010 注释里预留的「独立 seq」就是它。
 *
 * 事件负载的关键约束：0010 的 change_log.payload 只是轻量信号（table/op/id），
 * 不含整行。因此 SyncEngine 在 push 前必须按 entity/entityId 读取当时的完整业务行
 * 快照放进 SyncEvent.row；回灌必须走 sync-import.ts 的 applyRemoteUpsert()，
 * 由本地 BEFORE 守卫做 LWW 与冲突留底，绝不裸写业务表。
 */

export const SYNC_PROTOCOL_VERSION = 1 as const;

/** 定长十进制字符串：字典序 = 数值序，可直接用于 SQL 的 WHERE seq > ? 与文件名排序。 */
export const SEQ_WIDTH = 20;
export const INITIAL_SEQ = '0'.repeat(SEQ_WIDTH);

export function formatSeq(value: number | bigint): string {
  const n = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  if (n < 0n) throw new Error('seq 不能为负数');
  const s = n.toString().padStart(SEQ_WIDTH, '0');
  if (s.length > SEQ_WIDTH) throw new Error('seq 溢出');
  return s;
}

export function parseSeq(value: string): bigint {
  if (!/^\d{1,20}$/.test(value || '')) throw new Error(`非法 seq: ${value}`);
  return BigInt(value);
}

export function nextSeq(value: string): string {
  return formatSeq(parseSeq(value) + 1n);
}

/**
 * 云端只认这个随机 ID，不知道用户是谁。
 * I1 改造后 vaultId 由「恢复码 + 账号因子」派生（v2），因此它本身就是账号级
 * 的不透明空间标识；存量 v1 vault 仍沿用旧 ID，由客户端在本地完成归属校验。
 */
export interface VaultRef {
  vaultId: string;
}

/** 事件明文：只在本地内存出现，出本机前必须经 crypto.ts 的 sealEvent 加密。 */
export interface SyncEvent {
  /** change_log 的本地拉取游标，仅用于审计与去重，绝不参与 LWW。 */
  localCursor: string;
  entity: string;
  entityId: string;
  op: 'upsert' | 'delete';
  /** 业务行的 HLC（0011），LWW 判定时钟；delete 事件可为 null。 */
  rowHlc: string | null;
  deviceId: string;
  /** upsert 时的完整业务行快照（含 hlc / device_id / deleted_at）；delete 可为 null。 */
  row: Record<string, unknown> | null;
  /** 本事件引用的 blob objectKey，供对端按需懒加载。 */
  blobKeys: string[];
  /**
   * 账号隔离指纹（密文内，可选）：由 encKey + 账号因子 HMAC 派生。
   * 回灌时若与本地指纹不符则拒绝落库，作为 AAD 校验之外的第二道防线。
   * 存量升级前的事件没有此字段，按同 vault 历史数据放行。
   */
  scope?: string;
}

/**
 * AAD 是明文（云端可见），只含路由信息，不含任何业务内容。
 *
 * 刻意不含云端 seq：seq 由云端在 push 时分配，若绑进 AAD，
 * 服务端改写 seq 后密文就再也解不开。seq 的完整性改由 pull 时的
 * 「严格递增且与 nextSeq 吻合」校验保证；batchId + index 防批内重放。
 */
export interface SyncAad {
  v: typeof SYNC_PROTOCOL_VERSION;
  vaultId: string;
  deviceId: string;
  batchId: string;
  index: number;
  createdAt: string;
  /** 账号隔离指纹（不透明 hex，可选）；存量事件无此字段。云端不解析、不存身份。 */
  accountScope?: string;
}

/** 云端存储单元：除 AAD 外整个世界都是密文。 */
export interface SyncEnvelope {
  v: typeof SYNC_PROTOCOL_VERSION;
  vaultId: string;
  deviceId: string;
  /** 由云端在 push 时分配；离线包适配器写盘时补上。 */
  seq: string;
  aad: string;
  nonce: string;
  ciphertext: string;
  bytes: number;
}

export interface SyncPushResult {
  accepted: number;
  nextSeq: string;
}

export interface SyncPullResult {
  envelopes: SyncEnvelope[];
  nextSeq: string;
}

/** CAS 冲突：expectedSeq 落后于云端 head，客户端必须先 pull + 重放再重试。 */
export class SeqConflictError extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string
  ) {
    super(`同步序号冲突：期望 ${expected}，云端为 ${actual}；请先 pull 再重试`);
    this.name = 'SeqConflictError';
  }
}

/**
 * 同步通道最小契约。云端实现（Cloudflare / 腾讯云 / 自建 Nest）与离线增量包实现
 * 都只依赖这 6 个方法；上层 SyncEngine 与业务代码不感知厂商。
 *
 * 所有 objectKey 都是 HMAC 派生的 64 位 hex，不含路径分隔符，见 crypto.ts。
 */
export interface SyncTransport {
  readonly kind: string;
  /** 当前云端最新序号，用于首次同步与 CAS 前置检查。 */
  head(): Promise<{ seq: string }>;
  /** CAS 批量推送；envelope.seq 由实现分配并回写。 */
  push(envelopes: SyncEnvelope[], expectedSeq: string): Promise<SyncPushResult>;
  /** 拉 since 之后的增量；nextSeq 是断点续传游标。 */
  pull(sinceSeq: string, limit?: number): Promise<SyncPullResult>;
  /** blob 为已加密字节；同 key 重复写必须幂等。 */
  putBlob(objectKey: string, stream: Readable, bytes: number): Promise<void>;
  getBlob(objectKey: string): Promise<Readable>;
  hasBlob(objectKey: string): Promise<boolean>;
  /** 删除云端 blob；内容寻址，删除前由客户端比对引用集，云端不感知引用关系。 */
  deleteBlob(objectKey: string): Promise<void>;
}

/** objectKey 白名单：任何外部输入都必须过这一关才能拼路径。 */
export const OBJECT_KEY_RE = /^[0-9a-f]{64}$/;

export function assertObjectKey(key: string): string {
  if (!OBJECT_KEY_RE.test(key || '')) throw new Error('非法 objectKey：拒绝非 HMAC 派生路径');
  return key;
}
