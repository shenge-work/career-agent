/**
 * 公司档案情报层（D7 第一批）：行业分类词表 / 同义词检索 / 完整度 / Markdown 简报。
 *
 * 纯函数、无依赖，前端与测试共用。数据形态对齐 PG `companies.payload`（v1 迁移数据零改动）：
 *   { name, industry, scale, location, website, note, research:[{id,platform,dim,content,date,url}], ... }
 * D7 新增字段全部可选、由 normalizeCompany 补全缺省值。
 */

/* ============================================================ 行业词表 */

export interface IndustryCategory {
  id: string;
  /** 一级门类 */
  group: string;
  /** 展示名（二级赛道或门类级） */
  label: string;
}

/** 标准行业类目（受控、可聚合）：id → 类目 */
export const INDUSTRY_TAXONOMY: Record<string, IndustryCategory> = {
  'ai-app': { id: 'ai-app', group: '人工智能', label: 'AI 应用' },
  'ai-agent': { id: 'ai-agent', group: '人工智能', label: 'Agent 平台' },
  'ai-llm': { id: 'ai-llm', group: '人工智能', label: '大模型' },
  'ai-infra': { id: 'ai-infra', group: '人工智能', label: 'AI 基础设施' },
  'semi-chip': { id: 'semi-chip', group: '半导体与硬件', label: '芯片设计' },
  'hw-smart': { id: 'hw-smart', group: '半导体与硬件', label: '智能硬件' },
  'hw-xr': { id: 'hw-xr', group: '半导体与硬件', label: 'AR·VR·XR' },
  'hw-consumer': { id: 'hw-consumer', group: '半导体与硬件', label: '消费电子' },
  'ent-saas': { id: 'ent-saas', group: '企业服务', label: 'SaaS' },
  'ent-data': { id: 'ent-data', group: '企业服务', label: '数据平台' },
  'ent-dev': { id: 'ent-dev', group: '企业服务', label: '开发者工具' },
  'fin-bank': { id: 'fin-bank', group: '金融科技', label: '银行·证券' },
  'fin-pay': { id: 'fin-pay', group: '金融科技', label: '支付·保险' },
  'fin-credit': { id: 'fin-credit', group: '金融科技', label: '互金·信贷' },
  'net-ecom': { id: 'net-ecom', group: '互联网与内容', label: '电商' },
  'net-game': { id: 'net-game', group: '互联网与内容', label: '游戏' },
  'net-content': { id: 'net-content', group: '互联网与内容', label: '内容平台' },
  'other-edu': { id: 'other-edu', group: '其他', label: '教育' },
  'other-med': { id: 'other-med', group: '其他', label: '医疗' },
  'other-mfg': { id: 'other-mfg', group: '其他', label: '制造' },
  'other-none': { id: 'other-none', group: '其他', label: '未分类' },
};

/** 同义词 → 类目 id（多对一）。大小写不敏感、中英混排。 */
const ALIAS_RAW: Record<string, string[]> = {
  'ai-app': ['ai应用', '人工智能应用', 'aigc', '生成式ai', 'cv', '计算机视觉', 'nlp', '语音'],
  'ai-agent': ['agent', '智能体', 'ai助理', 'copilot', '工作流'],
  'ai-llm': ['大模型', 'llm', '大语言模型', '模型训练', '预训练', '多模态'],
  'ai-infra': ['算力', 'gpu', '推理引擎', '向量数据库', '数据标注'],
  'semi-chip': ['芯片', 'ic', '晶圆', 'mcu', '车规', '半导体'],
  'hw-smart': ['智能硬件', '硬件', 'iot', '机器人', '可穿戴', '音频设备', '录音笔'],
  'hw-xr': ['ar', 'vr', 'xr', '眼镜', '空间计算', '墨水屏'],
  'hw-consumer': ['消费电子', '手机', '平板', '配件'],
  'ent-saas': ['saas', '企业软件', 'crm', 'erp', '营销云'],
  'ent-data': ['数仓', 'bi', '指标中台', '数据分析', '数据库'],
  'ent-dev': ['开发者', 'devops', '云原生', '低代码'],
  'fin-bank': ['银行', '券商', '证券', '基金', '交易所'],
  'fin-pay': ['支付', '保险', '保险科技'],
  'fin-credit': ['互金', '信贷', '消费金融', '金融科技', 'fintech'],
  'net-ecom': ['电商', '跨境电商', '零售', '供应链'],
  'net-game': ['游戏', '手游', '电竞'],
  'net-content': ['内容', '社交', '短视频', '直播', '社区', '媒体', '红人', '营销'],
  'other-edu': ['教育', '培训', 'k12'],
  'other-med': ['医疗', '健康', '制药', '生物'],
  'other-mfg': ['制造', '工厂', '新能源', '汽车'],
};

