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
import { applyRemoteUpsert, withSyncImport } from '../src/server/sync/sync-import';
import {
  changeLog,
  conflictSnapshots,
  resumes,
  tracker,
  trackerChatEvents,
  users,
} from '../src/server/db/schema';

/**
 * 0011 · 本地冲突地基：HLC 时钟 / 软删除墓碑 / 跨设备 LWW 快照 / chat 事件流。
 *
 * 这些测试不是「云端同步」——云端账号、Sync Engine、加密都还没做。
 * 验证的是：将来云端推一行变更下来时，本地已经能安全接住，不丢改动、不成环、不串用户。
 */
const A = { email: 'sync-a@local.test', password: 'aaaa-pass-123' };
const B = { email: 'sync-b@local.test', password: 'bbbb-pass-123' };

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

function newResume(id: string, uid = uidA, title = '本地版本') {
  return { id, userId: uid, title, payload: { data: { sections: [] } }, savedAt: Date.now() };
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

describe('0011 · 业务行 HLC 时钟', () => {
  it('本地写自动领号、严格单调；墙钟列保留但只用于展示', async () => {
    const ids = ['hlc-1', 'hlc-2', 'hlc-3'];
    for (const id of ids) await db.insert(resumes).values(newResume(id));

    const rows = await db
      .select()
      .from(resumes)
      .where(eq(resumes.userId, uidA))
      .orderBy(asc(resumes.hlc));
    const mine = rows.filter((r) => ids.includes(r.id));
    expect(mine).toHaveLength(3);
    for (let i = 1; i < mine.length; i++) expect(mine[i - 1].hlc < mine[i].hlc).toBe(true);
    expect(mine.every((r) => r.deviceId === 'local')).toBe(true); // 测试环境未设 app.device_id
    expect(mine.every((r) => r.updatedAt instanceof Date)).toBe(true);
    expect(mine.every((r) => r.deletedAt === null)).toBe(true);
  });

  it('回灌远端时钟后，后续本地写一定排在已见远端写之后（observe）', async () => {
    const remote = encodeHlc(Date.now() + 500, 7);
    const ok = await applyRemoteUpsert(db, {
      entity: 'resumes',
      row: {
        id: 'hlc-remote-future',
        userId: uidA,
        title: '远端未来写',
        payload: {},
        savedAt: Date.now(),
        hlc: remote,
        deviceId: 'dev-future',
      },
    });
    expect(ok.applied).toBe(true);

    await db.insert(resumes).values(newResume('hlc-after-remote'));
    const after = await db.select().from(resumes).where(eq(resumes.id, 'hlc-after-remote'));
    expect(after[0].hlc > remote).toBe(true);
  });
});

describe('0011 · 软删除墓碑', () => {
  it('API 删除后列表/详情不可见，库中留墓碑，增量是带 row_hlc 的 delete 事件', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/resumes',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      payload: { title: '软删除验证', payload: { data: { sections: [] } } },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const before = await db
      .select()
      .from(changeLog)
      .where(eq(changeLog.userId, uidA))
      .orderBy(asc(changeLog.hlc));
    const cursor = before.length ? before[before.length - 1].hlc : '';

    const del = await app.inject({ method: 'DELETE', url: `/api/resumes/${id}`, headers: { cookie: cookieA } });
    expect(del.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/resumes/${id}`, headers: { cookie: cookieA } })).statusCode).toBe(404);
    const list = await app.inject({ method: 'GET', url: '/api/resumes', headers: { cookie: cookieA } });
    expect(list.json().some((r: any) => r.id === id)).toBe(false);

    const rows = await db.select().from(resumes).where(and(eq(resumes.userId, uidA), eq(resumes.id, id)));
    expect(rows).toHaveLength(1);
    expect(rows[0].deletedAt).not.toBeNull();

    const changes = await db
      .select()
      .from(changeLog)
      .where(and(eq(changeLog.userId, uidA), eq(changeLog.entityId, id)))
      .orderBy(asc(changeLog.hlc));
    const tombstone = changes.filter((c) => c.hlc > cursor && c.op === 'delete');
    expect(tombstone).toHaveLength(1);
    expect(tombstone[0].payload.row_hlc).toBeTruthy();
    expect(tombstone[0].payload.deleted_at).toBeTruthy();
    expect(tombstone[0].payload.table).toBe('resumes');
  });

  it('软删后同 id 重建会复活（不撞复合主键），且时钟继续推进', async () => {
    const t = tenant(uidA);
    const first = await t.createResume({ id: 'revive-1', title: '初版', payload: { v: 1 } });
    const hlcBefore = first[0].hlc;
    await t.deleteResume('revive-1');
    expect(await t.getResume('revive-1')).toHaveLength(0);

    const again = await t.createResume({ id: 'revive-1', title: '复活版', payload: { v: 2 } });
    expect(again).toHaveLength(1);
    expect(again[0].title).toBe('复活版');
    expect(again[0].deletedAt).toBeNull();
    expect(again[0].hlc > hlcBefore).toBe(true);
  });

  it('物理删除仍产生 delete 墓碑（兼容级联清理与版本降采样）', async () => {
    const id = 'phys-del-1';
    await db.insert(resumes).values(newResume(id));
    await db.delete(resumes).where(and(eq(resumes.userId, uidA), eq(resumes.id, id)));
    const rows = await db
      .select()
      .from(changeLog)
      .where(and(eq(changeLog.userId, uidA), eq(changeLog.entityId, id)));
    expect(rows.some((c) => c.op === 'delete')).toBe(true);
  });
});

describe('0011 · 跨设备 LWW 与冲突快照', () => {
  it('远端胜覆盖 + 本地胜拒绝，两个方向都把落败方整行留底', async () => {
    const id = 'lww-resume-1';
    const local = await db.insert(resumes).values(newResume(id, uidA, '本地编辑')).returning();
    const localHlc = local[0].hlc;
    const baseMs = parseHlc(localHlc).ms;

    // 远端更晚：覆盖本地，但本地旧版本进快照（用相对值，避免被先前 observe 推高的时钟干扰）
    const newer = encodeHlc(baseMs + 100, 0);
    const win = await applyRemoteUpsert(db, {
      entity: 'resumes',
      row: {
        id, userId: uidA, title: '远端新编辑', payload: {}, savedAt: Date.now(),
        hlc: newer, deviceId: 'dev-B',
      },
    });
    expect(win.applied).toBe(true);
    const row = await db.select().from(resumes).where(and(eq(resumes.userId, uidA), eq(resumes.id, id)));
    expect(row[0].title).toBe('远端新编辑');
    expect(row[0].deviceId).toBe('dev-B');

    // 第三台设备带来更旧的写：被 LWW 拒绝，远端整行进快照
    const older = encodeHlc(baseMs - 500, 0);
    const lose = await applyRemoteUpsert(db, {
      entity: 'resumes',
      row: {
        id, userId: uidA, title: '远端旧编辑', payload: {}, savedAt: Date.now(),
        hlc: older, deviceId: 'dev-C',
      },
    });
    expect(lose.applied).toBe(false);
    const still = await db.select().from(resumes).where(and(eq(resumes.userId, uidA), eq(resumes.id, id)));
    expect(still[0].title).toBe('远端新编辑');

    const snaps = await tenant(uidA).listConflictSnapshots({ entity: 'resumes', entityId: id });
    expect(snaps).toHaveLength(2);
    const remoteWins = snaps.find((s) => s.resolution === 'remote_wins');
    const localWins = snaps.find((s) => s.resolution === 'local_wins');
    expect(remoteWins?.snapshot.title).toBe('本地编辑');
    expect(remoteWins?.loserHlc).toBe(localHlc);
    expect(localWins?.snapshot.title).toBe('远端旧编辑');
    expect(localWins?.loserHlc).toBe(older);
    expect(localWins?.winnerHlc).toBe(newer);
  });

  it('同一设备重复回灌不做冲突判定（幂等重试），敏感列不进快照', async () => {
    const id = 'lww-idempotent-1';
    const hlc = encodeHlc(Date.now(), 0);
    // 先让这行本身就来自 dev-B（回灌窗口内新建），后面两次同设备重试才不算并发冲突。
    await withSyncImport(db, async () => {
      await db.insert(resumes).values({ ...newResume(id), hlc, deviceId: 'dev-B' });
    });
    const row = {
      id, userId: uidA, title: '同一设备重试', payload: {}, savedAt: Date.now(),
      hlc, deviceId: 'dev-B',
    };
    expect((await applyRemoteUpsert(db, { entity: 'resumes', row })).applied).toBe(true);
    expect((await applyRemoteUpsert(db, { entity: 'resumes', row })).applied).toBe(true);
    const snaps = await tenant(uidA).listConflictSnapshots({ entityId: id });
    expect(snaps).toHaveLength(0);

    const safe = await client.query(
      "SELECT ca_safe_row_json('{\"api_key\":\"sk-secret\",\"title\":\"ok\"}'::jsonb) AS j"
    );
    expect(JSON.stringify(safe.rows[0].j)).not.toContain('sk-secret');
    expect(safe.rows[0].j.title).toBe('ok');
  });
});

describe('0011 · 回灌闭环与 chat append-only', () => {
  it('回灌窗口内不写 change_log（防云端变更被推回成环），窗口外恢复正常记账', async () => {
    const idSilent = 'silent-import-1';
    await withSyncImport(db, async () => {
      await db.insert(resumes).values({
        ...newResume(idSilent), hlc: encodeHlc(Date.now() + 2000, 0), deviceId: 'dev-B',
      });
    });
    const silent = await db
      .select()
      .from(changeLog)
      .where(and(eq(changeLog.userId, uidA), eq(changeLog.entityId, idSilent)));
    expect(silent).toHaveLength(0);

    // GUC 必须已被 finally 复位
    const afterWindow = 'after-window-1';
    await db.insert(resumes).values(newResume(afterWindow));
    const normal = await db
      .select()
      .from(changeLog)
      .where(and(eq(changeLog.userId, uidA), eq(changeLog.entityId, afterWindow)));
    expect(normal).toHaveLength(1);
  });

  it('tracker.payload.chat[] 整块更新只追加新消息，事件进增量且带消息本体', async () => {
    const id = 'trk-chat-1';
    const chat = [
      { role: 'me', text: '你好', ts: 1 },
      { role: 'hr', text: '收到', ts: 2 },
    ];
    await db.insert(tracker).values({ id, userId: uidA, companyId: null, payload: { chat } });
    await db.update(tracker).set({
      payload: { chat: [...chat, { role: 'me', text: '谢谢', ts: 3 }] },
    }).where(and(eq(tracker.userId, uidA), eq(tracker.id, id)));

    const events = await tenant(uidA).listTrackerChatEvents(id);
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.hlc && e.deviceId === 'local')).toBe(true);

    const logged = await db
      .select()
      .from(changeLog)
      .where(and(eq(changeLog.userId, uidA), eq(changeLog.entity, 'tracker_chat_events')));
    expect(logged.length).toBe(3);
    expect(logged.every((c) => c.payload.message && c.payload.dedupe_key)).toBe(true);
  });

  it('跨用户隔离：冲突快照与 chat 事件只属于本人', async () => {
    const bEvents = await tenant(uidB).listTrackerChatEvents('trk-chat-1');
    expect(bEvents).toHaveLength(0);
    const bSnaps = await tenant(uidB).listConflictSnapshots({ entityId: 'lww-resume-1' });
    expect(bSnaps).toHaveLength(0);

    // 同 id 的 chat 消息在 B 名下不会与 A 去重串味
    await db.insert(tracker).values({
      id: 'trk-chat-b', userId: uidB, companyId: null,
      payload: { chat: [{ role: 'me', text: '你好', ts: 1 }] },
    });
    expect(await tenant(uidA).listTrackerChatEvents('trk-chat-1')).toHaveLength(3);
    expect(await tenant(uidB).listTrackerChatEvents('trk-chat-b')).toHaveLength(1);
    expect((await db.select().from(trackerChatEvents).where(eq(trackerChatEvents.userId, uidB)))).toHaveLength(1);
  });

  it('conflict_snapshots 本身不进 change_log，避免快照被同步放大', async () => {
    const rows = await db
      .select()
      .from(changeLog)
      .where(eq(changeLog.entity, 'conflict_snapshots'));
    expect(rows).toHaveLength(0);
  });
});

describe('0011 · 只读审计接口', () => {
  it('未登录访问 401；登录后冲突快照与 chat 事件仍按 user 隔离', async () => {
    for (const url of ['/api/sync/conflicts', '/api/sync/chat-events?trackerId=trk-chat-1']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    }

    const aConflicts = await app.inject({
      method: 'GET',
      url: '/api/sync/conflicts?entity=resumes&entityId=lww-resume-1',
      headers: { cookie: cookieA },
    });
    expect(aConflicts.statusCode).toBe(200);
    expect(aConflicts.json()).toHaveLength(2);

    const bConflicts = await app.inject({
      method: 'GET',
      url: '/api/sync/conflicts?entity=resumes&entityId=lww-resume-1',
      headers: { cookie: cookieB },
    });
    expect(bConflicts.json()).toHaveLength(0);

    const aChat = await app.inject({
      method: 'GET',
      url: '/api/sync/chat-events?trackerId=trk-chat-1',
      headers: { cookie: cookieA },
    });
    expect(aChat.json()).toHaveLength(3);
    const bChat = await app.inject({
      method: 'GET',
      url: '/api/sync/chat-events?trackerId=trk-chat-1',
      headers: { cookie: cookieB },
    });
    expect(bChat.json()).toHaveLength(0);

    const missing = await app.inject({
      method: 'GET',
      url: '/api/sync/chat-events',
      headers: { cookie: cookieA },
    });
    expect(missing.json()).toEqual([]);
  });
});
