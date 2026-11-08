/**
 * CareerAgent 通用数据导入器（Import Schema v1）
 *
 * 采集侧千变万化（WorkBuddy/豆包/TeleAgent 浏览器自动化、AI RPA、WebDriver 脚本），
 * 但只要能产出符合 data/import-schema.md 契约的 JSON 文件，本脚本一条命令统一入库。
 *
 * 与 import-chrome-jds.js 一样：走正式 HTTP API（先 dev-login 建会话），
 * 触发器 / application_events 状态流水 / change_log 增量都会正常写入，不直连 PGlite。
 * 幂等：公司按 name、JD 按 title、投递按 (companyId, position)、
 *       内推按 (company, referrer, position)、面试按 (company, position, round)、面经按 title 去重。
 *
 * 用法：
 *   npm run dev                        # 先起本地服务（需要 dev-login）
 *   node scripts/import-data.ts 数据.json [更多.json ...]
 *   环境变量 CA_BASE 可覆盖服务地址（默认 http://127.0.0.1:3000）
 */

const BASE = process.env.CA_BASE || 'http://127.0.0.1:3000';

let cookie = '';

async function http(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { Cookie: cookie };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

// ---------------------------------------------------------------- 契约类型（宽松）

type CompanyRec = {
  name: string;
  [k: string]: unknown;
};
type JobRec = {
  companyName: string;
  title: string;
  [k: string]: unknown;
};
type ReferralRec = {
  companyName?: string;
  referrer?: string;
  position?: string;
  [k: string]: unknown;
};
type InterviewRec = {
  company?: string;
  position?: string;
  round?: string;
  [k: string]: unknown;
};
type KbRec = {
  title: string;
  [k: string]: unknown;
};

type ImportDoc = {
  meta?: { source?: string; capturedAt?: string; [k: string]: unknown };
  companies?: CompanyRec[];
  jobs?: JobRec[];
  referrals?: ReferralRec[];
  interviews?: InterviewRec[];
  kb?: KbRec[];
};

// ---------------------------------------------------------------- 工具

function extractCompanyFields(c: CompanyRec) {
  const payload: Record<string, unknown> = {};
  for (const k of Object.keys(c)) {
    if (k === 'name') continue;
    payload[k] = c[k];
  }
  return payload;
}

function extractJobFields(j: JobRec) {
  const payload: Record<string, unknown> = {};
  for (const k of Object.keys(j)) {
    if (k === 'companyName' || k === 'title') continue;
    payload[k] = j[k];
  }
  return payload;
}

// ---------------------------------------------------------------- 主流程

async function importDoc(doc: ImportDoc) {
  const source = doc.meta?.source || '外部采集';
  const capturedAt = doc.meta?.capturedAt || new Date().toISOString().slice(0, 10);
  const stats = {
    companies: { created: 0, reused: 0 },
    jobs: { created: 0, skipped: 0 },
    referrals: { created: 0, skipped: 0 },
    interviews: { created: 0, skipped: 0 },
    kb: { created: 0, skipped: 0 },
  };

  // 预取现有公司，建立 name -> row 索引
  const companies = (await http('GET', '/api/companies')) as any[];
  const byName = new Map<string, any>();
  for (const c of companies) byName.set(norm(c.name), c);
  const companyIdOf = new Map<string, string>(); // 本次导入内 companyName -> id

  async function ensureCompany(name: string): Promise<string | null> {
    if (!name) return null;
    const key = norm(name);
    if (companyIdOf.has(key)) return companyIdOf.get(key)!;
    const found = byName.get(key);
    if (found) {
      companyIdOf.set(key, found.id);
      return found.id;
    }
    // 找不到 → 新建一个空壳公司（后续 jobs 会补全档案）
    const created = (await http('POST', '/api/companies', { name, payload: { source } })) as any;
    byName.set(key, created);
    companyIdOf.set(key, created.id);
    stats.companies.created++;
    return created.id;
  }

  // 1) companies
  for (const c of doc.companies || []) {
    const name = String(c.name || '').trim();
    if (!name) continue;
    const key = norm(name);
    const found = byName.get(key);
    if (found) {
      const merged = { ...(found.payload || {}), ...extractCompanyFields(c) };
      await http('PUT', `/api/companies/${found.id}`, { name: found.name, payload: merged });
      byName.set(key, { ...found, payload: merged });
      companyIdOf.set(key, found.id);
      stats.companies.reused++;
    } else {
      const created = (await http('POST', '/api/companies', {
        name,
        payload: { ...extractCompanyFields(c), source: c.source || source },
      })) as any;
      byName.set(key, created);
      companyIdOf.set(key, created.id);
      stats.companies.created++;
    }
  }

  // 2) jobs（JD + 投递）
  const apps = (await http('GET', '/api/applications')) as any[];
  for (const j of doc.jobs || []) {
    const companyName = String(j.companyName || '').trim();
    const title = String(j.title || '').trim();
    if (!companyName || !title) {
      console.warn(`  ! 跳过岗位（缺 companyName/title）: ${JSON.stringify(j).slice(0, 80)}`);
      continue;
    }
    const companyId = await ensureCompany(companyName);
    if (!companyId) continue;
    const jSource = String(j.source || source);

    // 2a. JD（按 title 去重）
    const existingJds = (await http('GET', `/api/companies/${companyId}/jds`)) as any[];
    let jdRow = existingJds.find((x) => String(x.payload?.title || '').trim() === title);
    if (!jdRow) {
      jdRow = (await http('POST', `/api/companies/${companyId}/jds`, {
        payload: {
          ...extractJobFields(j),
          title,
          source: jSource,
          channel: j.channel,
          capturedAt,
        },
      })) as any;
    }

    // 2b. 投递记录（按 companyId + position 去重）
    const existingApp = apps.find(
      (a) => a.companyId === companyId && norm(a.position) === norm(title)
    );
    if (existingApp) {
      stats.jobs.skipped++;
      console.log(`  ↻ 投递已存在: ${companyName} · ${title} [${existingApp.status}]`);
      continue;
    }

    const targetStatus = String(j.status || 'interested');
    let app = (await http('POST', '/api/applications', {
      position: title,
      companyId,
      jdId: jdRow.id,
      status: 'interested',
      followUpAfterDays: 5,
      payload: {
        ...extractJobFields(j),
        jdText: j.jdText,
        jdUrl: j.url,
        jdSource: jSource,
        channel: j.channel,
        department: j.department,
        city: j.city,
        location: j.city,
        employmentType: j.employmentType,
        experience: j.experience,
        postedAt: j.postedAt,
        companyName,
        salary: j.salary,
        capturedAt,
      },
    })) as any;
    apps.push(app);

    // 状态不是 interested 时，走一步状态变更（保证 appliedAt 时间线真实）
    if (targetStatus !== 'interested') {
      app = (await http('PUT', `/api/applications/${app.id}`, { status: targetStatus })) as any;
    }
    stats.jobs.created++;
    console.log(`  ✓ 投递: ${companyName} · ${title} → ${targetStatus}`);
  }

  // 3) referrals
  const refs = (await http('GET', '/api/referrals')) as any[];
  for (const r of doc.referrals || []) {
    const companyName = String(r.companyName || '').trim();
    const referrer = String(r.referrer || '').trim();
    const position = String(r.position || '').trim();
    if (!referrer && !position) {
      console.warn(`  ! 跳过内推（referrer/position 都缺）: ${JSON.stringify(r).slice(0, 80)}`);
      continue;
    }
    const companyId = companyName ? await ensureCompany(companyName) : null;

    const dup = refs.find(
      (x) =>
        norm(x.payload?.companyName) === norm(companyName) &&
        norm(x.payload?.referrer) === norm(referrer) &&
        norm(x.payload?.position) === norm(position)
    );
    if (dup) {
      stats.referrals.skipped++;
      console.log(`  ↻ 内推已存在: ${companyName || '(无公司)'} · ${position || referrer}`);
      continue;
    }

    const created = (await http('POST', '/api/referrals', {
      companyId,
      payload: {
        ...r,
        companyName,
        referrer,
        position,
        source: r.source || source,
        capturedAt,
      },
    })) as any;
    refs.push(created);
    stats.referrals.created++;
    console.log(`  ✓ 内推: ${companyName || '(无公司)'} · ${position || referrer}`);
  }

  // 4) interviews（面试复盘）
  const notes = (await http('GET', '/api/interview-notes')) as any[];
  for (const it of doc.interviews || []) {
    const company = String(it.company || '').trim();
    const position = String(it.position || '').trim();
    const round = String(it.round || '').trim();
    if (!company && !position) {
      console.warn(`  ! 跳过面试（company/position 都缺）: ${JSON.stringify(it).slice(0, 80)}`);
      continue;
    }
    const dup = notes.find(
      (n) =>
        norm(n.company) === norm(company) &&
        norm(n.position) === norm(position) &&
        norm(n.round) === norm(round)
    );
    if (dup) {
      stats.interviews.skipped++;
      console.log(`  ↻ 面试已存在: ${company} · ${position}${round ? ' · ' + round : ''}`);
      continue;
    }
    const created = (await http('POST', '/api/interview-notes', {
      company,
      position,
      round: round || undefined,
      interviewAt: it.interviewAt,
      payload: { ...(it.payload as object || {}), source: it.source || source, capturedAt },
    })) as any;
    notes.push(created);
    stats.interviews.created++;
    console.log(`  ✓ 面试复盘: ${company} · ${position}${round ? ' · ' + round : ''}`);
  }

  // 5) kb（面经）
  const kbList = (await http('GET', '/api/kb')) as any[];
  for (const k of doc.kb || []) {
    const title = String(k.title || '').trim();
    if (!title) continue;
    const dup = kbList.find((x) => norm(x.title) === norm(title));
    if (dup) {
      stats.kb.skipped++;
      console.log(`  ↻ 面经已存在: ${title}`);
      continue;
    }
    const created = (await http('POST', '/api/kb', {
      title,
      category: k.category,
      tags: k.tags,
      content: k.content,
    })) as any;
    kbList.push(created);
    stats.kb.created++;
    console.log(`  ✓ 面经: ${title}`);
  }

  return stats;
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('用法: node scripts/import-data.ts <数据.json> [更多.json ...]');
    console.error('契约格式见 data/import-schema.md');
    process.exit(1);
  }

  // 建立会话（dev-login，需要本地 dev 服务在跑）
  const login = await fetch(BASE + '/api/auth/dev-login', { method: 'POST' });
  if (!login.ok) {
    throw new Error(
      `dev-login 失败: ${(await login.text()).slice(0, 200)}\n` +
        `请先运行 npm run dev，或检查 CA_BASE（当前 ${BASE}）`
    );
  }
  const raw = login.headers.getSetCookie
    ? login.headers.getSetCookie()
    : [login.headers.get('set-cookie')];
  cookie = raw.map((c) => String(c).split(';')[0]).join('; ');
  const me = (await login.json()) as any;
  console.log(`✓ 会话建立: ${me.user.email} (${me.user.id})`);

  const fs = await import('node:fs');
  let grand = {
    companies: { created: 0, reused: 0 },
    jobs: { created: 0, skipped: 0 },
    referrals: { created: 0, skipped: 0 },
    interviews: { created: 0, skipped: 0 },
    kb: { created: 0, skipped: 0 },
  };

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    let doc: ImportDoc;
    try {
      doc = JSON.parse(text);
    } catch (e) {
      console.error(`✗ 无法解析 JSON: ${file}`);
      process.exit(1);
    }
    console.log(`\n=== 导入 ${file}（来源: ${doc.meta?.source || '外部采集'}）===`);
    const s = await importDoc(doc);
    for (const k of Object.keys(grand) as (keyof typeof grand)[]) {
      const gk = grand[k] as Record<string, number>;
      const sk = s[k] as Record<string, number>;
      for (const kk of Object.keys(gk)) gk[kk] += sk[kk];
    }
  }

  console.log('\n=== 全部完成 ===');
  console.log(`公司: 新建 ${grand.companies.created} / 复用 ${grand.companies.reused}`);
  console.log(`投递: 新建 ${grand.jobs.created} / 跳过 ${grand.jobs.skipped}`);
  console.log(`内推: 新建 ${grand.referrals.created} / 跳过 ${grand.referrals.skipped}`);
  console.log(`面试: 新建 ${grand.interviews.created} / 跳过 ${grand.interviews.skipped}`);
  console.log(`面经: 新建 ${grand.kb.created} / 跳过 ${grand.kb.skipped}`);
}

main().catch((e) => {
  console.error('导入失败:', e.message || e);
  process.exit(1);
});
