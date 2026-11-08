/**
 * SyncStore 的腾讯云 CloudBase 实现：云数据库存授权哈希 + 密文事件流，
 * 云存储存已加密 blob。与 D1R2Store 实现同一个接口，handler 完全不感知厂商。
 *
 * 为什么用文档型数据库的事务而不是「先读后写」：
 *   CAS 是同步链路的一致性根基。CloudBase 的 runTransaction 提供快照隔离 +
 *   文档锁（见官方文档「数据库事务」），在事务里读 vault.headSeq、逐条 set 事件、
 *   再推进 head，要么全成要么全回滚，不会出现序号空洞或半批写入。
 *   事务内只支持 doc 操作（不支持 where），本实现正好只按 _id 读写。
 *
 * 集合（首次部署时需在控制台建好，或用 SDK add 自动建）：
 *   ca_vaults   _id = vaultId            { vaultId, authHash, salt, createdAt, headSeq }
 *   ca_devices  _id = vaultId:deviceId  { vaultId, deviceId, firstSeenAt, lastSeenAt }
 *   ca_events   _id = vaultId:seq        { vaultId, seq, deviceId, aad, nonce, ciphertext, bytes, createdAt }
 *   ca_blobs    _id = vaultId:objectKey { vaultId, objectKey, fileID, bytes, createdAt }
 *
 * 云端永远只看到：sha256(authKey) 的哈希、明文 AAD（路由信息）、密文、HMAC 派生的
 * objectKey。没有任何解密逻辑，也不知道 SyncEvent 的业务结构。
 */

import { INITIAL_SEQ, OBJECT_KEY_RE } from '../../sync-worker/src/protocol';
import {
  type AppendResult,
  type EventRecord,
  type NewEvent,
  type SyncStore,
  type VaultRecord,
} from '../../sync-worker/src/store';

const VAULTS = 'ca_vaults';
const DEVICES = 'ca_devices';
const EVENTS = 'ca_events';
const BLOBS = 'ca_blobs';

/* ------------------------------------------------------------------ *
 * @cloudbase/node-sdk 的最小接口。生产适配层在 src/index.ts 里把真实 SDK
 * 包成这个形状，测试用内存实现，二者跑的是同一份 CloudBaseSyncStore。
 * ------------------------------------------------------------------ */

export interface TcbDocSnapshot {
  data?: Record<string, unknown> | null;
}
export interface TcbDocRefLike {
  get(): Promise<TcbDocSnapshot>;
  /** 传入平铺字段；适配层负责处理 SDK 的 { data: ... } 包装差异。 */
  set(data: Record<string, unknown>): Promise<unknown>;
  update(data: Record<string, unknown>): Promise<unknown>;
}
export interface TcbQueryLike {
  orderBy(field: string, direction: 'asc' | 'desc'): TcbQueryLike;
  limit(n: number): TcbQueryLike;
  get(): Promise<{ data: Record<string, unknown>[] }>;
}
export interface TcbCollectionLike {
  doc(id: string): TcbDocRefLike;
  where(condition: Record<string, unknown>): TcbQueryLike;
}
export interface TcbTransactionLike {
  collection(name: string): TcbCollectionLike;
}
export interface TcbDatabaseLike {
  collection(name: string): TcbCollectionLike;
  /** 适配层把 SDK 的 { result, errMsg } 解包成 updateFunction 的返回值。 */
  runTransaction<T>(fn: (transaction: TcbTransactionLike) => Promise<T>): Promise<T>;
  /** db.command.gt(value)：seq 是 20 位定长字符串，字典序 = 数值序。 */
  gt(value: string): unknown;
}
export interface TcbStorageLike {
  uploadFile(opts: { cloudPath: string; fileContent: Uint8Array }): Promise<{ fileID: string }>;
  downloadFile(opts: { fileID: string }): Promise<{ fileContent: Uint8Array }>;
}

interface VaultDoc {
  vaultId?: string;
  authHash?: string;
  salt?: string;
  createdAt?: string;
  headSeq?: string;
}
interface EventDoc {
  seq?: string;
  device_id?: string;
  aad?: string;
  nonce?: string;
  ciphertext?: string;
  bytes?: number;
  created_at?: string;
}
interface BlobDoc {
  fileID?: string;
}

function eventDocId(vaultId: string, seq: string): string {
  return `${vaultId}:${seq}`;
}
function blobDocId(vaultId: string, objectKey: string): string {
  if (!OBJECT_KEY_RE.test(objectKey)) throw new Error('非法 objectKey');
  return `${vaultId}:${objectKey}`;
}
function blobCloudPath(vaultId: string, objectKey: string): string {
  if (!OBJECT_KEY_RE.test(objectKey)) throw new Error('非法 objectKey');
  return `v1/${vaultId}/blobs/${objectKey}`;
}

export class CloudBaseSyncStore implements SyncStore {
  constructor(
    private readonly db: TcbDatabaseLike,
    private readonly storage: TcbStorageLike
  ) {}

  /**
   * 绝不覆盖已有 vault：否则拿到同一个 vaultId 的人可以用新 authHash 接管同步数据。
   * 用事务包住「读 + 建」，并发创建时只有第一个能成功。
   */
  async createVault(vault: VaultRecord): Promise<{ created: boolean }> {
    const created = await this.db.runTransaction(async (tx) => {
      const ref = tx.collection(VAULTS).doc(vault.vaultId);
      const existing = await ref.get();
      if (existing.data) return false;
      await ref.set({
        vaultId: vault.vaultId,
        authHash: vault.authHash,
        salt: vault.salt,
        createdAt: vault.createdAt,
        headSeq: INITIAL_SEQ,
      });
      return true;
    });
    return { created };
  }