/** 规整后的别名词表：小写词 → 类目 id 集合 */
const INDUSTRY_ALIASES: Map<string, Set<string>> = (() => {
  const m = new Map<string, Set<string>>();
  for (const [cat, words] of Object.entries(ALIAS_RAW)) {
    for (const w of words) {
      const k = w.toLowerCase();
      if (!m.has(k)) m.set(k, new Set());
      m.get(k)!.add(cat);
    }
  }
  return m;
})();

/** 类目 → 小写别名表（保持词表顺序）：检索时按类目对正文做别名匹配 */
const ALIAS_BY_CATEGORY: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const [cat, words] of Object.entries(ALIAS_RAW)) {
    m.set(cat, words.map((w) => w.toLowerCase()));
  }
  return m;
})();

/** 超短拉丁别名（ar / vr / ic / cv…）做正文子串匹配误命中率高（公司英文名子串），正文匹配时跳过；不影响字面与类目路径。 */
const isFuzzyUnsafe = (alias: string) => /^[a-z0-9]{1,2}$/.test(alias);

/* ============================================================ 归一化 */

export interface ResearchItem {
  id?: string;
  platform?: string;
  dim?: string;
  content?: string;
  date?: string;
  url?: string;
}

export interface CompanyIntel {
  id?: string;
  name: string;
  industry?: string;
  scale?: string;
  location?: string;
  website?: string;
  note?: string;
  summary?: string;
  tags?: string[];
  industryCategory?: string;
  industryAliases?: string[];
  research?: ResearchItem[];
  jds?: Array<Record<string, any>>;
  benefits?: Array<Record<string, any>>;
  rumors?: Array<Record<string, any>>;
  salaries?: Array<Record<string, any>>;
  links?: Array<Record<string, any>>;
  verdict?: Record<string, any> | null;
  interviews?: Array<Record<string, any>>;
  questions?: Array<Record<string, any>>;
  fundingRounds?: Array<Record<string, any>>;
  strategyPhases?: Array<Record<string, any>>;
  [k: string]: unknown;
}

/** D7 六维调研维度（与迁移数据 `research[].dim` 完全一致） */
export const RESEARCH_DIMS = ['公司简介', '团队情况', '盈利情况', '融资情况', '竞品分析', '风险与挑战'] as const;

/** 「我的判断」推荐度：纯文字，禁止用颜色表达。 */
export const VERDICT_LEVELS = ['优先投', '可投', '观望', '不投'] as const;

/** 「面试与面经」轮次枚举。 */
export const INTERVIEW_ROUNDS = ['一面', '二面', '三面', 'HR 面', '终面', '笔试', '其他'] as const;

/** 「面试与面经」形式枚举。 */
export const INTERVIEW_FORMS = ['电话', '视频', '现场', '笔试', '其他'] as const;

/** 「待核实问题清单」状态枚举。 */
export const QUESTION_STATUS = ['待核实', '已核实', '已证伪'] as const;

/** 薪资周期枚举（§10.2.4 口径字典：周期显式可见，否则数据不可比）。 */
export const SALARY_PERIODS = ['月薪', '年薪'] as const;

/** 薪资币种枚举。 */
export const SALARY_CURRENCIES = ['CNY'] as const;

/** 融资轮次枚举（§10.5）。 */
export const FUNDING_ROUNDS = [
  '种子', '天使', 'Pre-A', 'A', 'A+', 'B', 'B+', 'C', 'C+', 'D', 'D+',
  'E', 'Pre-IPO', 'IPO', '战略融资', '并购', '未披露',
] as const;

/** 融资币种枚举。 */
export const FUNDING_CURRENCIES = ['CNY', 'USD'] as const;

