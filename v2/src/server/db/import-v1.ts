/**
 * P1 · v1 JSON → PG 数据迁移
 *
 * 用法：
 *   npm run import:v1 -- --email admin@local.test
 *   npm run import:v1 -- --dry-run                 # 只解析 + 校验，不写库、不备份
 *   npm run import:v1 -- --force                  # 已存在的记录用旧 JSON 覆盖（默认跳过）
 *   npm run import:v1 -- --source /path/to/data --pgdata ./pgdata --backup-dir ./backups/x
 *
 * 设计要点：
 * 1. 旧项目 data/ 只读，绝不改写；写入前整目录 JSON 备份到 backups/<ts>/ 并留 manifest(sha256)。
 * 2. 全部导入包在一个事务里，任何一条失败或读回校验不一致 → 整体 ROLLBACK。
 * 3. 幂等：按 (user_id, id) 冲突。默认 DO NOTHING，保护迁移后用户在 v2 里的编辑；--force 才覆盖。
 * 4. 载荷保真：resume payload 存 v1 文档的完整对象（data/fonts/spacing/v/savedAt），
 *    不裁剪字段；导入后逐条读回做「语义等价」比对（稳定键序 JSON）。
 * 5. 目标账号必须先由 npm run seed:user 创建；所有数据归到该 user_id，行级隔离不破。
 *
 * 数据源（相对 sourceDir）：
 *   resumes/index.json          索引：title/tags/kind/parentId/jobId/jdText/isMaster/active
 *   resumes/res_*.json          每份简历的完整文档
 *   resume.json                 旧版单文件兜底（内容与索引里的主简历不同，单独导入）
 *   companies/companies.json    公司档案数组，内含 jds[]（拆入 company_jds 表）
 *   tracker/seed.json           投递记录种子包
 *   含 versions 的 json 文件   N11 本地版本历史（若存在）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createDatabase } from './client';
import { applyMigrations, type MigrationClient } from './migrate';

// ---------------------------------------------------------------- 类型

export interface SourceFile {
  rel: string;
  abs: string;
  bytes: number;
  sha256: string;
}

export interface V1Resume {
  id: string;
  title: string;
  kind: 'master' | 'derived' | 'blank';
  parentId: string | null;
  jobId: string | null;
  jdText: string | null;
  tags: string[];
  isMaster: boolean;
  savedAt: number;
  /** v1 文档的完整对象，原样落 jsonb，不裁剪字段。 */
  payload: Record<string, unknown>;
  origin: 'index' | 'unindexed' | 'legacy-single';
  sourceFile: string;
}

export interface V1Company {
  id: string;
  name: string;
  payload: Record<string, unknown>;
}

export interface V1Jd {
  id: string;
  companyId: string;
  payload: Record<string, unknown>;
}

export interface V1Tracker {
  id: string;
  companyId: string | null;
  payload: Record<string, unknown>;
}

export interface V1Version {
  resumeId: string;
  kind: string;
  label: string | null;
  snapshot: Record<string, unknown>;
}

export interface V1Snapshot {
  sourceDir: string;
  files: SourceFile[];
  resumes: V1Resume[];
  companies: V1Company[];
  companyJds: V1Jd[];
  tracker: V1Tracker[];
  versions: V1Version[];
  settings: Record<string, unknown> | null;
  warnings: string[];
}

export interface BackupManifest {
  createdAt: string;
  sourceDir: string;
  backupDir: string;
  files: Array<{ rel: string; bytes: number; sha256: string }>;
}

export interface CountBucket {
  inserted: number;
  skipped: number;
  verified: number;
}

export interface ImportReport {
  targetUserId: string;
  dryRun: boolean;
  force: boolean;
  counts: {
    resumes: CountBucket;
    companies: CountBucket;
    companyJds: CountBucket;
    tracker: CountBucket;
    versions: CountBucket;
  };
  settings: 'merged' | 'skipped' | 'dry-run';
  warnings: string[];
  elapsedMs: number;
}

export interface ImportOptions {
  force?: boolean;
  dryRun?: boolean;
}

