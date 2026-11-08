import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, asc, eq } from 'drizzle-orm';
import { AppModule } from '../src/server/app.module';
import { DB_TOKEN } from '../src/shared/constants';
import { createDatabase, type Database } from '../src/server/db/client';
import { applyMigrations } from '../src/server/db/migrate';
import { hashPassword } from '../src/server/auth/password';
import { TenantDb } from '../src/server/tenant/tenant-db';
import { encodeHlc, parseHlc } from '../src/server/sync/hlc';
import { applyRemoteUpsert } from '../src/server/sync/sync-import';
import {
  changeLog,
  companies,
  conflictSnapshots,
  resumes,
  users,
} from '../src/server/db/schema';

/**
 * 0012 · 冲突恢复 UI 的后端语义。
 *
 * 核心不变量：恢复 = 一次新的本地写（重新领 HLC、归因本机、写 change_log），
 * 绝不是把快照里的 hlc / device_id 抄回去；被换下的当前版本必须留底，
 * 于是恢复可以来回切换、永不静默丢改动。跨用户一律 404。
 */
const A = { email: 'restore-a@local.test', password: 'aaaa-pass-123' };
const B = { email: 'restore-b@local.test', password: 'bbbb-pass-123' };

let app: NestFastifyApplication;
let db: Database;
let client: any;
let closeDb: () => Promise<void>;
let cookieA = '';
let cookieB = '';
let uidA = '';
let uidB = '';

function cookieOf(res: any): string {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return first ? String(first).split(';')[0] : '';
}

async function login(cred: { email: string; password: string }): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: cred,
  });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

function tenant(uid: string) {
  return new TenantDb(db).forUser(uid);
}

function newResume(id: string, title = '本地版本', uid = uidA) {
  return {
    id,
    userId: uid,
    title,
    payload: { data: { sections: [] } },
    savedAt: Date.now(),
  };
}

function restore(id: string, cookie = cookieA) {
  return app.inject({
    method: 'POST',
    url: `/api/sync/conflicts/${id}/restore`,
    headers: { cookie },
  });
}

function dismiss(id: string, cookie = cookieA) {
  return app.inject({
    method: 'DELETE',
    url: `/api/sync/conflicts/${id}`,
    headers: { cookie },
  });
}

function detail(id: string, cookie = cookieA) {
  return app.inject({
    method: 'GET',
    url: `/api/sync/conflicts/${id}`,
    headers: { cookie },
  });
}

/** 手工造一条快照（DB 列名键，与 ca_safe_row_json(to_jsonb(行)) 同构）。 */
function fakeRow(id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    user_id: uidA,
    id,
    title,
    kind: 'master',
    tags: [],
    is_master: false,
    payload: { data: { sections: [] } },
    saved_at: Date.now(),
    hlc: encodeHlc(Date.now() - 60_000, 0),
    device_id: 'dev-Z',
    deleted_at: null,
    ...extra,
  };
}

async function insertSnapshot(opts: {
  entity?: string;
  entityId: string;
  snapshot: Record<string, unknown>;
  resolution?: 'remote_wins' | 'local_wins' | 'restore';
  status?: 'pending' | 'restored' | 'dismissed';
  userId?: string;
}): Promise<string> {
  const [row] = await db
    .insert(conflictSnapshots)
    .values({
      userId: opts.userId ?? uidA,
      entity: opts.entity ?? 'resumes',
      entityId: opts.entityId,
      resolution: opts.resolution ?? 'remote_wins',
      winnerHlc: encodeHlc(Date.now(), 0),
      loserHlc: encodeHlc(Date.now() - 1000, 0),
      loserDeviceId: 'dev-Z',
      snapshot: opts.snapshot,
      status: opts.status ?? 'pending',
    })
    .returning({ id: conflictSnapshots.id });
  return row.id;
}

