import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { handleSyncRequest } from '../cloud/sync-worker/src/handler';
import { D1R2Store } from '../cloud/sync-worker/src/store';
import { INITIAL_SEQ, formatSeq, SeqConflictError } from '../src/server/sync/transport';
import {
  blobObjectKey,
  deriveVaultKeys,
  generateRecoveryCode,
  openBlob,
  openEvent,
  sealBlob,
  sealEvent,
} from '../src/server/sync/crypto';
import { CloudflareTransport } from '../src/server/sync/cloudflare-transport';

/**
 * D1R2Store 是真正部署到 Cloudflare 的实现。这里用「只认 store.ts 实际发出的那几条 SQL」
 * 的内存 D1 + R2 替身跑完整链路：SQL 写错、列名对不上、batch 未回滚都会立刻暴露。
 * 它不是 SQLite 兼容层，只验证生产 Store 的控制流与契约。
 */

const BASE = 'https://sync.example.test';
const SHA = 'c'.repeat(64);

interface AnyRow {
  [key: string]: unknown;
}

class MockD1 {
  readonly vaults = new Map<string, AnyRow>();
  readonly devices: AnyRow[] = [];
  events: AnyRow[] = [];
  /** 模拟并发下 D1 batch 撞 (vault_id, seq) 主键。 */
  failNextBatch = false;

  prepare(sql: string) {
    return { bind: (...args: unknown[]) => this.statement(sql.replace(/\s+/g, ' ').trim(), args) };
  }

  private statement(sql: string, args: unknown[]): any {
    return {
      __sql: sql,
      __args: args,
      run: async () => this.run(sql, args),
      first: async () => this.first(sql, args),
      all: async () => ({ results: this.all(sql, args) }),
    };
  }

  /** D1.batch 的语义：任一语句抛错，整批回滚。 */
  async batch(statements: any[]): Promise<unknown[]> {
    const snapshot = [...this.events];
    try {
      if (this.failNextBatch) {
        this.failNextBatch = false;
        throw new Error('UNIQUE constraint failed: events.vault_id, events.seq');
      }
      for (const statement of statements) await statement.run();
    } catch (err) {
      this.events = snapshot;
      throw err;
    }
    return [];
  }

  private run(sql: string, args: unknown[]): { meta: { changes: number } } {
    if (sql.startsWith('INSERT OR IGNORE INTO vaults')) {
      const [vaultId, authHash, salt, createdAt] = args;
      if (this.vaults.has(String(vaultId))) return { meta: { changes: 0 } };
      this.vaults.set(String(vaultId), {
        vault_id: vaultId,
        auth_hash: authHash,
        salt,
        created_at: createdAt,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('INSERT INTO devices')) {
      const [vaultId, deviceId, firstSeen, lastSeen] = args;
      const found = this.devices.find(
        (d) => d.vault_id === vaultId && d.device_id === deviceId
      );
      if (found) found.last_seen_at = lastSeen;
      else this.devices.push({ vault_id: vaultId, device_id: deviceId, first_seen_at: firstSeen, last_seen_at: lastSeen });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('INSERT INTO events')) {
      const [vaultId, seq, deviceId, aad, nonce, ciphertext, bytes, createdAt] = args;
      if (this.events.some((e) => e.vault_id === vaultId && e.seq === seq)) {
        throw new Error('UNIQUE constraint failed: events.vault_id, events.seq');
      }
      this.events.push({
        vault_id: vaultId,
        seq,
        device_id: deviceId,
        aad,
        nonce,
        ciphertext,
        bytes,
        created_at: createdAt,
      });
      return { meta: { changes: 1 } };
    }
    throw new Error(`MockD1 未识别的写入 SQL: ${sql}`);
  }

  private first(sql: string, args: unknown[]): AnyRow | null {
    if (sql.startsWith('SELECT vault_id, auth_hash, salt, created_at FROM vaults')) {
      return this.vaults.get(String(args[0])) || null;
    }
    if (sql.startsWith('SELECT seq FROM events WHERE vault_id = ? ORDER BY seq DESC LIMIT 1')) {
      const rows = this.events
        .filter((e) => e.vault_id === args[0])
        .sort((a, b) => String(a.seq).localeCompare(String(b.seq)));
      return rows.length ? { seq: rows[rows.length - 1].seq } : null;
    }
    throw new Error(`MockD1 未识别的单行 SQL: ${sql}`);
  }

  private all(sql: string, args: unknown[]): AnyRow[] {
    if (sql.startsWith('SELECT seq, device_id, aad, nonce, ciphertext, bytes, created_at FROM events')) {
      const [vaultId, since, limit] = args;
      return this.events
        .filter((e) => e.vault_id === vaultId && String(e.seq) > String(since))
        .sort((a, b) => String(a.seq).localeCompare(String(b.seq)))
        .slice(0, Number(limit));
    }
    throw new Error(`MockD1 未识别的多行 SQL: ${sql}`);
  }
}

class MockR2 {
  readonly objects = new Map<string, Uint8Array>();

  async put(key: string, value: unknown): Promise<void> {
    if (this.objects.has(key)) return;
    this.objects.set(key, new Uint8Array(value as Uint8Array));
  }

  async get(key: string): Promise<{ body: ReadableStream; size: number } | null> {
    const value = this.objects.get(key);
    if (!value) return null;
    return { body: new Response(value).body!, size: value.length };
  }

  async head(key: string): Promise<{ size: number } | null> {
    const value = this.objects.get(key);
    return value ? { size: value.length } : null;
  }
}

function makeSetup() {
  const db = new MockD1();
  const bucket = new MockR2();
  const store = new D1R2Store(db as any, bucket as any);
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handleSyncRequest(new Request(url, init), { store });
  }) as typeof fetch;
  return { db, bucket, store, fetchImpl };
}

