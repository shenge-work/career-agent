/**
 * 哑云的持久化门面：Worker handler 只依赖这个接口，不直接碰 D1 / R2。
 *
 * 好处：
 *   · 换云厂商只换一份 Store 实现，协议与授权逻辑不动；
 *   · 本地没有 Cloudflare 账号时，用 MemorySyncStore + 注入 fetch 就能跑完整端到端测试；
 *   · 存储层永远拿不到明文：EventRecord 里只有 aad（路由信息）与密文。
 */

import { INITIAL_SEQ, OBJECT_KEY_RE, parseSeq, seqAt } from './protocol';

export interface VaultRecord {
  vaultId: string;
  /** sha256(authKey) 的 hex；authKey 本身只在 TLS 请求头里出现，绝不落库。 */
  authHash: string;
  /** 可公开，供另一台设备加入时核对；恢复码本身也能派生出它。 */
  salt: string;
  createdAt: string;
}

export interface EventRecord {
  seq: string;
  vaultId: string;
  deviceId: string;
  aad: string;
  nonce: string;
  ciphertext: string;
  bytes: number;
  createdAt: string;
}

export type NewEvent = Omit<EventRecord, 'vaultId' | 'createdAt'>;

export interface AppendResult {
  ok: boolean;
  nextSeq: string;
  /** CAS 失败时的云端当前序号。 */
  actual?: string;
}

export interface SyncStore {
  createVault(vault: VaultRecord): Promise<{ created: boolean }>;
  getVault(vaultId: string): Promise<VaultRecord | null>;
  registerDevice(vaultId: string, deviceId: string, at: string): Promise<void>;
  headSeq(vaultId: string): Promise<string>;
  /** CAS 批量追加：expectedSeq 与云端 head 不符必须整批拒绝。 */
  appendEvents(vaultId: string, expectedSeq: string, events: NewEvent[]): Promise<AppendResult>;
  listEvents(vaultId: string, sinceSeq: string, limit: number): Promise<EventRecord[]>;
  putBlob(vaultId: string, objectKey: string, bytes: Uint8Array): Promise<void>;
  getBlob(vaultId: string, objectKey: string): Promise<Uint8Array | null>;
  hasBlob(vaultId: string, objectKey: string): Promise<boolean>;
  /** 删除 blob；内容寻址，幂等；客户端比对引用集后调用，云端不感知引用关系。 */
  deleteBlob(vaultId: string, objectKey: string): Promise<void>;
}

function blobPath(vaultId: string, objectKey: string): string {
  if (!OBJECT_KEY_RE.test(objectKey)) throw new Error('非法 objectKey');
  return `v1/${vaultId}/blobs/${objectKey}`;
}

/** 本地测试 / wrangler dev 前的协议验证用；语义与 D1+R2 实现一致。 */
export class MemorySyncStore implements SyncStore {
  readonly vaults = new Map<string, VaultRecord>();
  readonly events = new Map<string, EventRecord[]>();
  readonly devices = new Map<string, Set<string>>();
  readonly blobs = new Map<string, Uint8Array>();
  /** 便于测试断言「密文原样落盘、没有被改写」。 */
  blobWrites = 0;

  async createVault(vault: VaultRecord): Promise<{ created: boolean }> {
    if (this.vaults.has(vault.vaultId)) return { created: false };
    this.vaults.set(vault.vaultId, { ...vault });
    this.events.set(vault.vaultId, []);
    this.devices.set(vault.vaultId, new Set());
    return { created: true };
  }

  async getVault(vaultId: string): Promise<VaultRecord | null> {
    return this.vaults.get(vaultId) ? { ...this.vaults.get(vaultId)! } : null;
  }

  async registerDevice(vaultId: string, deviceId: string, _at: string): Promise<void> {
    this.devices.get(vaultId)?.add(deviceId);
  }

  async headSeq(vaultId: string): Promise<string> {
    const rows = this.events.get(vaultId) || [];
    return rows.length ? rows[rows.length - 1].seq : INITIAL_SEQ;
  }

  async appendEvents(
    vaultId: string,
    expectedSeq: string,
    events: NewEvent[]
  ): Promise<AppendResult> {
    const head = await this.headSeq(vaultId);
    if (head !== expectedSeq) return { ok: false, nextSeq: head, actual: head };
    const at = new Date().toISOString();
    const rows = events.map((e) => ({ ...e, vaultId, createdAt: at }));
    this.events.set(vaultId, [...(this.events.get(vaultId) || []), ...rows]);
    const next = events.length ? events[events.length - 1].seq : head;
    return { ok: true, nextSeq: next };
  }

  async listEvents(vaultId: string, sinceSeq: string, limit: number): Promise<EventRecord[]> {
    const since = parseSeq(sinceSeq);
    return (this.events.get(vaultId) || [])
      .filter((e) => parseSeq(e.seq) > since)
      .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  async putBlob(vaultId: string, objectKey: string, bytes: Uint8Array): Promise<void> {
    const key = blobPath(vaultId, objectKey);
    if (this.blobs.has(key)) return; // 内容寻址：重传幂等
    this.blobs.set(key, new Uint8Array(bytes));
    this.blobWrites += 1;
  }

  async getBlob(vaultId: string, objectKey: string): Promise<Uint8Array | null> {
    const value = this.blobs.get(blobPath(vaultId, objectKey));
    return value ? new Uint8Array(value) : null;
  }

  async hasBlob(vaultId: string, objectKey: string): Promise<boolean> {
    return this.blobs.has(blobPath(vaultId, objectKey));
  }

  async deleteBlob(vaultId: string, objectKey: string): Promise<void> {
    this.blobs.delete(blobPath(vaultId, objectKey));
  }
}

/* ------------------------------------------------------------------ *
 * Cloudflare 运行时的最小类型（避免为了编译把 @cloudflare/workers-types
 * 拉成本地安装包的依赖；wrangler 部署时会用自己的类型检查）。
 * ------------------------------------------------------------------ */
export interface D1StatementLike {
  run<T = unknown>(): Promise<{ meta?: { changes?: number } } & T>;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}
export interface D1Like {
  prepare(sql: string): { bind(...args: unknown[]): D1StatementLike };
  batch<T = unknown>(statements: D1StatementLike[]): Promise<T[]>;
}
export interface R2Like {
  put(key: string, value: ArrayBuffer | Uint8Array | ReadableStream): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream; size: number } | null>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<unknown>;
}