/** 薪资样本（§10.2.4）：按岗位族分箱，不做公司整体平均。 */
export interface SalarySample {
  id?: string;
  role: string;         // 岗位族
  level?: string;       // 职级
  low: number;          // 下限（万元/月 或 万元/年，随 period）
  high: number;         // 上限
  avg?: number;         // 均值
  currency?: string;    // 默认 CNY
  period?: string;      // 月薪 | 年薪
  months?: number;      // 薪资月数（13/14/16 薪）
  sampleSize?: number;
  source?: string;
  date?: string;
  note?: string;
}

/** 融资轮次（§10.5）。 */
export interface FundingRound {
  id?: string;
  round: string;
  date?: string;
  amount?: number;      // 金额（万元/亿元，随 amountUnit）
  amountUnit?: string;  // 万 | 亿
  currency?: string;    // CNY | USD
  investors?: string[];
  valuation?: string;
  source?: string;
  note?: string;
}

/** 把 salaries[]/fundingRounds[] 规整为带缺省的类型化数组。 */
export function normalizeSalaries(salaries?: Array<Record<string, any>>): SalarySample[] {
  if (!Array.isArray(salaries)) return [];
  return salaries.map((s) => ({
    role: String(s.role || ''),
    level: s.level,
    low: Number(s.low) || 0,
    high: Number(s.high) || 0,
    avg: s.avg != null ? Number(s.avg) : undefined,
    currency: s.currency || 'CNY',
    period: s.period || '月薪',
    months: s.months != null ? Number(s.months) : undefined,
    sampleSize: s.sampleSize != null ? Number(s.sampleSize) : undefined,
    source: s.source,
    date: s.date,
    note: s.note,
  } as SalarySample));
}

export function normalizeFundingRounds(rounds?: Array<Record<string, any>>): FundingRound[] {
  if (!Array.isArray(rounds)) return [];
  return rounds.map((r) => ({
    round: String(r.round || ''),
    date: r.date,
    amount: r.amount != null ? Number(r.amount) : undefined,
    amountUnit: r.amountUnit || '亿',
    currency: r.currency || 'CNY',
    investors: Array.isArray(r.investors) ? r.investors : [],
    valuation: r.valuation,
    source: r.source,
    note: r.note,
  } as FundingRound));
}

/** 新字段全部可选、缺省补全；旧数据零迁移。 */
export function normalizeCompany(raw: Record<string, any> | null | undefined): CompanyIntel {
  const c = (raw || {}) as CompanyIntel;
  const industry = String(c.industry || '').trim();
  const category = String(c.industryCategory || '').trim() || inferIndustryCategory(industry);
  return {
    ...c,
    name: String(c.name || '未命名公司'),
    summary: String(c.summary || ''),
    tags: Array.isArray(c.tags) ? c.tags.map(String) : [],
    industryCategory: category,
    industryAliases: Array.isArray(c.industryAliases) ? c.industryAliases.map(String) : [],
    research: Array.isArray(c.research) ? c.research : [],
    jds: Array.isArray(c.jds) ? c.jds : [],
    benefits: Array.isArray(c.benefits) ? c.benefits : [],
    rumors: Array.isArray(c.rumors) ? c.rumors : [],
    salaries: Array.isArray(c.salaries) ? c.salaries : [],
    links: Array.isArray(c.links) ? c.links : [],
    interviews: Array.isArray(c.interviews) ? c.interviews : [],
    questions: Array.isArray(c.questions) ? c.questions : [],
    fundingRounds: Array.isArray(c.fundingRounds) ? c.fundingRounds : [],
    strategyPhases: Array.isArray(c.strategyPhases) ? c.strategyPhases : [],
    verdict: c.verdict && typeof c.verdict === 'object' ? c.verdict : null,
  };
}

/** 由旧 `industry` 自由文本推断标准类目；推断不出落「未分类」。 */
export function inferIndustryCategory(text: string): string {
  const t = String(text || '').toLowerCase();
  if (!t) return 'other-none';
  // 先看二级赛道名（含 group 前缀的写法，如「人工智能·AI 应用」）
  for (const cat of Object.values(INDUSTRY_TAXONOMY)) {
    if (t.includes(cat.label.toLowerCase())) return cat.id;
  }
  // 再走别名命中（取第一个命中的类目）
  for (const [alias, cats] of INDUSTRY_ALIASES) {
    if (t.includes(alias)) return [...cats][0];
  }
  return 'other-none';
}

/* ============================================================ 检索 */