  async getVault(vaultId: string): Promise<VaultRecord | null> {
    const snapshot = await this.db.collection(VAULTS).doc(vaultId).get();
    const row = snapshot.data as VaultDoc | null | undefined;
    if (!row || !row.authHash || !row.salt) return null;
    return {
      vaultId: row.vaultId || vaultId,
      authHash: row.authHash,
      salt: row.salt,
      createdAt: String(row.createdAt || ''),
    };
  }

  async registerDevice(vaultId: string, deviceId: string, at: string): Promise<void> {
    await this.db.collection(DEVICES).doc(`${vaultId}:${deviceId}`).set({
      vaultId,
      deviceId,
      firstSeenAt: at,
      lastSeenAt: at,
    });
  }

  /** head 存在 vault 文档里，与事件写入在同一个事务内推进。 */
  async headSeq(vaultId: string): Promise<string> {
    const snapshot = await this.db.collection(VAULTS).doc(vaultId).get();
    const row = snapshot.data as VaultDoc | null | undefined;
    return row?.headSeq || INITIAL_SEQ;
  }

  async appendEvents(
    vaultId: string,
    expectedSeq: string,
    events: NewEvent[]
  ): Promise<AppendResult> {
    if (!events.length) return { ok: true, nextSeq: expectedSeq };
    const nextSeq = events[events.length - 1].seq;
    const at = new Date().toISOString();
    try {
      return await this.db.runTransaction<AppendResult>(async (tx) => {
        const vaultRef = tx.collection(VAULTS).doc(vaultId);
        const snapshot = await vaultRef.get();
        const row = snapshot.data as VaultDoc | null | undefined;
        if (!row) return { ok: false, nextSeq: INITIAL_SEQ, actual: INITIAL_SEQ };
        const head = row.headSeq || INITIAL_SEQ;
        if (head !== expectedSeq) return { ok: false, nextSeq: head, actual: head };

        // 逐条按 _id 写；并发撞同一 seq 时事务写冲突会抛错，整批回滚
        for (const event of events) {
          await tx.collection(EVENTS).doc(eventDocId(vaultId, event.seq)).set({
            vaultId,
            seq: event.seq,
            device_id: event.deviceId,
            aad: event.aad,
            nonce: event.nonce,
            ciphertext: event.ciphertext,
            bytes: event.bytes,
            created_at: at,
          });
        }
        await vaultRef.update({ headSeq: nextSeq });
        return { ok: true, nextSeq };
      });
    } catch {
      // 写冲突 / 事务超时：按 CAS 失败处理，让客户端 pull 后重试，绝不猜一个游标
      const actual = await this.headSeq(vaultId);
      return { ok: false, nextSeq: actual, actual };
    }
  }

  async listEvents(vaultId: string, sinceSeq: string, limit: number): Promise<EventRecord[]> {
    const result = await this.db
      .collection(EVENTS)
      .where({ vaultId, seq: this.db.gt(sinceSeq) })
      .orderBy('seq', 'asc')
      .limit(limit)
      .get();
    return (result.data || []).map((raw) => {
      const row = raw as EventDoc;
      return {
        seq: String(row.seq),
        vaultId,
        deviceId: String(row.device_id || ''),
        aad: String(row.aad || ''),
        nonce: String(row.nonce || ''),
        ciphertext: String(row.ciphertext || ''),
        bytes: Number(row.bytes || 0),
        createdAt: String(row.created_at || ''),
      };
    });
  }

  async putBlob(vaultId: string, objectKey: string, bytes: Uint8Array): Promise<void> {
    const ref = this.db.collection(BLOBS).doc(blobDocId(vaultId, objectKey));
    if ((await ref.get()).data) return; // 内容寻址：重传幂等，不重复占用存储
    const { fileID } = await this.storage.uploadFile({
      cloudPath: blobCloudPath(vaultId, objectKey),
      fileContent: bytes,
    });
    if (!fileID) throw new Error('云存储上传未返回 fileID');
    await ref.set({
      vaultId,
      objectKey,
      fileID,
      bytes: bytes.length,
      createdAt: new Date().toISOString(),
    });
  }

  async getBlob(vaultId: string, objectKey: string): Promise<Uint8Array | null> {
    const snapshot = await this.db.collection(BLOBS).doc(blobDocId(vaultId, objectKey)).get();
    const row = snapshot.data as BlobDoc | null | undefined;
    if (!row?.fileID) return null;
    const { fileContent } = await this.storage.downloadFile({ fileID: row.fileID });
    return new Uint8Array(fileContent);
  }

  async hasBlob(vaultId: string, objectKey: string): Promise<boolean> {
    const snapshot = await this.db.collection(BLOBS).doc(blobDocId(vaultId, objectKey)).get();
    const row = snapshot.data as BlobDoc | null | undefined;
    return !!row?.fileID;
  }

  /** 删除置空 fileID（幂等）；云存储文件由生命周期规则清理，索引立即失效。 */
  async deleteBlob(vaultId: string, objectKey: string): Promise<void> {
    await this.db.collection(BLOBS).doc(blobDocId(vaultId, objectKey)).update({
      fileID: '',
      deletedAt: new Date().toISOString(),
    });
  }
}
