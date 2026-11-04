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

/* ============================================================ 简报 */

export interface BriefConfig {
  sections?: string[];
  includeRumors?: boolean;
  includeVerdict?: boolean;
  includeJds?: boolean;
}

/** 脱敏白名单（纯函数）：风闻与私人判断默认排除，勾选需显式确认。 */
export function briefFilter(config: BriefConfig): BriefConfig {
  return {
    sections: config.sections,
    includeRumors: config.includeRumors === true,
    includeVerdict: config.includeVerdict === true,
    includeJds: config.includeJds !== false,
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
    if (v.concerns) out.push(`- 关注点：${mdEscape(v.concerns)}`);
    if (v.redline) out.push(`- 风险红线：${mdEscape(v.redline)}`);
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