export interface ExpandedQuery {
  terms: string[];
  categories: string[];
}

/** 查询词 → {原词 + 命中别名, 命中类目}。大小写不敏感。查询词本身即别名时只收类目、别名不重复入列。 */
export function expandIndustryQuery(q: string): ExpandedQuery {
  const t = String(q || '').toLowerCase().trim();
  if (!t) return { terms: [], categories: [] };
  const terms = [t];
  const categories = new Set<string>();
  for (const [alias, cats] of INDUSTRY_ALIASES) {
    if (!t.includes(alias)) continue;
    for (const cat of cats) categories.add(cat);
    if (alias !== t && !terms.includes(alias)) terms.push(alias);
  }
  return { terms, categories: [...categories] };
}

export interface CompanyRowLike {
  name?: string;
  industry?: string;
  location?: string;
  note?: string;
  summary?: string;
  tags?: string[];
  industryCategory?: string;
  industryAliases?: string[];
  research?: ResearchItem[];
  jds?: Array<Record<string, any>>;
}

/** 全文拼接（搜索底料）：基本信息 + 摘要 + 标签 + 调研正文 + JD 技能与岗位。 */
export function companyAllText(c: CompanyRowLike): string {
  return [
    c.name, c.industry, c.location, c.note, c.summary,
    ...(c.tags || []),
    ...(c.research || []).map((r) => `${r.platform || ''} ${r.content || ''}`),
    ...(c.jds || []).map((j) => `${j.title || j.name || ''} ${j.skills || ''} ${j.requirements || ''} ${j.description || ''}`),
  ]
    .join(' \n ')
    .toLowerCase();
}

/**
 * 公司命中查询（三层，命中即返回）：
 *   ① 字面：查询词出现在公司全文（基本信息 + 摘要 + 标签 + 调研正文 + JD）。
 *   ② 正文赛道词：查询词命中的类目下，正文含该类目任一别名——查「llm」、正文写「大模型」也算命中。
 *   ③ 类目相交：公司类目（显式 industryCategory / 旧 industry 自由文本推断 / 自定义别名推断）与查询类目相交。
 * viaIndustry 返回命中的赛道词或类目名，用于卡片「按行业」提示。
 */
export function matchCompany(c: CompanyRowLike, q: string): { hit: boolean; viaIndustry: string | null } {
  const t = String(q || '').toLowerCase().trim();
  if (!t) return { hit: true, viaIndustry: null };
  const allText = companyAllText(c);
  if (allText.includes(t)) return { hit: true, viaIndustry: null };
  const expanded = expandIndustryQuery(t);
  for (const cat of expanded.categories) {
    for (const alias of ALIAS_BY_CATEGORY.get(cat) || []) {
      if (isFuzzyUnsafe(alias)) continue;
      if (allText.includes(alias)) return { hit: true, viaIndustry: alias };
    }
  }
  const cats = new Set<string>([
    c.industryCategory || '',
    inferIndustryCategory(String(c.industry || '')),
    ...(c.industryAliases || []).map((a) => inferIndustryCategory(a)),
  ]);
  for (const cat of expanded.categories) {
    if (cats.has(cat)) return { hit: true, viaIndustry: INDUSTRY_TAXONOMY[cat]?.label || cat };
  }
  return { hit: false, viaIndustry: null };
}

/* ============================================================ 完整度 */

export interface Coverage {
  covered: string[];
  missing: string[];
  ratio: number;
}

/** 六维完整度：某维度至少有一条调研正文即视为已覆盖。 */
export function dimensionCoverage(c: CompanyRowLike): Coverage {
  const covered = RESEARCH_DIMS.filter((dim) =>
    (c.research || []).some((r) => r.dim === dim && String(r.content || '').trim())
  );
  const missing = RESEARCH_DIMS.filter((d) => !covered.includes(d));
  return { covered, missing, ratio: covered.length / RESEARCH_DIMS.length };
}

/* ============================================================ 多公司对比 */

/** 对比维度定义：key → 展示名。按「决策重要度」排序。 */
export const COMPARE_DIMS = {
  industry: '行业',
  scale: '规模',
  location: '地点',
  website: '官网',
  coverage: '完整度',
  research: '调研条目',
  jd: '岗位 JD',
  referral: '内推',
  recommendation: '推荐度',
  expectedSalary: '期望薪资',
  salaryRange: '薪资区间',
  funding: '融资',
  concerns: '关注点',
  redline: '风险红线',
  questions: '待核实问题',
} as const;