/** 用真实的跨设备 LWW 制造一条落败方快照，避免只测手工构造的理想数据。 */
async function makeRealConflict(id: string): Promise<{ snapId: string; remoteHlc: string }> {
  const [local] = await db.insert(resumes).values(newResume(id, '本地旧版本')).returning();
  const remoteHlc = encodeHlc(parseHlc(local.hlc).ms + 5000, 0);
  const applied = await applyRemoteUpsert(db, {
    entity: 'resumes',
    row: {
      id,
      userId: uidA,
      title: '远端新版本',
      payload: { data: { sections: [{ id: 'remote' }] } },
      savedAt: Date.now(),
      hlc: remoteHlc,
      deviceId: 'dev-B',
    },
  });
  expect(applied.applied).toBe(true);
  const snaps = await tenant(uidA).listConflictSnapshots({ entity: 'resumes', entityId: id });
  const snap = snaps.find((s) => s.resolution === 'remote_wins');
  if (!snap) throw new Error('未产生 remote_wins 冲突快照');
  return { snapId: snap.id, remoteHlc };
}

beforeAll(async () => {
  const handle = await createDatabase();
  db = handle.db;
  client = handle.client;
  closeDb = handle.close;
  await applyMigrations(client);

  const [a] = await db
    .insert(users)
    .values({ email: A.email, passwordHash: await hashPassword(A.password), role: 'member' })
    .returning({ id: users.id });
  const [b] = await db
    .insert(users)
    .values({ email: B.email, passwordHash: await hashPassword(B.password), role: 'member' })
    .returning({ id: users.id });
  uidA = a.id;
  uidB = b.id;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB_TOKEN)
    .useValue(db)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  cookieA = await login(A);
  cookieB = await login(B);
});

afterAll(async () => {
  if (app) await app.close();
  if (closeDb) await closeDb();
});

describe('0012 · 快照状态机', () => {
  it('迁移后快照默认 pending，且允许 restore 类型的留底', async () => {
    const id = 'struct-1';
    const snapId = await insertSnapshot({ entityId: id, snapshot: fakeRow(id, '默认状态') });
    const [row] = await db
      .select()
      .from(conflictSnapshots)
      .where(eq(conflictSnapshots.id, snapId));
    expect(row.status).toBe('pending');
    expect(row.resolvedAt).toBeNull();
    expect(row.restoredFrom).toBeNull();

    const backupId = await insertSnapshot({
      entityId: id,
      snapshot: fakeRow(id, '恢复留底'),
      resolution: 'restore',
    });
    const [backup] = await db
      .select()
      .from(conflictSnapshots)
      .where(eq(conflictSnapshots.id, backupId));
    expect(backup.resolution).toBe('restore');
  });
});