// ---------------------------------------------------------------- 工具

export function sha256(input: Buffer | string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** 键序无关的 JSON 序列化，用于「写入前 / 从 jsonb 读回」的语义等价比对。 */
export function stableStringify(value: unknown): string {
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, any> = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

function readJson(abs: string): any {
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

/** 递归列出相对路径的 .json 文件；跳过隐藏目录、node_modules、备份目录。 */
export function listJsonFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name === 'backups') continue;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs, rel);
      else if (ent.isFile() && ent.name.endsWith('.json')) out.push(rel);
    }
  };
  walk(root, '');
  return out.sort();
}

function stableId(prefix: string, seed: string): string {
  return `${prefix}_${sha256(seed).slice(0, 12)}`;
}

// ---------------------------------------------------------------- 读取 v1

export function readV1Source(sourceDir: string): V1Snapshot {
  const root = path.resolve(sourceDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`v1 数据目录不存在: ${root}`);
  }

  const files: SourceFile[] = [];
  const warnings: string[] = [];
  const track = (rel: string): Buffer | null => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    const buf = fs.readFileSync(abs);
    files.push({ rel, abs, bytes: buf.length, sha256: sha256(buf) });
    return buf;
  };

  const resumes: V1Resume[] = [];
  const companies: V1Company[] = [];
  const companyJds: V1Jd[] = [];
  const tracker: V1Tracker[] = [];
  const versions: V1Version[] = [];
  let settings: Record<string, unknown> | null = null;

  // --- 简历索引 ---
  const idxBuf = track(path.join('resumes', 'index.json'));
  const idx = idxBuf ? JSON.parse(idxBuf.toString('utf8')) : null;
  if (!idx) warnings.push('缺少 resumes/index.json：简历将全部按「未索引文档」导入');
  const byId = new Map<string, any>((idx?.items || []).map((i: any) => [String(i.id), i]));

  // --- 分文档简历 ---
  const resumesDir = path.join(root, 'resumes');
  const docFiles = fs.existsSync(resumesDir)
    ? fs.readdirSync(resumesDir).filter((f) => f.startsWith('res_') && f.endsWith('.json') && !/versions/i.test(f))
    : [];
  const seenIds = new Set<string>();
  for (const file of docFiles) {
    const rel = path.join('resumes', file);
    const buf = track(rel);
    if (!buf) continue;
    const doc = JSON.parse(buf.toString('utf8'));
    const id = file.replace(/\.json$/, '');
    seenIds.add(id);
    const item = byId.get(id);
    const sections = doc?.data?.sections || [];
    const isBlank = !item && !doc?.data?.name && sections.length === 0;

    resumes.push({
      id,
      title: item?.title ? String(item.title) : `[迁移] 未索引文档 ${id}`,
      kind: item?.kind === 'derived' ? 'derived' : isBlank ? 'blank' : 'master',
      parentId: item?.parentId ?? null,
      jobId: item?.jobId ?? null,
      jdText: item?.jdText ?? null,
      tags: Array.isArray(item?.tags) ? item.tags.map(String) : [],
      isMaster: !!item?.isMaster,
      savedAt: Number(doc?.savedAt || item?.updatedAt || Date.now()),
      payload: doc,
      origin: item ? 'index' : 'unindexed',
      sourceFile: rel,
    });
    if (!item) warnings.push(`文档未被索引，按 ${isBlank ? '空白简历' : '独立简历'} 导入: ${id}`);
  }
  for (const id of byId.keys()) {
    if (!seenIds.has(id)) warnings.push(`索引指向的文档缺失，已跳过: ${id}`);
  }

  // --- 旧版单文件兜底（与索引主简历内容不同才导入，避免重复） ---
  const legacyBuf = track('resume.json');
  if (legacyBuf) {
    const legacy = JSON.parse(legacyBuf.toString('utf8'));
    const masterId = idx?.items?.find((i: any) => i.isMaster)?.id;
    const masterDoc = masterId ? resumes.find((r) => r.id === masterId)?.payload : null;
    if (masterDoc && stableStringify(masterDoc) === stableStringify(legacy)) {
      warnings.push('resume.json 与索引里的主简历内容相同，未重复导入');
    } else {
      resumes.push({
        id: 'res_v1_legacy_single',
        title: '[迁移] 旧版单文件简历',
        kind: 'master',
        parentId: null,
        jobId: null,
        jdText: null,
        tags: [],
        isMaster: false,
        savedAt: Number(legacy?.savedAt || Date.now()),
        payload: legacy,
        origin: 'legacy-single',
        sourceFile: 'resume.json',
      });
    }
  }

  // --- 公司档案 + 岗位 JD ---
  const coBuf = track(path.join('companies', 'companies.json'));
  const coRaw = coBuf ? JSON.parse(coBuf.toString('utf8')) : null;
  const coList: any[] = Array.isArray(coRaw) ? coRaw : coRaw?.companies || [];
  for (const c of coList) {
    if (!c?.id) {
      warnings.push('公司档案缺少 id，已跳过一条');
      continue;
    }
    companies.push({ id: String(c.id), name: String(c.name || c.id), payload: c });
    for (const [i, jd] of (c.jds || []).entries()) {
      const jdId = jd?.id ? String(jd.id) : stableId('jd_v1', `${c.id}|${i}|${jd?.title || ''}`);
      companyJds.push({ id: jdId, companyId: String(c.id), payload: jd });
    }
  }

  // --- 投递记录种子包 ---
  const trBuf = track(path.join('tracker', 'seed.json'));
  const trRaw = trBuf ? JSON.parse(trBuf.toString('utf8')) : null;
  const byName = new Map<string, string>(companies.map((c) => [c.name, c.id]));
  for (const [i, r] of (trRaw?.records || []).entries()) {
    if (!r?.company) continue;
    const companyId = byName.get(String(r.company)) || null;
    if (!companyId) warnings.push(`投递记录未匹配到公司档案，company_id 留空: ${r.company}`);
    tracker.push({
      id: stableId('trk_v1', `${r.company}|${r.position || ''}|${i}`),
      companyId,
      payload: r,
    });
  }

  // --- N11 本地版本历史（文件名含 versions 的 json，容错解析） ---
  for (const rel of listJsonFiles(root)) {
    if (!/versions/i.test(rel)) continue;
    const abs = path.join(root, rel);
    if (!files.some((f) => f.rel === rel)) {
      const buf = fs.readFileSync(abs);
      files.push({ rel, abs, bytes: buf.length, sha256: sha256(buf) });
    }
    const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const list: any[] = Array.isArray(raw) ? raw : raw?.versions || raw?.entries || [];
    const fromName = /(res_[a-z0-9]+)/i.exec(rel)?.[1] || '';
    for (const v of list) {
      const resumeId = String(v?.resumeId || v?.resume_id || fromName || '');
      if (!resumeId) {
        warnings.push(`版本记录缺 resumeId，已跳过: ${rel}`);
        continue;
      }
      versions.push({
        resumeId,
        kind: String(v?.kind || 'unknown'),
        label: v?.label == null ? null : String(v.label),
        snapshot: (v?.snapshot || v?.payload || v?.doc || v) as Record<string, unknown>,
      });
    }
  }

  // --- 设置：v1 的 active 简历 id ---
  if (idx?.active) settings = { activeResumeId: String(idx.active), importedFrom: 'v1' };

  return { sourceDir: root, files, resumes, companies, companyJds, tracker, versions, settings, warnings };
}