export type CompareDimKey = keyof typeof COMPARE_DIMS;

/** 单家公司某一维度的对比单元格：文本值 + 是否缺失（用于灰态空位）。 */
export interface CompareCell {
  text: string;
  /** true 表示该维度在这家公司没有数据（展示为空态）。 */
  empty: boolean;
}

export type CompareRow = Record<CompareDimKey, CompareCell>;

/** 薪资区间 → 对比摘要文本（如「25–40K×14 · 算法岗」）。 */
function salarySummary(salaries: SalarySample[]): string {
  if (!salaries.length) return '';
  const s = salaries[0];
  const unit = s.period === '年薪' ? '万/年' : 'K/月';
  const fmt = (n?: number) => (n != null ? `${n}` : '?');
  const range = `${fmt(s.low)}–${fmt(s.high)}${unit}`;
  const months = s.months ? `×${s.months}` : '';
  const role = s.role ? ` · ${s.role}` : '';
  return `${range}${months}${role}`;
}

/** 融资 → 对比摘要文本（如「B轮 · 累计约3亿 · 2026」）。 */
function fundingSummary(rounds: FundingRound[]): string {
  if (!rounds.length) return '';
  const latest = rounds[rounds.length - 1];
  const round = latest.round || '未披露';
  const total = rounds
    .filter((r) => r.amount != null)
    .reduce((n, r) => n + (r.amountUnit === '万' ? (r.amount! / 10000) : (r.amount!)), 0);
  const totalText = total > 0 ? `累计约${total.toFixed(total >= 1 ? 1 : 3)}亿` : '';
  const date = latest.date ? ` · ${latest.date}` : '';
  return `${round}轮${totalText ? ` · ${totalText}` : ''}${date}`;
}

/**
 * 把一家公司压成对比矩阵的一行。引用 `normalizeCompany` 保证与详情页口径一致。
 * 额外注入 `referralCount`（内推数）与 `jdCount`（JD 数，来自关联表，不在 payload 内）。
 */
export function companyCompareRow(
  company: CompanyRowLike,
  opts: { referralCount?: number; jdCount?: number } = {}
): CompareRow {
  const c = normalizeCompany(company as CompanyIntel);
  const cov = dimensionCoverage(c);
  const cat = INDUSTRY_TAXONOMY[c.industryCategory || 'other-none'];
  const catLabel = cat ? `${cat.group} · ${cat.label}` : c.industryCategory || '—';
  const verdict = c.verdict as Record<string, any> | null | undefined;
  const salaries = normalizeSalaries(c.salaries);
  const rounds = normalizeFundingRounds(c.fundingRounds);

  const cell = (text: string, empty: boolean): CompareCell => ({ text, empty });
  const opt = (v: unknown): CompareCell => {
    const s = String(v || '').trim();
    return s ? cell(s, false) : cell('—', true);
  };

  return {
    industry: opt(c.industry ? catLabel : catLabel),
    scale: opt(c.scale),
    location: opt(c.location),
    website: opt(c.website),
    coverage: cell(`${cov.covered.length}/6 维（${Math.round(cov.ratio * 100)}%）`, false),
    research: cell(String(c.research?.length || 0), false),
    jd: cell(String(opts.jdCount ?? c.jds?.length ?? 0), false),
    referral: cell(String(opts.referralCount ?? 0), false),
    recommendation: opt(verdict?.recommendation),
    expectedSalary: opt(verdict?.expectedSalary),
    salaryRange: opt(salarySummary(salaries)),
    funding: opt(fundingSummary(rounds)),
    concerns: opt(verdict?.concerns),
    redline: opt(verdict?.redline),
    questions: cell(
      String((c.questions || []).filter((q: any) => !q.status || q.status === '待核实').length),
      false
    ),
  };
}

/** 对比矩阵：维度为行、公司为列。rowKey 为维度 key，返回该维度所有公司的单元格。 */
export function buildCompareTable(
  rows: Array<{ name: string; row: CompareRow }>
): Array<{ dim: CompareDimKey; label: string; cells: CompareCell[] }> {
  return (Object.keys(COMPARE_DIMS) as CompareDimKey[]).map((dim) => ({
    dim,
    label: COMPARE_DIMS[dim],
    cells: rows.map((r) => r.row[dim]),
  }));
}

