import 'reflect-metadata';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DbHandle } from '../src/server/db/client';
import { applyMigrations } from '../src/server/db/migrate';
import {
  backupSource,
  importV1,
  listJsonFiles,
  readV1Source,
  sha256,
  stableStringify,
  type V1Snapshot,
} from '../src/server/db/import-v1';

let root: string;
let backupRoot: string;
let snapshot: V1Snapshot;
let handle: DbHandle;
let userId: string;
let otherUserId: string;

function write(rel: string, value: unknown): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(value, null, 2) + '\n');
}

async function insertUser(email: string): Promise<string> {
  const res = await handle.client.query(
    "INSERT INTO users (email, password_hash, role) VALUES ($1, '$argon2$test-only', 'admin') RETURNING id",
    [email]
  );
  return String(res.rows[0].id);
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-v1-fixture-'));
  backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-v1-backup-'));

  const masterDoc = {
    data: { name: '测试候选人', sections: [{ id: 's1', title: '个人优势', items: ['五年前端经验'] }] },
    fonts: { base: { val: 11 } },
    spacing: { name: { mt: 0, mb: 4 } },
    v: 8,
    savedAt: 1700000000000,
  };
  const derivedDoc = { ...masterDoc, data: { ...masterDoc.data, name: '测试候选人（定制）' }, savedAt: 1700000000001 };

  write('resumes/index.json', {
    active: 'res_a',
    items: [
      { id: 'res_a', title: '主简历', isMaster: true, tags: ['主'], updatedAt: 1700000000000 },
      {
        id: 'res_b',
        title: 'Agent 岗',
        kind: 'derived',
        parentId: 'res_a',
        jobId: 'jd_1',
        jdText: '负责 Agent 应用研发',
        tags: ['甲公司'],
        updatedAt: 1700000000001,
      },
    ],
  });
  write('resumes/res_a.json', masterDoc);
  write('resumes/res_b.json', derivedDoc);
  // 孤儿文档：无 name、无 sections → 应识别为空白简历
  write('resumes/res_orphan.json', { data: { name: '', sections: [] }, v: 8, savedAt: 1700000000002 });
  // 旧版单文件：内容与主简历不同 → 应单独导入
  write('resume.json', { data: { name: '旧版姓名', sections: [{ id: 's0', title: '早期' }] }, v: 7, savedAt: 1690000000000 });
  // 版本历史：文件名含 versions，不应被当成简历文档
  write('resumes/res_a_versions.json', [
    { resumeId: 'res_a', kind: 'import', label: '导入', snapshot: { data: { name: '快照' } } },
  ]);
  write('companies/companies.json', [
    {
      id: 'co_1',
      name: '甲公司',
      industry: 'AI',
      applied: false,
      research: [{ id: 'r1', content: '公司调研' }],
      jds: [{ id: 'jd_1', title: 'Agent 工程师', salary: '30-60K' }],
    },
  ]);
  write('tracker/seed.json', {
    version: 1,
    records: [
      { company: '甲公司', position: 'Agent 工程师', platform: 'BOSS直聘', chat: [{ role: 'me', text: '你好' }] },
      { company: '未登记公司', position: '某岗位', platform: 'BOSS直聘', chat: [] },
    ],
  });

  snapshot = readV1Source(root);
  handle = await createDatabase(); // 内存库
  await applyMigrations(handle.client);
  userId = await insertUser('migrate@local.test');
  otherUserId = await insertUser('other@local.test');
});

afterAll(async () => {
  if (handle) await handle.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  if (backupRoot) fs.rmSync(backupRoot, { recursive: true, force: true });
});

