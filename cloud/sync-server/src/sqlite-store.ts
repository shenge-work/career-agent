/**
 * CVM / 任意 Linux 服务器上的哑云持久化：SQLite 存授权哈希 + 密文事件流，磁盘存已加密 blob。
 *
 * 与 Cloudflare D1R2Store 实现同一份 SyncStore 接口，因此 handler 逻辑零改动。
 * 选 SQLite 而非 Postgres：单文件、零服务进程、2 核 2G 轻量服务器也跑得动，且
 * seq 是 20 位定长数字字符串，字典序 == 数值序，TEXT 列直接 ORDER BY / 比较即可。
 *
 * 云端永远看不到明文：events 表里只有 aad（路由信息）与密文；blob 文件也是密文。
 */

import Database from 'better-sqlite3';
import { promises as fsp } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  INITIAL_SEQ,
  OBJECT_KEY_RE,
  parseSeq,
} from '../../sync-worker/src/protocol';
import {
  type AppendResult,
  type EventRecord,
  type NewEvent,
  type SyncStore,
  type VaultRecord,
} from '../../sync-worker/src/store';

export class SqliteSyncStore implements SyncStore {
  private readonly db: Database.Database;
  private readonly blobDir: string;

  constructor(dbPath: string, blobDir: string) {
    this.blobDir = blobDir;
    mkdirSync(blobDir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vaults (
        vault_id   TEXT PRIMARY KEY,
        auth_hash  TEXT NOT NULL,
        salt       TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        vault_id      TEXT NOT NULL,
        device_id     TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at  TEXT NOT NULL,
        PRIMARY KEY (vault_id, device_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        vault_id   TEXT    NOT NULL,
        seq        TEXT    NOT NULL,
        device_id  TEXT    NOT NULL,
        aad        TEXT    NOT NULL,
        nonce      TEXT    NOT NULL,
        ciphertext TEXT    NOT NULL,
        bytes      INTEGER NOT NULL,
        created_at TEXT    NOT NULL,
        PRIMARY KEY (vault_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_events_vault_seq ON events (vault_id, seq);
    `);
  }

  async createVault(vault: VaultRecord): Promise<{ created: boolean }> {
    const res = this.db
      .prepare(
        'INSERT OR IGNORE INTO vaults (vault_id, auth_hash, salt, created_at) VALUES (?, ?, ?, ?)'
      )
      .run(vault.vaultId, vault.authHash, vault.salt, vault.createdAt);
    return { created: res.changes === 1 };
  }

  async getVault(vaultId: string): Promise<VaultRecord | null> {
    const row = this.db
      .prepare('SELECT vault_id, auth_hash, salt, created_at FROM vaults WHERE vault_id = ?')
      .get(vaultId) as
      | { vault_id: string; auth_hash: string; salt: string; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      vaultId: row.vault_id,
      authHash: row.auth_hash,
      salt: row.salt,
      createdAt: row.created_at,
    };
  }

  async registerDevice(vaultId: string, deviceId: string, at: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO devices (vault_id, device_id, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(vault_id, device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`
      )
      .run(vaultId, deviceId, at, at);
  }

  async headSeq(vaultId: string): Promise<string> {
    const row = this.db
      .prepare('SELECT seq FROM events WHERE vault_id = ? ORDER BY seq DESC LIMIT 1')
      .get(vaultId) as { seq: string } | undefined;
    return row?.seq ?? INITIAL_SEQ;
  }

  /**
   * CAS 用「主键 (vault_id, seq) 冲突」兜底：
   *   1. 先读 head，落后立刻拒绝；
   *   2. 整批插入放进一个事务，并发推进过头时第二个事务撞主键整批回滚；
   *   3. 事务内不依赖已读 head，因此绝不会出现序号空洞或半批写入。
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
    const insert = this.db.prepare(
      `INSERT INTO events (vault_id, seq, device_id, aad, nonce, ciphertext, bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const txn = this.db.transaction((rows: unknown[][]) => {
      for (const row of rows) insert.run(...(row as never[]));
    });
    try {
      txn(
        events.map((e) => [
          vaultId,
          e.seq,
          e.deviceId,
          e.aad,
          e.nonce,
          e.ciphertext,
          e.bytes,
          at,
        ])
      );
      return { ok: true, nextSeq: events[events.length - 1].seq };
    } catch {
      const actual = await this.headSeq(vaultId);
      return { ok: false, nextSeq: actual, actual };
    }
  }

  async listEvents(vaultId: string, sinceSeq: string, limit: number): Promise<EventRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT seq, device_id, aad, nonce, ciphertext, bytes, created_at
         FROM events WHERE vault_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`
      )
      .all(vaultId, sinceSeq, limit) as Array<{
      seq: string;
      device_id: string;
      aad: string;
      nonce: string;
      ciphertext: string;
      bytes: number;
      created_at: string;
    }>;
    return rows.map((r) => ({
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

  private blobFilePath(vaultId: string, objectKey: string): string {
    if (!OBJECT_KEY_RE.test(objectKey)) throw new Error('非法 objectKey');
    return path.join(this.blobDir, vaultId, objectKey);
  }

  async putBlob(vaultId: string, objectKey: string, bytes: Uint8Array): Promise<void> {
    const fp = this.blobFilePath(vaultId, objectKey);
    try {
      await fsp.access(fp);
      return; // 内容寻址：重传幂等
    } catch {
      // 不存在，继续写
    }
    await fsp.mkdir(path.dirname(fp), { recursive: true });
    await fsp.writeFile(fp, Buffer.from(bytes));
  }

  async getBlob(vaultId: string, objectKey: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await fsp.readFile(this.blobFilePath(vaultId, objectKey)));
    } catch {
      return null;
    }
  }

  async hasBlob(vaultId: string, objectKey: string): Promise<boolean> {
    try {
      await fsp.access(this.blobFilePath(vaultId, objectKey));
      return true;
    } catch {
      return false;
    }
  }

  async deleteBlob(vaultId: string, objectKey: string): Promise<void> {
    await fsp.rm(this.blobFilePath(vaultId, objectKey), { force: true });
  }

  close(): void {
    this.db.close();
  }
}