/* ============================================================ 简报 */

export interface BriefConfig {
  sections?: string[];
  includeRumors?: boolean;
  includeVerdict?: boolean;
  includeJds?: boolean;
  includeInterviews?: boolean;
  includeQuestions?: boolean;
}

/** 脱敏白名单（纯函数）：风闻与私人判断默认排除，勾选需显式确认。 */
export function briefFilter(config: BriefConfig): BriefConfig {
  return {
    sections: config.sections,
    includeRumors: config.includeRumors === true,
    includeVerdict: config.includeVerdict === true,
    includeJds: config.includeJds !== false,
    includeInterviews: config.includeInterviews === true,
    includeQuestions: config.includeQuestions === true,
  };
}

const mdEscape = (s: unknown) => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** 生成 Markdown 公司简报（面试前速览 / 汇总回复）。默认排除风闻与私人判断。 */
export function buildBrief(
  company: CompanyRowLike,
  jds: Array<Record<string, any>> = [],
  config: BriefConfig = {}
): string {
  const cfg = briefFilter(config);
  const c = normalizeCompany(company as CompanyIntel);
  const out: string[] = [];
  out.push(`# ${c.name} · 公司简报`);
  const meta = [c.industry, c.scale, c.location].filter(Boolean).join(' · ');
  if (meta) out.push(`> ${meta}${c.website ? ` · [官网](${c.website})` : ''}`);
  if (c.summary) out.push('', `**摘要**：${c.summary}`);
  if (c.tags?.length) out.push('', `**标签**：${c.tags.map((t) => `\`${t}\``).join(' ')}`);
  const dims = (cfg.sections && cfg.sections.length ? cfg.sections : [...RESEARCH_DIMS]);
  for (const dim of dims) {
    const items = (c.research || []).filter((r) => r.dim === dim && String(r.content || '').trim());
    if (!items.length) continue;
    out.push('', `## ${dim}`);
    for (const r of items) {
      const src = [r.platform, r.date].filter(Boolean).join(' · ');
      out.push(`- ${String(r.content).trim()}${src ? ` _（${src}）_` : ''}`);
    }
  }
  if (cfg.includeJds && jds.length) {
    out.push('', '## 岗位 / JD');
    for (const j of jds) {
      const title = j.title || j.name || '岗位';
      const salary = j.salary ? `（${j.salary}）` : '';
      out.push(`- **${title}**${salary}${j.city ? ` · ${j.city}` : ''}${j.level ? ` · ${j.level}` : ''}`);
      if (j.requirements) out.push(`  - 要求：${mdEscape(j.requirements)}`);
      if (j.skills) out.push(`  - 技能：${mdEscape(j.skills)}`);
    }
  }
  if (cfg.includeVerdict && c.verdict) {
    out.push('', '## 我的判断（内部）');
    const v = c.verdict as Record<string, any>;
    if (v.recommendation) out.push(`- 推荐度：${v.recommendation}`);
    if (v.expectedSalary) out.push(`- 期望薪资 / 谈判底线：${mdEscape(v.expectedSalary)}`);
    if (v.resumeFor) out.push(`- 对应简历：${mdEscape(v.resumeFor)}`);
    if (v.concerns) out.push(`- 关注点：${mdEscape(v.concerns)}`);
    if (v.redline) out.push(`- 风险红线：${mdEscape(v.redline)}`);
  }
  if (cfg.includeInterviews && c.interviews?.length) {
    out.push('', '## 面试与面经');
    for (const it of c.interviews) {
      const head = [it.round, it.form, it.date].filter(Boolean).join(' · ');
      out.push(`- **${head || '面试'}**${it.duration ? `（${it.duration}）` : ''}`);
      if (it.questions) out.push(`  - 真题 / 内容：${mdEscape(it.questions)}`);
      if (it.style) out.push(`  - 面试官风格：${mdEscape(it.style)}`);
      if (it.feedback) out.push(`  - 反馈 / 结果：${mdEscape(it.feedback)}`);
      if (it.offerDeadline) out.push(`  - offer 时效：${mdEscape(it.offerDeadline)}`);
    }
  }
  if (cfg.includeQuestions && c.questions?.length) {
    out.push('', '## 待核实问题清单');
    for (const q of c.questions) {
      const stat = q.status === '已核实' ? '' : ` _（${q.status || '待核实'}）_`;
      out.push(`- ${String(q.text || '').trim()}${stat}`);
    }
  }
  if (cfg.includeRumors && c.rumors?.length) {
    out.push('', '## 风闻 / 未证实（内部参考 · 请勿外传）');
    for (const r of c.rumors) {
      out.push(`- ${String(r.content || '').trim()} _（${r.credibility || '未证实'}）_`);
    }
  }
  const sourceCount = (c.research || []).length;
  out.push('', '---', `生成于 CareerAgent · 信息以原始来源为准 · 本简报引用 ${sourceCount} 条调研`);
  return out.join('\n');
}