describe('P1 · v1 数据解析', () => {
  it('简历索引 / 孤儿 / 旧单文件都识别且不丢载荷', () => {
    expect(snapshot.resumes.length).toBe(4);
    const byId = new Map(snapshot.resumes.map((r) => [r.id, r]));
    expect(byId.get('res_a')?.title).toBe('主简历');
    expect(byId.get('res_a')?.isMaster).toBe(true);
    expect(byId.get('res_a')?.payload).toHaveProperty('savedAt', 1700000000000);
    expect(byId.get('res_b')?.kind).toBe('derived');
    expect(byId.get('res_b')?.parentId).toBe('res_a');
    expect(byId.get('res_b')?.jdText).toBe('负责 Agent 应用研发');
    expect(byId.get('res_orphan')?.kind).toBe('blank');
    expect(byId.get('res_orphan')?.origin).toBe('unindexed');
    expect(byId.get('res_v1_legacy_single')?.origin).toBe('legacy-single');
  });

  it('公司 JD 拆表、投递记录匹配公司、设置保留 active', () => {
    expect(snapshot.companies.length).toBe(1);
    expect(snapshot.companyJds.length).toBe(1);
    expect(snapshot.companyJds[0].companyId).toBe('co_1');
    expect(snapshot.tracker.length).toBe(2);
    expect(snapshot.tracker[0].companyId).toBe('co_1');
    expect(snapshot.tracker[1].companyId).toBeNull();
    expect(snapshot.settings?.activeResumeId).toBe('res_a');
  });

  it('版本历史文件不被误当成简历文档，且能解析', () => {
    expect(snapshot.versions.length).toBe(1);
    expect(snapshot.versions[0].resumeId).toBe('res_a');
    expect(snapshot.resumes.some((r) => /versions/i.test(r.id))).toBe(false);
  });

  it('stableStringify 与键顺序无关', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });

  it('备份生成 manifest 且 sha256 与源文件一致，源目录不被改动', () => {
    // 备份目录放在数据源之外，避免被 listJsonFiles 再次扫描（真实 CLI 默认就是 v2/backups/）
    const dest = path.join(backupRoot, 'one');
    const manifest = backupSource(root, dest);
    const rels = listJsonFiles(root);
    expect(manifest.files.length).toBe(rels.length);
    for (const entry of manifest.files) {
      const buf = fs.readFileSync(path.join(dest, 'source', entry.rel));
      expect(entry.sha256).toBe(sha256(buf));
    }
    expect(fs.existsSync(path.join(dest, 'manifest.json'))).toBe(true);
    // 源目录未被改写（备份只复制）
    expect(readV1Source(root).resumes.length).toBe(4);
  });
});

