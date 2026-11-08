import 'reflect-metadata';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/server/app.module';
import { DB_TOKEN } from '../src/shared/constants';
import { createDatabase, type Database } from '../src/server/db/client';
import { applyMigrations } from '../src/server/db/migrate';
import { hashPassword } from '../src/server/auth/password';
import { users } from '../src/server/db/schema';
import { registerAttachmentMultipart } from '../src/server/attachments/multipart';
import { BlobTooLargeError, LocalBlobStore } from '../src/server/storage/blob-store';
import { detectMime, safeOriginalName } from '../src/server/storage/mime';
import { resolveDataDirs } from '../src/server/storage/paths';
import { HlcClock, parseHlc } from '../src/server/sync/hlc';

/* ==================================================== 纯函数：目录 / 时钟 / 类型 */

describe('本地存储基础设施', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  it('数据目录：显式 root 下 pgdata 与 blobs 并列', () => {
    expect(resolveDataDirs({ CAREER_AGENT_DATA_DIR: '/tmp/ca-data' })).toEqual({
      root: '/tmp/ca-data',
      pgdata: '/tmp/ca-data/pgdata',
      blobs: '/tmp/ca-data/blobs',
    });
  });

  it('数据目录：未设 root 时 blobs 与 PGDATA 并列', () => {
    const dirs = resolveDataDirs({ PGDATA: '/tmp/ca-data/pgdata' });
    expect(dirs.blobs).toBe('/tmp/ca-data/blobs');
  });

  it('magic number 判定，不采信扩展名；SVG 强制非 inline', () => {
    expect(detectMime(PNG)).toEqual({ mime: 'image/png', inline: true });
    expect(detectMime(Buffer.from('%PDF-1.7\n'))?.mime).toBe('application/pdf');
    expect(detectMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toEqual({
      mime: 'image/svg+xml',
      inline: false,
    });
    expect(detectMime(Buffer.from([0x00, 0x01, 0x02]))).toBeNull();
  });

  it('文件名净化：路径分隔符与控制字符全部替换', () => {
    expect(safeOriginalName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(safeOriginalName('a\r\nb')).toBe('a__b');
    expect(safeOriginalName('')).toBe('attachment');
  });

  it('HLC 单调可排序，observe 远端后本地仍更大', () => {
    const clock = new HlcClock();
    const a = clock.next();
    const b = clock.next();
    expect(a < b).toBe(true);
    const remote = String(parseHlc(String(Date.now() + 60_000)).ms).padStart(13, '0') + '.000099';
    clock.observe(remote);
    expect(clock.next() > remote).toBe(true);
  });

  it('BlobStore 拒绝非 sha256 路径（路径穿越）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-blob-'));
    try {
      const store = new LocalBlobStore(dir);
      await expect(store.get('../../etc/passwd')).rejects.toThrow(/非法 sha256/);
      await expect(store.remove('C:\\Windows\\win.ini')).rejects.toThrow(/非法 sha256/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('BlobStore 超限抛 BlobTooLargeError，且不留临时文件', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-blob-'));
    try {
      const store = new LocalBlobStore(dir);
      await expect(
        store.put(Readable.from([Buffer.alloc(11)]), { maxBytes: 10 })
      ).rejects.toBeInstanceOf(BlobTooLargeError);
      const tmp = path.join(dir, '.tmp');
      expect(fs.existsSync(tmp) ? fs.readdirSync(tmp) : []).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ==================================================== e2e：上传 / 隔离 / 同步 */

const A = { email: 'attach-a@local.test', password: 'aaaa-pass-123' };
const B = { email: 'attach-b@local.test', password: 'bbbb-pass-123' };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>hi</text></svg>');

let app: NestFastifyApplication;
let db: Database;
let closeDb: () => Promise<void>;
let cookieA = '';
let cookieB = '';
let dataDir = '';

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

/** 用 Node 内置 FormData + Response 生成 multipart body，无需额外依赖。 */
async function upload(
  cookie: string,
  bytes: Buffer,
  filename: string,
  query = '',
  declaredType?: string
) {
  const fd = new FormData();
  fd.append('file', declaredType ? new Blob([bytes], { type: declaredType }) : new Blob([bytes]), filename);
  const wrapped = new Response(fd);
  const contentType = wrapped.headers.get('content-type') || '';
  const body = Buffer.from(await wrapped.arrayBuffer());
  return app.inject({
    method: 'POST',
    url: '/api/attachments' + query,
    headers: { cookie, 'content-type': contentType },
    payload: body,
  });
}

function blobFiles(): string[] {
  const root = path.join(dataDir, 'blobs', 'sha256');
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const bucket of fs.readdirSync(root)) {
    for (const file of fs.readdirSync(path.join(root, bucket))) out.push(path.join(root, bucket, file));
  }
  return out;
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-attachments-'));
  process.env.CAREER_AGENT_DATA_DIR = dataDir;
  process.env.CAREER_AGENT_DEVICE_ID = 'test-device-a';

  const handle = await createDatabase();
  db = handle.db;
  closeDb = handle.close;
  await applyMigrations(handle.client);
  for (const u of [A, B]) {
    await db.insert(users).values({
      email: u.email,
      passwordHash: await hashPassword(u.password),
      role: 'member',
    });
  }
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB_TOKEN)
    .useValue(db)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await registerAttachmentMultipart(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  cookieA = await login(A);
  cookieB = await login(B);
});

afterAll(async () => {
  if (app) await app.close();
  if (closeDb) await closeDb();
  delete process.env.CAREER_AGENT_DATA_DIR;
  delete process.env.CAREER_AGENT_DEVICE_ID;
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('附件端点（local-first 可同步版）', () => {
  it('未登录上传 → 401', async () => {
    const res = await upload('', PNG, 'a.png');
    expect(res.statusCode).toBe(401);
  });

  it('上传 PNG → 201，元数据带 sha256 / hlc / deviceId / syncState', async () => {
    const res = await upload(cookieA, PNG, '照片.png', '?ownerType=resume&ownerId=r_1');
    expect(res.statusCode).toBe(201);
    const row = res.json();
    expect(row.id).toMatch(/^att_/);
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.mime).toBe('image/png');
    expect(row.bytes).toBe(PNG.length);
    expect(row.syncState).toBe('local');
    expect(row.remoteKey).toBeNull();
    expect(row.deviceId).toBe('test-device-a');
    expect(row.hlc).toMatch(/^\d{13}\.\d{6}$/);
    expect(row.ownerType).toBe('resume');
  });

  it('raw 读取：字节一致，安全响应头齐全', async () => {
    const res = await upload(cookieA, PNG, 'photo.png');
    const id = res.json().id;
    const raw = await app.inject({
      method: 'GET',
      url: `/api/attachments/${id}/raw`,
      headers: { cookie: cookieA },
    });
    expect(raw.statusCode).toBe(200);
    expect(Buffer.from(raw.rawPayload).equals(PNG)).toBe(true);
    expect(raw.headers['x-content-type-options']).toBe('nosniff');
    expect(String(raw.headers['content-security-policy'])).toContain('sandbox');
    expect(String(raw.headers['content-disposition'])).toContain('inline');
    expect(raw.headers['cache-control']).toBe('no-store');
  });

  it('内容寻址去重：换文件名、换用户重传同内容，blob 文件数不增加', async () => {
    const before = blobFiles().length;
    const again = await upload(cookieA, PNG, '同名不同内容.png');
    const other = await upload(cookieB, PNG, 'other.png');
    expect(again.json().sha256).toBe(other.json().sha256);
    expect(blobFiles().length).toBe(before);
  });

  it('SVG 强制 attachment + sandbox，不允许同源 inline', async () => {
    const res = await upload(cookieA, SVG, 'x.svg');
    expect(res.json().mime).toBe('image/svg+xml');
    const raw = await app.inject({
      method: 'GET',
      url: `/api/attachments/${res.json().id}/raw`,
      headers: { cookie: cookieA },
    });
    expect(String(raw.headers['content-disposition'])).toContain('attachment');
    expect(String(raw.headers['content-security-policy'])).toContain('sandbox');
  });

  it('magic number 白名单：未知二进制 400；伪造 content-type 仍按文件头判定', async () => {
    const bad = await upload(cookieA, Buffer.from([0x00, 0x01, 0x02, 0x03]), 'fake.png', '', 'image/png');
    expect(bad.statusCode).toBe(400);
    const spoof = await upload(cookieA, Buffer.from('plain text here'), 'fake.png', '', 'image/png');
    expect(spoof.statusCode).toBe(201);
    expect(spoof.json().mime).toBe('text/plain');
    const raw = await app.inject({
      method: 'GET',
      url: `/api/attachments/${spoof.json().id}/raw`,
      headers: { cookie: cookieA },
    });
    expect(String(raw.headers['content-disposition'])).toContain('attachment');
  });

  it('跨用户：别人的附件 get / raw / delete 一律 404，不泄露存在性', async () => {
    const id = (await upload(cookieA, PNG, 'private.png')).json().id;
    for (const req of [
      { method: 'GET', url: `/api/attachments/${id}` },
      { method: 'GET', url: `/api/attachments/${id}/raw` },
      { method: 'DELETE', url: `/api/attachments/${id}` },
    ]) {
      const res = await app.inject({ ...req, headers: { cookie: cookieB } } as any);
      expect(res.statusCode).toBe(404);
    }
    const listB = await app.inject({ method: 'GET', url: '/api/attachments', headers: { cookie: cookieB } });
    expect(listB.json().some((r: any) => r.id === id)).toBe(false);
  });

  it('路径穿越防护：非 sha256 的 id 只会被当 id 查询，返回 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/attachments/..%2F..%2Fetc%2Fpasswd/raw',
      headers: { cookie: cookieA },
    });
    expect([404, 400]).toContain(res.statusCode);
  });

  it('软删除：墓碑 + outbox，删除后不可读，但 change_log 仍带 delete', async () => {
    const id = (await upload(cookieA, PNG, 'to-delete.png')).json().id;
    const before = await app.inject({
      method: 'GET',
      url: '/api/attachments/sync/changes',
      headers: { cookie: cookieA },
    });
    const cursor = before.json().nextCursor;

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/attachments/${id}`,
      headers: { cookie: cookieA },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().ok).toBe(true);

    const gone = await app.inject({
      method: 'GET',
      url: `/api/attachments/${id}/raw`,
      headers: { cookie: cookieA },
    });
    expect(gone.statusCode).toBe(404);

    const after = await app.inject({
      method: 'GET',
      url: `/api/attachments/sync/changes?since=${encodeURIComponent(cursor)}`,
      headers: { cookie: cookieA },
    });
    const ops = after.json().changes as Array<any>;
    expect(ops.length).toBeGreaterThanOrEqual(1);
    expect(ops.some((c) => c.entityId === id && c.op === 'delete')).toBe(true);
    // blob 文件仍在：本地删除不等于云端删除，等引用计数 GC
    expect(blobFiles().length).toBeGreaterThan(0);
  });

  it('增量同步：upsert / delete 都进 outbox，按 hlc 游标续拉为空', async () => {
    const all = await app.inject({
      method: 'GET',
      url: '/api/attachments/sync/changes',
      headers: { cookie: cookieA },
    });
    const rows = all.json().changes as Array<any>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.op === 'upsert')).toBe(true);
    expect(rows.every((r) => r.userId === rows[0].userId)).toBe(true);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].hlc <= rows[i].hlc).toBe(true);

    const next = await app.inject({
      method: 'GET',
      url: `/api/attachments/sync/changes?since=${encodeURIComponent(all.json().nextCursor)}`,
      headers: { cookie: cookieA },
    });
    expect(next.json().changes).toHaveLength(0);
  });

  it('同步增量按用户隔离：B 的游标表不含 A 的变更', async () => {
    const a = await app.inject({ method: 'GET', url: '/api/attachments/sync/changes', headers: { cookie: cookieA } });
    const b = await app.inject({ method: 'GET', url: '/api/attachments/sync/changes', headers: { cookie: cookieB } });
    const aIds = new Set((a.json().changes as Array<any>).map((r) => r.entityId));
    for (const r of b.json().changes as Array<any>) expect(aIds.has(r.entityId)).toBe(false);
  });
});