/* ============================================================ 简报图片 */

/** HTML 转义，简报图片用的最小实现。 */
const htmlEscape = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** 极简 Markdown → HTML（简报图片版）：只处理标题 / 引用 / 列表 / 粗体 / 分隔线。 */
function briefMarkdownToHtml(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let listOpen = false;

  const closeList = () => {
    if (listOpen) {
      out.push('</ul>');
      listOpen = false;
    }
  };

  for (const raw of lines) {
    const line = raw;
    if (/^# /.test(line)) {
      closeList();
      out.push(`<h1>${htmlEscape(line.slice(2))}</h1>`);
    } else if (/^## /.test(line)) {
      closeList();
      out.push(`<h2>${htmlEscape(line.slice(3))}</h2>`);
    } else if (/^> /.test(line)) {
      closeList();
      out.push(`<p class="meta">${htmlEscape(line.slice(2))}</p>`);
    } else if (/^---$/.test(line)) {
      closeList();
      out.push('<hr/>');
    } else if (/^- /.test(line)) {
      if (!listOpen) {
        out.push('<ul>');
        listOpen = true;
      }
      const body = line.slice(2);
      // 先转义，再把 **粗体** / `code` 标记替换为标签
      const rich = htmlEscape(body)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
      out.push(`<li>${rich}</li>`);
    } else if (/^\s{2}- /.test(line)) {
      // 子列表（JD 的「  - 要求：」），简化：并入上一个 li 作为段落
      if (listOpen) {
        out.push(`<li class="sub">${htmlEscape(line.trim().slice(2))}</li>`);
      }
    } else if (line.trim() === '') {
      // 空行：关闭列表以保持块状结构
      closeList();
    } else {
      closeList();
      // 先转义，再把 **粗体** / `code` 标记替换为标签
      const rich = htmlEscape(line)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
      out.push(`<p>${rich}</p>`);
    }
  }
  closeList();
  return out.join('\n');
}

/**
 * 把 Markdown 简报包成一张固定宽度、强制浅色、黑白灰的导出 HTML（§10.3）。
 * 不引入任何外部资源，字体走系统栈；供服务端 headless Chrome 截图成 PNG。
 */
export function buildBriefHtml(md: string, opts: { watermark?: boolean } = {}): string {
  const body = briefMarkdownToHtml(md);
  const watermark = opts.watermark
    ? '<div class="watermark">内部参考 · 请勿外传</div>'
    : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    width: 720px;
    margin: 0;
    padding: 36px 40px;
    background: #ffffff;
    color: #1a1a1a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 20px;
    line-height: 1.7;
  }
  h1 { font-size: 30px; margin: 0 0 12px; border-bottom: 2px solid #e0e0e0; padding-bottom: 12px; }
  h2 { font-size: 22px; margin: 26px 0 10px; color: #111; }
  p { margin: 8px 0; }
  p.meta { color: #666; font-size: 16px; }
  ul { margin: 6px 0; padding-left: 24px; }
  li { margin: 6px 0; }
  li.sub { list-style: none; color: #555; font-size: 17px; margin-left: -24px; }
  strong { font-weight: 600; color: #000; }
  code { background: #f2f2f2; padding: 1px 6px; border-radius: 4px; font-size: 17px; }
  hr { border: none; border-top: 1px solid #e0e0e0; margin: 24px 0 10px; }
  .watermark {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-28deg);
    font-size: 60px; font-weight: 600; color: rgba(0,0,0,0.08); white-space: nowrap;
    pointer-events: none; z-index: 10;
  }
</style>
</head>
<body>
${watermark}
${body}
</body>
</html>`;
}