describe('P1 · 导入事务与载荷保真', () => {
  it('单事务导入全量数据，逐条读回校验通过', async () => {
    const report = await importV1(handle.client, snapshot, userId);
    expect(report.counts.resumes).toEqual({ inserted: 4, skipped: 0, verified: 4 });
    expect(report.counts.companies).toEqual({ inserted: 1, skipped: 0, verified: 1 });
    expect(report.counts.companyJds).toEqual({ inserted: 1, skipped: 0, verified: 1 });
    expect(report.counts.tracker).toEqual({ inserted: 2, skipped: 0, verified: 2 });
    expect(report.counts.versions.inserted).toBe(1);
    expect(report.settings).toBe('merged');

    const rows = await handle.client.query('SELECT id, title, payload FROM resumes WHERE user_id = $1', [userId]);
    expect(rows.rows.length).toBe(4);
    const a = rows.rows.find((r: any) => r.id === 'res_a');
    expect(a.title).toBe('主简历');
    expect(a.payload.data.sections[0].items[0]).toBe('五年前端经验');
    expect(a.payload.fonts.base.val).toBe(11);

    const settings = await handle.client.query('SELECT payload FROM settings WHERE user_id = $1', [userId]);
    expect(settings.rows[0].payload.activeResumeId).toBe('res_a');
  });

  it('默认幂等：重跑全部跳过，不重复插入也不覆盖已有编辑', async () => {
    await handle.client.query("UPDATE resumes SET title = '用户改过的标题' WHERE user_id = $1 AND id = 'res_a'", [userId]);
    const report = await importV1(handle.client, snapshot, userId);
    expect(report.counts.resumes.inserted).toBe(0);
    expect(report.counts.resumes.skipped).toBe(4);
    expect(report.counts.versions.inserted).toBe(0);

    const rows = await handle.client.query('SELECT count(*)::int AS n FROM resumes WHERE user_id = $1', [userId]);
    expect(rows.rows[0].n).toBe(4);
    const a = await handle.client.query("SELECT title FROM resumes WHERE user_id = $1 AND id = 'res_a'", [userId]);
    expect(a.rows[0].title).toBe('用户改过的标题');
  });

  it('--force 才用旧 JSON 覆盖已存在记录', async () => {
    const report = await importV1(handle.client, snapshot, userId, { force: true });
    expect(report.counts.resumes.inserted).toBe(4);
    const a = await handle.client.query("SELECT title FROM resumes WHERE user_id = $1 AND id = 'res_a'", [userId]);
    expect(a.rows[0].title).toBe('主简历');
  });

  it('settings 用 jsonb 合并，不覆盖用户新增的键', async () => {
    await handle.client.query(
      "UPDATE settings SET payload = payload || '{\"theme\":\"dark\"}'::jsonb WHERE user_id = $1",
      [userId]
    );
    await importV1(handle.client, snapshot, userId);
    const s = await handle.client.query('SELECT payload FROM settings WHERE user_id = $1', [userId]);
    expect(s.rows[0].payload.theme).toBe('dark');
    expect(s.rows[0].payload.activeResumeId).toBe('res_a');
  });

  it('目标 user_id 不存在（外键违规）时整批回滚，不留半套数据', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    await expect(importV1(handle.client, snapshot, missing)).rejects.toThrow();
    const rows = await handle.client.query('SELECT count(*)::int AS n FROM resumes WHERE user_id = $1', [missing]);
    expect(rows.rows[0].n).toBe(0);
    // 事务回滚后连接仍可用，且原有数据完好
    const own = await handle.client.query('SELECT count(*)::int AS n FROM resumes WHERE user_id = $1', [userId]);
    expect(own.rows[0].n).toBe(4);
  });

  it('读回校验不一致时抛错并整批回滚，不静默写入损坏载荷', async () => {
    const fresh = await createDatabase();
    try {
      await applyMigrations(fresh.client);
      const uid = await fresh.client.query(
        "INSERT INTO users (email, password_hash) VALUES ('tamper@local.test', '$argon2$test-only') RETURNING id"
      );
      // 包装 client：把读回的 payload 换成不一致的内容，模拟 jsonb 写入被污染
      const tampered = {
        exec: (sql: string) => fresh.client.exec(sql),
        query: async (sql: string, params?: any[]) => {
          const res = await fresh.client.query(sql, params);
          if (sql.trim().startsWith('SELECT payload FROM')) {
            return { rows: res.rows.map((r: any) => ({ ...r, payload: { tampered: true } })) };
          }
          return res;
        },
      };
      await expect(importV1(tampered as any, snapshot, String(uid.rows[0].id))).rejects.toThrow(/读回校验失败/);
      const rows = await fresh.client.query('SELECT count(*)::int AS n FROM resumes');
      expect(rows.rows[0].n).toBe(0);
    } finally {
      await fresh.close();
    }
  });

  it('dry-run 不写库', async () => {
    const fresh = await createDatabase();
    try {
      await applyMigrations(fresh.client);
      const uid = await fresh.client.query(
        "INSERT INTO users (email, password_hash) VALUES ('dry@local.test', '$argon2$test-only') RETURNING id"
      );
      const report = await importV1(fresh.client, snapshot, String(uid.rows[0].id), { dryRun: true });
      expect(report.dryRun).toBe(true);
      expect(report.counts.resumes.inserted).toBe(0);
      const rows = await fresh.client.query('SELECT count(*)::int AS n FROM resumes');
      expect(rows.rows[0].n).toBe(0);
    } finally {
      await fresh.close();
    }
  });
});

describe('P1 · 复合主键下的跨用户同 id 隔离（P1 schema 加固）', () => {
  it('两个用户可持有完全相同的 resume id，互不覆盖', async () => {
    const report = await importV1(handle.client, snapshot, otherUserId);
    expect(report.counts.resumes.inserted).toBe(4);

    await handle.client.query(
      "UPDATE resumes SET title = 'B 改的标题' WHERE user_id = $1 AND id = 'res_a'",
      [otherUserId]
    );
    const a = await handle.client.query("SELECT title FROM resumes WHERE user_id = $1 AND id = 'res_a'", [userId]);
    const b = await handle.client.query("SELECT title FROM resumes WHERE user_id = $1 AND id = 'res_a'", [otherUserId]);
    expect(a.rows[0].title).toBe('主简历');
    expect(b.rows[0].title).toBe('B 改的标题');

    const total = await handle.client.query("SELECT count(*)::int AS n FROM resumes WHERE id = 'res_a'");
    expect(total.rows[0].n).toBe(2);
  });
});
