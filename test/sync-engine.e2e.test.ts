import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { createDatabase, type DbHandle, type Database } from '../src/server/db/client';
import { applyMigrations } from '../src/server/db/migrate';
import { hashPassword } from '../src/server/auth/password';
import {
  attachments,
  changeLog,
  companies,
  conflictSnapshots,
  resumes,
  syncState,
  users,
} from '../src/server/db/schema';
import { LocalBlobStore } from '../src/server/storage/blob-store';
import { recordChange } from '../src/server/sync/change-log';
import {
  blobObjectKey,
  deriveVaultKeys,
  generateRecoveryCode,
  type VaultKeys,
} from '../src/server/sync/crypto';
import { SyncEngine } from '../src/server/sync/engine';
import { hlcClock } from '../src/server/sync/hlc';
import { OfflinePackTransport } from '../src/server/sync/offline-pack';

/**
 * Sync Engine 端到端：两套独立本地库（设备 A / 设备 B）+ 一个共享离线增量包目录（哑云）。
 *
 * 离线包实现的是同一份 SyncTransport 契约（Cloudflare / CloudBase / 自建服务同构），
 * 因此这里验证的是引擎逻辑本身：基线全量首传、增量推拉、断点游标、软删除同步、
 * 跨设备 LWW 冲突留底、附件 blob 加密往返、双端 GC。
 */

const CODE = generateRecoveryCode();
const keys: VaultKeys = deriveVaultKeys(CODE);

const tmpDirs: string[] = [];
async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ca-engine-'));
  tmpDirs.push(dir);
  return dir;
}

interface Device {
  handle: DbHandle;
  db: Database;
  blobs: LocalBlobStore;
  engine: SyncEngine;
}

let packRoot: string;
let deviceA: Device;
let deviceB: Device;
let uid = '';

/** 模拟 service 层的启用动作：写 sync_state（引擎只认状态行，不负责建 vault）。 */
async function enableSyncOn(db: Database, userId: string, device: string): Promise<void> {
  await db.insert(syncState).values({
    userId,
    vaultId: keys.vaultId,
    deviceId: device,
    pushedCursor: '',
    pulledSeq: '0'.repeat(20),
    keysJson: {
      vaultId: keys.vaultId,
      salt: keys.salt,
      authKey: keys.authKey.toString('base64'),
      encKey: keys.encKey.toString('base64'),
      macKey: keys.macKey.toString('base64'),
    },
    status: 'idle',
    knownBlobs: [],
  });
}