// ---------------------------------------------------------------- 备份

export function backupSource(sourceDir: string, backupDir: string): BackupManifest {
  const root = path.resolve(sourceDir);
  const dest = path.resolve(backupDir);
  const rels = listJsonFiles(root);
  const manifest: BackupManifest = {
    createdAt: new Date().toISOString(),
    sourceDir: root,
    backupDir: dest,
    files: [],
  };
  fs.mkdirSync(path.join(dest, 'source'), { recursive: true });
  for (const rel of rels) {
    const buf = fs.readFileSync(path.join(root, rel));
    const out = path.join(dest, 'source', rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf);
    manifest.files.push({ rel, bytes: buf.length, sha256: sha256(buf) });
  }
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

// ---------------------------------------------------------------- 导入

const RESUME_CONFLICT_FORCE = `ON CONFLICT (user_id, id) DO UPDATE SET
  title = EXCLUDED.title, kind = EXCLUDED.kind, parent_id = EXCLUDED.parent_id,
  job_id = EXCLUDED.job_id, jd_text = EXCLUDED.jd_text, tags = EXCLUDED.tags,
  is_master = EXCLUDED.is_master, payload = EXCLUDED.payload,
  saved_at = EXCLUDED.saved_at, updated_at = now()`;

function normalizeJsonb(v: any): any {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

/** 事务内读回一条 jsonb，与源对象做键序无关的语义比对。 */
async function verifyPayload(
  client: MigrationClient,
  table: string,
  userId: string,
  id: string,
  expected: Record<string, unknown>
): Promise<void> {
  const res = await client.query(
    `SELECT payload FROM ${table} WHERE user_id = $1 AND id = $2`,
    [userId, id]
  );
  if (!res.rows.length) throw new Error(`读回失败：${table} 中找不到 ${id}`);
  const got = normalizeJsonb(res.rows[0].payload);
  if (stableStringify(got) !== stableStringify(expected)) {
    throw new Error(`读回校验失败：${table}/${id} 的 payload 与源数据不一致`);
  }
}

const emptyBucket = (): CountBucket => ({ inserted: 0, skipped: 0, verified: 0 });

/**
 * 把 snapshot 全部写入指定用户名下。
 * 单事务：任何错误 / 校验不一致都会 ROLLBACK，不会留下半套数据。
 */
export async function importV1(
  client: MigrationClient,
  snapshot: V1Snapshot,
  userId: string,
  opts: ImportOptions = {}
): Promise<ImportReport> {
  if (!userId) throw new Error('importV1 必须传入目标 userId');
  const started = Date.now();
  const force = !!opts.force;
  const bucket = { resumes: emptyBucket(), companies: emptyBucket(), companyJds: emptyBucket(), tracker: emptyBucket(), versions: emptyBucket() };
  let settings: ImportReport['settings'] = 'skipped';

  if (opts.dryRun) {
    return {
      targetUserId: userId,
      dryRun: true,
      force,
      counts: bucket,
      settings: 'dry-run',
      warnings: snapshot.warnings,
      elapsedMs: Date.now() - started,
    };
  }

  await client.exec('BEGIN');
  try {
    // --- 简历 ---
    for (const r of snapshot.resumes) {
      const sql = `INSERT INTO resumes
        (id, user_id, title, kind, parent_id, job_id, jd_text, tags, is_master, payload, saved_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11)
        ${force ? RESUME_CONFLICT_FORCE : 'ON CONFLICT (user_id, id) DO NOTHING'}
        RETURNING id`;
      const res = await client.query(sql, [
        r.id, userId, r.title, r.kind, r.parentId, r.jobId, r.jdText,
        JSON.stringify(r.tags), r.isMaster, JSON.stringify(r.payload), r.savedAt,
      ]);
      if (res.rows.length) {
        bucket.resumes.inserted++;
        await verifyPayload(client, 'resumes', userId, r.id, r.payload);
        bucket.resumes.verified++;
      } else bucket.resumes.skipped++;
    }

    // --- 公司 ---
    for (const c of snapshot.companies) {
      const sql = `INSERT INTO companies (id, user_id, name, payload)
        VALUES ($1, $2, $3, $4::jsonb)
        ${force ? 'ON CONFLICT (user_id, id) DO UPDATE SET name = EXCLUDED.name, payload = EXCLUDED.payload, updated_at = now()' : 'ON CONFLICT (user_id, id) DO NOTHING'}
        RETURNING id`;
      const res = await client.query(sql, [c.id, userId, c.name, JSON.stringify(c.payload)]);
      if (res.rows.length) {
        bucket.companies.inserted++;
        await verifyPayload(client, 'companies', userId, c.id, c.payload);
        bucket.companies.verified++;
      } else bucket.companies.skipped++;
    }

    // --- 公司岗位 JD ---
    for (const j of snapshot.companyJds) {
      const sql = `INSERT INTO company_jds (id, user_id, company_id, payload)
        VALUES ($1, $2, $3, $4::jsonb)
        ${force ? 'ON CONFLICT (user_id, id) DO UPDATE SET company_id = EXCLUDED.company_id, payload = EXCLUDED.payload' : 'ON CONFLICT (user_id, id) DO NOTHING'}
        RETURNING id`;
      const res = await client.query(sql, [j.id, userId, j.companyId, JSON.stringify(j.payload)]);
      if (res.rows.length) {
        bucket.companyJds.inserted++;
        await verifyPayload(client, 'company_jds', userId, j.id, j.payload);
        bucket.companyJds.verified++;
      } else bucket.companyJds.skipped++;
    }

    // --- 投递记录 ---
    for (const t of snapshot.tracker) {
      const sql = `INSERT INTO tracker (id, user_id, company_id, payload)
        VALUES ($1, $2, $3, $4::jsonb)
        ${force ? 'ON CONFLICT (user_id, id) DO UPDATE SET company_id = EXCLUDED.company_id, payload = EXCLUDED.payload, updated_at = now()' : 'ON CONFLICT (user_id, id) DO NOTHING'}
        RETURNING id`;
      const res = await client.query(sql, [t.id, userId, t.companyId, JSON.stringify(t.payload)]);
      if (res.rows.length) {
        bucket.tracker.inserted++;
        await verifyPayload(client, 'tracker', userId, t.id, t.payload);
        bucket.tracker.verified++;
      } else bucket.tracker.skipped++;
    }

    // --- 版本历史：无业务唯一键，用 (user_id,resume_id,kind,label,snapshot) 去重保证幂等 ---
    for (const v of snapshot.versions) {
      // INSERT ... SELECT 里参数类型不会由目标列反推，必须显式 cast（user_id 是 uuid）。
      const sql = `INSERT INTO versions (user_id, resume_id, kind, label, snapshot)
        SELECT $1::uuid, $2::text, $3::text, $4::text, $5::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM versions
          WHERE user_id = $1::uuid AND resume_id = $2::text AND kind = $3::text
            AND label IS NOT DISTINCT FROM $4::text AND snapshot = $5::jsonb
        )
        RETURNING id`;
      const res = await client.query(sql, [
        userId, v.resumeId, v.kind, v.label, JSON.stringify(v.snapshot),
      ]);
      if (res.rows.length) bucket.versions.inserted++;
      else bucket.versions.skipped++;
    }

    // --- 设置：只合并 v1 的键，不覆盖用户在 v2 里新增的设置 ---
    if (snapshot.settings) {
      await client.query(
        `INSERT INTO settings (user_id, payload) VALUES ($1, $2::jsonb)
         ON CONFLICT (user_id) DO UPDATE SET payload = settings.payload || EXCLUDED.payload, updated_at = now()`,
        [userId, JSON.stringify(snapshot.settings)]
      );
      settings = 'merged';
    }

    await client.exec('COMMIT');
  } catch (e) {
    await client.exec('ROLLBACK');
    throw e;
  }

  return {
    targetUserId: userId,
    dryRun: false,
    force,
    counts: bucket,
    settings,
    warnings: snapshot.warnings,
    elapsedMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------- CLI

interface CliArgs {
  email: string;
  source: string;
  pgdata: string;
  backupDir: string;
  dryRun: boolean;
  force: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf('--' + name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return {
    email: (get('email') || 'admin@local.test').trim().toLowerCase(),
    source: get('source') || path.resolve(process.cwd(), '..', 'data'),
    pgdata: get('pgdata') || process.env.PGDATA || './pgdata',
    backupDir: get('backup-dir') || path.resolve(process.cwd(), 'backups', stamp),
    dryRun: argv.includes('--dry-run'),
    force: argv.includes('--force'),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

const HELP = `P1 · v1 JSON → PG 迁移

  npm run import:v1 -- [选项]

选项:
  --email <addr>      目标账号，全部数据归到它名下（默认 admin@local.test，需先 seed:user）
  --source <dir>      v1 数据目录（默认 ../data）
  --pgdata <dir>      PGlite 数据目录（默认 ./pgdata，或环境变量 PGDATA）
  --backup-dir <dir>  备份输出目录（默认 ./backups/<时间戳>）
  --dry-run           只解析 + 校验并打印计划，不备份、不写库
  --force             已存在的记录用旧 JSON 覆盖；默认跳过以保护 v2 里的编辑
  -h, --help          显示本帮助

执行前会自动把 --source 下全部 .json 备份到 --backup-dir/source/ 并生成 manifest.json。
`;

function printPlan(s: V1Snapshot, a: CliArgs): void {
  console.log(`数据源      : ${s.sourceDir}`);
  console.log(`目标账号    : ${a.email}`);
  console.log(`备份目录    : ${a.backupDir}`);
  console.log(`模式        : ${a.dryRun ? 'DRY-RUN（不写库）' : a.force ? '导入（--force 覆盖已存在记录）' : '导入（已存在记录跳过）'}`);
  console.log('');
  console.log('待导入:');
  console.log(`  简历        ${s.resumes.length}  (索引 ${s.resumes.filter((r) => r.origin === 'index').length} / 未索引 ${s.resumes.filter((r) => r.origin === 'unindexed').length} / 旧单文件 ${s.resumes.filter((r) => r.origin === 'legacy-single').length})`);
  console.log(`  公司档案    ${s.companies.length}`);
  console.log(`  岗位 JD     ${s.companyJds.length}`);
  console.log(`  投递记录    ${s.tracker.length}`);
  console.log(`  版本历史    ${s.versions.length}`);
  console.log(`  源文件      ${s.files.length} 个 JSON`);
  console.log(`  设置        ${s.settings ? JSON.stringify(s.settings) : '无'}`);
  if (s.warnings.length) {
    console.log('');
    console.log('提示:');
    for (const w of s.warnings) console.log(`  - ${w}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const snapshot = readV1Source(args.source);
  printPlan(snapshot, args);
  console.log('');

  if (args.dryRun) {
    const report = await importV1({} as MigrationClient, snapshot, 'dry-run-user', { dryRun: true });
    console.log('DRY-RUN 完成：未备份、未写库。报告:', JSON.stringify({ counts: report.counts, settings: report.settings }));
    return;
  }

  const manifest = backupSource(snapshot.sourceDir, args.backupDir);
  console.log(`已备份 ${manifest.files.length} 个源文件 → ${manifest.backupDir}`);

  const { client, close } = await createDatabase(args.pgdata);
  try {
    const applied = await applyMigrations(client);
    if (applied.length) console.log(`已应用迁移: ${applied.join(', ')}`);

    const found = await client.query('SELECT id, status FROM users WHERE email = $1', [args.email]);
    if (!found.rows.length) {
      throw new Error(`目标账号不存在: ${args.email}；请先运行 npm run seed:user -- --email ${args.email} --password <至少8位> --role admin`);
    }
    const userId = String(found.rows[0].id);
    console.log(`目标用户    : ${args.email} (${userId})`);

    const report = await importV1(client, snapshot, userId, { force: args.force });
    console.log('');
    console.log('导入结果:');
    for (const [k, v] of Object.entries(report.counts)) {
      console.log(`  ${k.padEnd(12)} 新增 ${v.inserted} / 跳过 ${v.skipped} / 校验 ${v.verified}`);
    }
    console.log(`  settings    ${report.settings}`);
    console.log(`  耗时        ${report.elapsedMs}ms`);

    const reportPath = path.join(args.backupDir, 'migration-report.json');
    fs.writeFileSync(
      reportPath,
      JSON.stringify({ email: args.email, sourceDir: snapshot.sourceDir, backup: manifest, report }, null, 2) + '\n'
    );
    console.log(`\n迁移报告    : ${reportPath}`);
  } finally {
    await close();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[import:v1] 失败:', e.message || e);
    process.exit(1);
  });
}