interface EventRow {
  seq: string;
  device_id: string;
  aad: string;
  nonce: string;
  ciphertext: string;
  bytes: number;
  created_at: string;
}

/** 生产实现：D1 存授权哈希 + 密文事件流，R2 存已加密 blob。 */
export class D1R2Store implements SyncStore {
  constructor(
    private readonly db: D1Like,
    private readonly bucket: R2Like
  ) {}

  async createVault(vault: VaultRecord): Promise<{ created: boolean }> {
    const res = await this.db
      .prepare(
        'INSERT OR IGNORE INTO vaults (vault_id, auth_hash, salt, created_at) VALUES (?, ?, ?, ?)'
      )
      .bind(vault.vaultId, vault.authHash, vault.salt, vault.createdAt)
      .run();
    return { created: (res.meta?.changes ?? 0) === 1 };
  }

  async getVault(vaultId: string): Promise<VaultRecord | null> {
    const row = await this.db
      .prepare('SELECT vault_id, auth_hash, salt, created_at FROM vaults WHERE vault_id = ?')
      .bind(vaultId)
      .first<{ vault_id: string; auth_hash: string; salt: string; created_at: string }>();
    if (!row) return null;
    return {
      vaultId: row.vault_id,
      authHash: row.auth_hash,
      salt: row.salt,
      createdAt: row.created_at,
    };
  }

  async registerDevice(vaultId: string, deviceId: string, at: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO devices (vault_id, device_id, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(vault_id, device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`
      )
      .bind(vaultId, deviceId, at, at)
      .run();
  }

  async headSeq(vaultId: string): Promise<string> {
    const row = await this.db
      .prepare('SELECT seq FROM events WHERE vault_id = ? ORDER BY seq DESC LIMIT 1')
      .bind(vaultId)
      .first<{ seq: string }>();
    return row?.seq ?? INITIAL_SEQ;
  }

  /**
   * CAS 用「主键冲突」兜底，而不是先读后写：
   *   1. 先读 head，落后立刻拒绝；
   *   2. 所有 INSERT 放进 D1 batch（单事务）；并发推进过头时第二个批次会撞
   *      PRIMARY KEY (vault_id, seq) 整批回滚，此时重读 head 返回冲突。
   * 因此云端永远不会出现序号空洞或半批写入。
   */
  async appendEvents(
    vaultId: string,
    expectedSeq: string,
    events: NewEvent[]
  ): Promise<AppendResult> {
    const head = await this.headSeq(vaultId);
    if (head !== expectedSeq) return { ok: false, nextSeq: head, actual: head };
    if (!events.length) return { ok: true, nextSeq: head };
    const at = new Date().toISOString();
    try {
      await this.db.batch(
        events.map((e) =>
          this.db
            .prepare(
              `INSERT INTO events
               (vault_id, seq, device_id, aad, nonce, ciphertext, bytes, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(vaultId, e.seq, e.deviceId, e.aad, e.nonce, e.ciphertext, e.bytes, at)
        )
      );
    } catch {
      const actual = await this.headSeq(vaultId);
      return { ok: false, nextSeq: actual, actual };
    }
    return { ok: true, nextSeq: events[events.length - 1].seq };
  }

  async listEvents(vaultId: string, sinceSeq: string, limit: number): Promise<EventRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT seq, device_id, aad, nonce, ciphertext, bytes, created_at
         FROM events WHERE vault_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`
      )
      .bind(vaultId, sinceSeq, limit)
      .all<EventRow>();
    return results.map((r) => ({
      seq: r.seq,
      vaultId,
      deviceId: r.device_id,
      aad: r.aad,
      nonce: r.nonce,
      ciphertext: r.ciphertext,
      bytes: r.bytes,
      createdAt: r.created_at,
    }));
  }

  async putBlob(vaultId: string, objectKey: string, bytes: Uint8Array): Promise<void> {
    const key = blobPath(vaultId, objectKey);
    if (await this.bucket.head(key)) return;
    await this.bucket.put(key, bytes);
  }

  async getBlob(vaultId: string, objectKey: string): Promise<Uint8Array | null> {
    const object = await this.bucket.get(blobPath(vaultId, objectKey));
    if (!object) return null;
    return new Uint8Array(await new Response(object.body).arrayBuffer());
  }

  async hasBlob(vaultId: string, objectKey: string): Promise<boolean> {
    return !!(await this.bucket.head(blobPath(vaultId, objectKey)));
  }

  async deleteBlob(vaultId: string, objectKey: string): Promise<void> {
    await this.bucket.delete(blobPath(vaultId, objectKey));
  }
}

/** handler 用：按 expectedSeq 给一批封包分配服务端序号。 */
export function assignSeq(expectedSeq: string, count: number): { seqs: string[]; nextSeq: string } {
  const seqs = Array.from({ length: count }, (_, i) => seqAt(expectedSeq, i + 1));
  return { seqs, nextSeq: count ? seqs[seqs.length - 1] : expectedSeq };
}