describe('0012 · 恢复是有新时钟的本地写', () => {
  it('真实 LWW 冲突恢复：内容回来、领新 HLC、归因本机、写 change_log', async () => {
    const id = 'restore-real-1';
    const { snapId, remoteHlc } = await makeRealConflict(id);

    const before = await db
      .select()
      .from(changeLog)
      .where(and(eq(changeLog.userId, uidA), eq(changeLog.entityId, id)));
    expect(before.length).toBeGreaterThan(0); // 本地创建那条已被记账

    const res = await restore(snapId);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.entity).toBe('resumes');
    expect(body.entityId).toBe(id);

    const [row] = await db
      .select()
      .from(resumes)
      .where(and(eq(resumes.userId, uidA), eq(resumes.id, id)));
    expect(row.title).toBe('本地旧版本');
    expect(row.payload).toEqual({ data: { sections: [] } });
    expect(row.hlc).toBe(body.hlc);
    expect(row.hlc).not.toBe(remoteHlc);
    expect(row.hlc > remoteHlc).toBe(true); // 恢复排在已见远端写之后
    expect(row.deviceId).toBe('local'); // 本机归因，不是快照里的远端设备
    expect(row.deletedAt).toBeNull();

    const after = await db
      .select()
      .from(changeLog)
      .where(and(eq(changeLog.userId, uidA), eq(changeLog.entityId, id)))
      .orderBy(asc(changeLog.hlc));
    expect(after.length).toBe(before.length + 1);
    expect(after[after.length - 1].op).toBe('upsert');
    expect(after[after.length - 1].payload?.row_hlc).toBe(row.hlc);
  });

  it('恢复时当前版本自动留底，原快照标记 restored，且不进同步流', async () => {
    const id = 'restore-backup-1';
    const { snapId } = await makeRealConflict(id);
    const res = await restore(snapId);
    expect(res.statusCode).toBe(200);
    const backupId = res.json().backupSnapshotId as string;
    expect(backupId).toBeTruthy();

    const [original] = await db
      .select()
      .from(conflictSnapshots)
      .where(eq(conflictSnapshots.id, snapId));
    expect(original.status).toBe('restored');
    expect(original.resolvedAt).not.toBeNull();

    const [backup] = await db
      .select()
      .from(conflictSnapshots)
      .where(eq(conflictSnapshots.id, backupId));
    expect(backup.resolution).toBe('restore');
    expect(backup.status).toBe('pending');
    expect(backup.restoredFrom).toBe(snapId);
    expect(backup.snapshot.title).toBe('远端新版本');
    expect(backup.snapshot.hlc).toBeTruthy();

    const logs = await db
      .select()
      .from(changeLog)
      .where(eq(changeLog.entity, 'conflict_snapshots'));
    expect(logs).toHaveLength(0);
  });

  it('留底快照可以再恢复，来回切换不丢任何一版', async () => {
    const id = 'restore-roundtrip-1';
    const { snapId } = await makeRealConflict(id);
    const first = await restore(snapId);
    expect(first.statusCode).toBe(200);
    expect((await tenant(uidA).getResume(id))[0].title).toBe('本地旧版本');

    const second = await restore(first.json().backupSnapshotId);
    expect(second.statusCode).toBe(200);
    const [row] = await tenant(uidA).getResume(id);
    expect(row.title).toBe('远端新版本');

    const snaps = await tenant(uidA).listConflictSnapshots({ entityId: id });
    expect(snaps.filter((s) => s.resolution === 'restore')).toHaveLength(2);
    expect(snaps.filter((s) => s.status === 'pending')).toHaveLength(1);
  });

  it('快照里的 hlc / device_id 绝不回写，敏感列也不会混进行里', async () => {
    const id = 'restore-clock-1';
    await db.insert(resumes).values(newResume(id, '当前版本'));
    const [before] = await tenant(uidA).getResume(id);
    const fakeHlc = encodeHlc(parseHlc(before.hlc).ms + 99_999, 0);
    const snapId = await insertSnapshot({
      entityId: id,
      snapshot: fakeRow(id, '远端版本', {
        hlc: fakeHlc,
        device_id: 'dev-Z',
        api_key: 'sk-this-must-not-be-restored',
      }),
    });

    const res = await restore(snapId);
    expect(res.statusCode).toBe(200);
    const [row] = await tenant(uidA).getResume(id);
    expect(row.title).toBe('远端版本');
    expect(row.hlc).not.toBe(fakeHlc);
    expect(row.hlc > before.hlc).toBe(true);
    expect(row.deviceId).toBe('local');
    expect(JSON.stringify(row)).not.toContain('sk-this-must-not-be-restored');
  });
});