async function blobExists(root: string, rel: string): Promise<boolean> {
  try {
    await access(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  packRoot = await tmpDir();

  // ---- 设备 A：已有业务数据，第一台设备 ----
  const handleA = await createDatabase();
  await applyMigrations(handleA.client);
  await handleA.client.exec("SET app.device_id = 'device-A'");
  const dbA = handleA.db;
  const [u] = await dbA
    .insert(users)
    .values({ email: 'engine@local.test', passwordHash: await hashPassword('pass-123456'), role: 'member' })
    .returning({ id: users.id });
  uid = u.id;

  const packA = await OfflinePackTransport.create(path.join(packRoot, 'vault'), keys.vaultId);
  const blobsA = new LocalBlobStore(path.join(packRoot, 'blobs-A'));
  deviceA = { handle: handleA, db: dbA, blobs: blobsA, engine: new SyncEngine(dbA, blobsA, packA, keys, 'device-A') };

  // 业务数据：2 简历 + 1 公司 + 1 附件（真实字节）
  await dbA.insert(resumes).values([
    { id: 'res-1', userId: uid, title: 'AI 工程师简历', payload: { data: { sections: [] } }, savedAt: Date.now() },
    { id: 'res-2', userId: uid, title: '全栈后端简历', payload: { data: { sections: [] } }, savedAt: Date.now() },
  ]);
  await dbA.insert(companies).values({ id: 'com-1', userId: uid, name: '示例科技', payload: {} });

  const put = await blobsA.put(Readable.from([Buffer.from('附件字节内容-attachment-bytes')]));
  await dbA.insert(attachments).values({
    id: 'att-1',
    userId: uid,
    sha256: put.sha256,
    mime: 'text/plain',
    bytes: put.bytes,
    originalName: 'demo.txt',
    syncState: 'local',
    hlc: hlcClock.next(),
    deviceId: 'device-A',
  });
  await recordChange(dbA, {
    userId: uid,
    entity: 'attachments',
    entityId: 'att-1',
    op: 'upsert',
    hlc: '',
    deviceId: 'device-A',
  });

  await enableSyncOn(dbA, uid, 'device-A');

  // ---- 设备 B：同账号（同 userId）、空数据，第二台设备 ----
  const handleB = await createDatabase();
  await applyMigrations(handleB.client);
  await handleB.client.exec("SET app.device_id = 'device-B'");
  const dbB = handleB.db;
  await dbB.insert(users).values({ id: uid, email: 'engine@local.test', passwordHash: 'x', role: 'member' });
  const packB = await OfflinePackTransport.open(path.join(packRoot, 'vault'));
  const blobsB = new LocalBlobStore(path.join(packRoot, 'blobs-B'));
  deviceB = { handle: handleB, db: dbB, blobs: blobsB, engine: new SyncEngine(dbB, blobsB, packB, keys, 'device-B') };
  await enableSyncOn(dbB, uid, 'device-B');
});

afterAll(async () => {
  await deviceA?.handle.close().catch(() => {});
  await deviceB?.handle.close().catch(() => {});
  while (tmpDirs.length) await rm(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('SyncEngine · 基线全量首传与跨设备加入', () => {
  it('设备 A 首次同步：基线推全部活跃行 + 附件 blob 上云', async () => {
    const stats = await deviceA.engine.syncOnce(uid);
    expect(stats.baseline).toBe(true);
    expect(stats.pushed).toBe(4); // 2 resumes + 1 company + 1 attachment
    expect(stats.blobsUploaded).toBe(1);
    expect(stats.pushedCursor).not.toBe('');
    expect(stats.headSeq).not.toBe('0'.repeat(20));

    // 云端只有密文：事件文件存在，blob 是 sealBlob 的输出
    const key = blobObjectKey(keys, (await deviceA.db.select().from(attachments).where(eq(attachments.id, 'att-1')))[0].sha256);
    expect(await blobExists(packRoot, `vault/blobs/${key}.bin`)).toBe(true);

    // 游标已持久化
    const [state] = await deviceA.db.select().from(syncState).where(eq(syncState.userId, uid));
    expect(state.pushedCursor).toBe(stats.pushedCursor);
    expect(state.pulledSeq).toBe(stats.headSeq);
  });

  it('设备 B 加入：拉全量 + 附件字节解密还原', async () => {
    const stats = await deviceB.engine.syncOnce(uid);
    expect(stats.pulled).toBe(4);
    expect(stats.applied).toBe(4);
    expect(stats.blobsDownloaded).toBe(1);

    const titles = (await deviceB.db.select().from(resumes).where(eq(resumes.userId, uid)))
      .map((r) => r.title)
      .sort();
    expect(titles).toEqual(['AI 工程师简历', '全栈后端简历']);
    expect((await deviceB.db.select().from(companies).where(eq(companies.userId, uid))).length).toBe(1);

    const [att] = await deviceB.db.select().from(attachments).where(eq(attachments.id, 'att-1'));
    expect(att.syncState).toBe('synced');
    expect(await deviceB.blobs.exists(att.sha256)).toBe(true);
    const bytes: Buffer[] = [];
    for await (const c of await deviceB.blobs.get(att.sha256)) bytes.push(Buffer.from(c as Uint8Array));
    expect(Buffer.concat(bytes).toString('utf8')).toBe('附件字节内容-attachment-bytes');

    // 回灌不产生新的本地增量（不成环）
    const bChanges = await deviceB.db.select().from(changeLog).where(eq(changeLog.userId, uid));
    expect(bChanges.length).toBe(0);
  });
});

describe('SyncEngine · 增量与软删除', () => {
  it('A 改简历 + 软删公司 → B 同步后可见', async () => {
    await deviceA.db
      .update(resumes)
      .set({ title: 'AI 工程师简历 v2' })
      .where(and(eq(resumes.userId, uid), eq(resumes.id, 'res-1')));
    await deviceA.db
      .update(companies)
      .set({ deletedAt: new Date() })
      .where(and(eq(companies.userId, uid), eq(companies.id, 'com-1')));

    const statsA = await deviceA.engine.syncOnce(uid);
    expect(statsA.baseline).toBe(false);
    expect(statsA.pushed).toBe(2);

    const statsB = await deviceB.engine.syncOnce(uid);
    expect(statsB.applied).toBe(2);

    const [r1] = await deviceB.db.select().from(resumes).where(eq(resumes.id, 'res-1'));
    expect(r1.title).toBe('AI 工程师简历 v2');
    // 软删除墓碑同步：active 查询不可见
    const activeCompanies = await deviceB.db
      .select()
      .from(companies)
      .where(and(eq(companies.userId, uid), isNull(companies.deletedAt)));
    expect(activeCompanies.length).toBe(0);
    const [tomb] = await deviceB.db.select().from(companies).where(eq(companies.id, 'com-1'));
    expect(tomb.deletedAt).not.toBeNull();
  });
});

describe('SyncEngine · 跨设备 LWW 冲突留底', () => {
  it('两边同时编辑：HLC 新者胜，落败方进 conflict_snapshots', async () => {
    // A 先编辑并同步
    await deviceA.db
      .update(resumes)
      .set({ title: 'A 的最新编辑' })
      .where(and(eq(resumes.userId, uid), eq(resumes.id, 'res-2')));
    await deviceA.engine.syncOnce(uid);

    // B 在其后编辑（本地时钟更新）并同步
    await deviceB.db
      .update(resumes)
      .set({ title: 'B 的最新编辑' })
      .where(and(eq(resumes.userId, uid), eq(resumes.id, 'res-2')));
    await deviceB.engine.syncOnce(uid);

    // A 再同步：拉到 B 的版本，LWW 判定 B 胜，A 的版本留底
    const statsA = await deviceA.engine.syncOnce(uid);
    expect(statsA.rejected + statsA.applied).toBeGreaterThan(0);

    const [res2] = await deviceA.db.select().from(resumes).where(eq(resumes.id, 'res-2'));
    expect(res2.title).toBe('B 的最新编辑');

    const snaps = await deviceA.db
      .select()
      .from(conflictSnapshots)
      .where(and(eq(conflictSnapshots.userId, uid), eq(conflictSnapshots.entity, 'resumes')));
    expect(snaps.length).toBeGreaterThan(0);
    expect(snaps.some((s) => s.status === 'pending')).toBe(true);
    expect(snaps.some((s) => (s.snapshot as any)?.title === 'A 的最新编辑')).toBe(true);
  });
});

describe('SyncEngine · 附件删除与双端 GC', () => {
  it('A 软删附件 → 云端 blob 与本地 blob 均被清理，B 收到墓碑', async () => {
    const [att] = await deviceA.db.select().from(attachments).where(eq(attachments.id, 'att-1'));
    const key = blobObjectKey(keys, att.sha256);

    await deviceA.db
      .update(attachments)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(attachments.userId, uid), eq(attachments.id, 'att-1')));
    await recordChange(deviceA.db, {
      userId: uid,
      entity: 'attachments',
      entityId: 'att-1',
      op: 'delete',
      hlc: '',
      deviceId: 'device-A',
    });

    const statsA = await deviceA.engine.syncOnce(uid);
    expect(statsA.pushed).toBe(1);
    expect(statsA.cloudBlobsGc).toBe(1);
    expect(statsA.localBlobsGc).toBe(1);

    // 云端 blob 文件已删；A 本地 blob 已删
    expect(await blobExists(packRoot, `vault/blobs/${key}.bin`)).toBe(false);
    expect(await deviceA.blobs.exists(att.sha256)).toBe(false);

    // B 同步：行变墓碑（B 本地 blob 由 B 自己的 GC 按 B 的引用集处理）
    await deviceB.engine.syncOnce(uid);
    const [attB] = await deviceB.db.select().from(attachments).where(eq(attachments.id, 'att-1'));
    expect(attB.deletedAt).not.toBeNull();
  });
});

describe('SyncEngine · 幂等与断点', () => {
  it('无变更时再同步：推拉均为 0，不产生重复事件', async () => {
    const statsA = await deviceA.engine.syncOnce(uid);
    expect(statsA.pushed).toBe(0);
    expect(statsA.pulled).toBe(0);
    const statsB = await deviceB.engine.syncOnce(uid);
    expect(statsB.pushed).toBe(0);
    expect(statsB.pulled).toBe(0);
  });

  it('游标持久化：sync_state 状态为 idle 且无错误', async () => {
    const [state] = await deviceA.db.select().from(syncState).where(eq(syncState.userId, uid));
    expect(state.status).toBe('idle');
    expect(state.lastError).toBeNull();
    expect(state.lastSyncAt).not.toBeNull();
  });
});