function event(entityId: string, device = 'device-A') {
  return {
    localCursor: '00000170000000000.000000',
    entity: 'resumes',
    entityId,
    op: 'upsert' as const,
    rowHlc: '00000170000000001.000002',
    deviceId: device,
    row: { id: entityId, title: `简历 ${entityId}` },
    blobKeys: [],
  };
}

describe('D1 + R2 生产 Store', () => {
  it('建 vault / 推拉事件 / 密文还原走真实 D1 SQL 与 R2 绑定', async () => {
    const { db, bucket, fetchImpl } = makeSetup();
    const keys = deriveVaultKeys(generateRecoveryCode());
    const transport = await CloudflareTransport.createVault({
      baseUrl: BASE,
      keys,
      deviceId: 'device-A',
      fetchImpl,
    });
    expect(db.vaults.get(keys.vaultId)!.auth_hash).not.toBe(keys.authKey.toString('hex'));
    expect(db.devices).toHaveLength(1);

    const envelopes = ['r1', 'r2'].map((id, i) =>
      sealEvent(keys, event(id), { deviceId: 'device-A', batchId: 'b1', index: i })
    );
    const pushed = await transport.push(envelopes, INITIAL_SEQ);
    expect(pushed.nextSeq).toBe(formatSeq(2n));
    expect(db.events.map((e) => e.seq)).toEqual([formatSeq(1n), formatSeq(2n)]);
    expect(JSON.stringify(db.events)).not.toContain('简历 r1');

    const pulled = await transport.pull(INITIAL_SEQ);
    expect(openEvent(keys, pulled.envelopes[1]).event.row?.title).toBe('简历 r2');
    expect((await transport.head()).seq).toBe(formatSeq(2n));

    const objectKey = blobObjectKey(keys, SHA);
    const sealed = sealBlob(keys, SHA, Buffer.from('D1/R2 blob'));
    await transport.putBlob(objectKey, Readable.from([sealed]), sealed.length);
    const chunks: Buffer[] = [];
    for await (const chunk of await transport.getBlob(objectKey)) chunks.push(Buffer.from(chunk));
    expect(openBlob(keys, SHA, Buffer.concat(chunks)).toString('utf8')).toBe('D1/R2 blob');
    expect(bucket.objects.size).toBe(1);
  });

  it('CAS 落后游标拒绝；batch 主键冲突时整批回滚且不留序号空洞', async () => {
    const { db, store, fetchImpl } = makeSetup();
    const keys = deriveVaultKeys(generateRecoveryCode());
    const transport = await CloudflareTransport.createVault({
      baseUrl: BASE,
      keys,
      deviceId: 'device-A',
      fetchImpl,
    });
    await transport.push([sealEvent(keys, event('r1'), { deviceId: 'device-A', batchId: 'b1', index: 0 })], INITIAL_SEQ);
    await expect(
      transport.push(
        [sealEvent(keys, event('r2'), { deviceId: 'device-A', batchId: 'b2', index: 0 })],
        INITIAL_SEQ
      )
    ).rejects.toBeInstanceOf(SeqConflictError);
    expect(db.events).toHaveLength(1);

    // 模拟并发：head 检查通过后，另一请求抢先占用 seq=2 → D1 batch 撞主键整批回滚
    db.failNextBatch = true;
    const conflict = await store.appendEvents(keys.vaultId, formatSeq(1n), [
      { seq: formatSeq(2n), deviceId: 'device-A', aad: '{}', nonce: 'x', ciphertext: 'y', bytes: 1 },
      { seq: formatSeq(3n), deviceId: 'device-A', aad: '{}', nonce: 'x', ciphertext: 'y', bytes: 1 },
    ]);
    expect(conflict.ok).toBe(false);
    expect(conflict.actual).toBe(formatSeq(1n)); // 重读 head 后仍是 1，没有序号空洞
    expect(db.events).toHaveLength(1);
  });
});