describe('0012 · 状态流转与错误边界', () => {
  it('重复恢复 409；忽略后也不能再恢复', async () => {
    const id = 'restore-repeat-1';
    const { snapId } = await makeRealConflict(id);
    expect((await restore(snapId)).statusCode).toBe(200);
    const again = await restore(snapId);
    expect(again.statusCode).toBe(409);
    expect(again.json().message).toContain('已处理');

    const other = 'restore-repeat-2';
    const s2 = await insertSnapshot({
      entityId: other,
      snapshot: fakeRow(other, '忽略掉的版本'),
    });
    expect((await dismiss(s2)).statusCode).toBe(200);
    expect((await dismiss(s2)).statusCode).toBe(409);
    expect((await restore(s2)).statusCode).toBe(409);
  });

  it('忽略只改状态，快照原文仍可查；状态筛选只返回对应记录', async () => {
    const id = 'restore-dismiss-1';
    const snapId = await insertSnapshot({
      entityId: id,
      snapshot: fakeRow(id, '被忽略的原文'),
    });
    expect((await dismiss(snapId)).statusCode).toBe(200);

    const d = await detail(snapId);
    expect(d.statusCode).toBe(200);
    expect(d.json().status).toBe('dismissed');
    expect(d.json().snapshot.title).toBe('被忽略的原文');

    const q = (s: string) =>
      app.inject({
        method: 'GET',
        url: `/api/sync/conflicts?status=${s}`,
        headers: { cookie: cookieA },
      });
    const restored = (await q('restored')).json();
    const dismissed = (await q('dismissed')).json();
    expect(restored.length).toBeGreaterThan(0);
    expect(restored.every((x: any) => x.status === 'restored')).toBe(true);
    expect(dismissed.length).toBeGreaterThan(0);
    expect(dismissed.every((x: any) => x.status === 'dismissed')).toBe(true);
  });

  it('不支持恢复的实体 400；快照内容不完整 400；不存在的 id 404', async () => {
    const settingsSnap = await insertSnapshot({
      entity: 'settings',
      entityId: 'settings',
      snapshot: { payload: { theme: 'dark' } },
    });
    expect((await restore(settingsSnap)).statusCode).toBe(400);
    expect((await restore(settingsSnap)).json().message).toContain('不支持自动恢复');

    const broken = await insertSnapshot({
      entityId: 'restore-broken-1',
      snapshot: { id: 'restore-broken-1', title: '缺 payload 的坏快照' },
    });
    expect((await restore(broken)).statusCode).toBe(400);

    const missing = '00000000-0000-0000-0000-000000000000';
    expect((await restore(missing)).statusCode).toBe(404);
    expect((await dismiss(missing)).statusCode).toBe(404);
    expect((await detail(missing)).statusCode).toBe(404);
  });

  it('软删除的记录可以被快照复活（撤销删除）', async () => {
    const id = 'restore-revive-1';
    await db.insert(resumes).values(newResume(id, '被删前的版本'));
    const snapId = await insertSnapshot({
      entityId: id,
      snapshot: fakeRow(id, '被删前的版本'),
    });
    await tenant(uidA).deleteResume(id);
    expect(await tenant(uidA).getResume(id)).toHaveLength(0);

    expect((await restore(snapId)).statusCode).toBe(200);
    const [row] = await tenant(uidA).getResume(id);
    expect(row.title).toBe('被删前的版本');
    expect(row.deletedAt).toBeNull();
  });

  it('列映射对简历以外的实体同样成立（公司档案）', async () => {
    const id = 'restore-company-1';
    await db.insert(companies).values({
      id,
      userId: uidA,
      name: '现在的公司名',
      payload: { note: 'new' },
    });
    const snapId = await insertSnapshot({
      entity: 'companies',
      entityId: id,
      snapshot: {
        user_id: uidA,
        id,
        name: '旧公司名',
        payload: { note: 'old' },
        hlc: encodeHlc(Date.now(), 0),
        device_id: 'dev-Z',
        deleted_at: null,
      },
    });
    expect((await restore(snapId)).statusCode).toBe(200);
    const [row] = await db
      .select()
      .from(companies)
      .where(and(eq(companies.userId, uidA), eq(companies.id, id)));
    expect(row.name).toBe('旧公司名');
    expect(row.payload).toEqual({ note: 'old' });
    expect(row.hlc).toBeTruthy();
  });
});

describe('0012 · 隔离与鉴权', () => {
  it('跨用户一律 404：不能恢复 / 忽略 / 查看别人的快照', async () => {
    const id = 'restore-isolation-1';
    const { snapId } = await makeRealConflict(id);
    expect((await restore(snapId, cookieB)).statusCode).toBe(404);
    expect((await dismiss(snapId, cookieB)).statusCode).toBe(404);
    expect((await detail(snapId, cookieB)).statusCode).toBe(404);

    const bList = await app.inject({
      method: 'GET',
      url: `/api/sync/conflicts?entityId=${id}`,
      headers: { cookie: cookieB },
    });
    expect(bList.json()).toHaveLength(0);
    // A 的快照仍然完好且未被处理
    const [snap] = await db
      .select()
      .from(conflictSnapshots)
      .where(eq(conflictSnapshots.id, snapId));
    expect(snap.status).toBe('pending');
  });

  it('未登录访问列表 / 详情 / 恢复 / 忽略都 401', async () => {
    const id = 'restore-unauth-1';
    const { snapId } = await makeRealConflict(id);
    const urls: Array<{ method: string; url: string }> = [
      { method: 'GET', url: '/api/sync/conflicts' },
      { method: 'GET', url: `/api/sync/conflicts/${snapId}` },
      { method: 'POST', url: `/api/sync/conflicts/${snapId}/restore` },
      { method: 'DELETE', url: `/api/sync/conflicts/${snapId}` },
    ];
    for (const u of urls) {
      const res = await app.inject({ method: u.method as any, url: u.url });
      expect(res.statusCode).toBe(401);
    }
  });
});
