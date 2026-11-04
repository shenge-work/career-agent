/* =============================================================
 * JD 匹配分析 + 派生版本生成（服务端纯函数，移植自 v1）
 * -------------------------------------------------------------
 * 源：v1 js/jd-match.js（ResumeJd）与 js/jd-derive.js（ResumeJdDerive）。
 * 仅保留纯函数部分（extractTerms / countHits / analyze / buildDerivedPayload /
 * deriveTitle），去掉所有 DOM 操作。零依赖、不联网、纯规则。
 *
 * 分工：analyze 只做「只读匹配分析」；buildDerivedPayload 基于分析结果生成
 * 派生简历（不覆盖主简历、把缺失/弱覆盖关键词作为「待补」提示插入）。
 * ============================================================= */

/* ---------------- 术语抽取（来自 jd-match.js） ---------------- */

const EN_STOP: Record<string, 1> = {
  the: 1, and: 1, or: 1, to: 1, of: 1, in: 1, a: 1, an: 1, is: 1, are: 1, be: 1, with: 1,
  for: 1, on: 1, at: 1, by: 1, as: 1, we: 1, you: 1, your: 1, our: 1, will: 1, can: 1,
  has: 1, have: 1, it: 1, its: 1, that: 1, this: 1, from: 1, not: 1, but: 1, if: 1, all: 1,
  any: 1, more: 1, than: 1, into: 1, over: 1, per: 1, etc: 1, eg: 1, ie: 1, about: 1,
  other: 1, such: 1, using: 1, use: 1, used: 1, work: 1, works: 1, team: 1, teams: 1,
  good: 1, well: 1, strong: 1, years: 1, year: 1, plus: 1, above: 1, below: 1, must: 1,
  should: 1, need: 1, needs: 1, able: 1, like: 1, also: 1, may: 1, one: 1, two: 1, three: 1,
  new: 1, old: 1, big: 1, small: 1, job: 1, role: 1, responsibility: 1, responsibilities: 1,
  requirement: 1, requirements: 1, qualification: 1, qualifications: 1, preferred: 1,
  us: 1, who: 1, what: 1, how: 1, why: 1, when: 1, where: 1, do: 1, does: 1, did: 1,
};

const ZH_HEAD =
  /^(熟悉|精通|掌握|了解|具备|具有|拥有|有|能|可以|可|会|负责|参与|使用|熟练|要求|需要|良好|较强|一定的?|优先考虑|与|和|或|及|对|把|将|在|从|向|为)+/;
const ZH_TAIL =
  /(经验|能力|者优先|优先|者|等|等等|相关|工作|以上|以下|方面|方向|知识|技能|要求|背景|优先考虑|协作|推进|落地|搭建|部署|优化|实践|支撑|维护|迭代|调研|跟进|负责|参与|的|了)+$/;
const ZH_QUALIFY =
  /(本科|硕士|博士|专科|统招|学历|学位|专业|应届|在校|毕业|年|岁以下|岁及以下|周岁|年龄|全职|兼职|实习|沟通|责任心|团队协作|学习能力|任职|岗位|职责|描述|介绍|说明|条件|待遇|薪资|福利|地点|城市|招聘|应聘|投递|面试)/;

const EN_RE = /[A-Za-z][A-Za-z0-9+#_.\-]{0,19}/g;
const CLAUSE_SPLIT = /[\n\r。；;!！?？]+/;
const SEG_SPLIT = /[\n\r，,。；;、：:（）()【】\[\]{}<>\/|·"'.\u201c\u201d\u2018\u2019]+/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function usefulEn(w: string): string {
  const t = String(w || '').replace(/[._\-+#]+$/, '');
  if (!t) return '';
  const low = t.toLowerCase();
  if (EN_STOP[low]) return '';
  if (t.length < 2 && !/^[CR]$/.test(t)) return ''; // C / R 是有效技术词；K 多作薪资单位(30-50K)，排除
  if (/^\d+$/.test(t)) return '';
  if (t.indexOf('@') !== -1) return '';
  return t;
}

function usefulZh(seg: string): string {
  let t = String(seg || '').replace(/\s+/g, '').trim();
  t = t.replace(ZH_HEAD, '').replace(ZH_TAIL, '').trim();
  if (t.length < 2 || t.length > 10) return '';
  if (ZH_QUALIFY.test(t)) return '';
  if (/[A-Za-z]/.test(t)) return '';
  if (!/[\u4e00-\u9fa5]/.test(t)) return '';
  return t;
}

export interface Term {
  term: string;
  key: string;
  count: number;
  bonus: boolean;
}

export function extractTerms(jdText: string): Term[] {
  const text = String(jdText == null ? '' : jdText);
  if (!text.trim()) return [];
  const map: Record<string, Term> = {};
  const add = (term: string, bonus: boolean) => {
    if (!term) return;
    const key = term.toLowerCase();
    if (map[key]) {
      map[key].count++;
      if (bonus) map[key].bonus = true;
      return;
    }
    map[key] = { term, key, count: 1, bonus: !!bonus };
  };

  text.split(CLAUSE_SPLIT).forEach((clause) => {
    const bonus = /(优先|加分|更佳|nice to have|preferred|plus)/i.test(clause);
    const toks: Array<{ v: string; s: number; e: number }> = [];
    const re = new RegExp(EN_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(clause)) !== null) {
      toks.push({ v: m[0], s: m.index, e: m.index + m[0].length });
    }
    let i = 0;
    while (i < toks.length) {
      let j = i;
      let phrase = toks[i].v;
      while (j + 1 < toks.length && j - i < 2 && toks[j + 1].s - toks[j].e === 1 && /\s/.test(clause.charAt(toks[j].e))) {
        j++;
        phrase += ' ' + toks[j].v;
      }
      add(usefulEn(phrase), bonus);
      i = j + 1;
    }
    clause.split(SEG_SPLIT).forEach((seg) => add(usefulZh(seg), bonus));
  });

  return Object.keys(map).map((k) => map[k]);
}

export function countHits(term: string, text: string): number {
  const t = String(term == null ? '' : term);
  const hay = String(text == null ? '' : text);
  if (!t || !hay) return 0;
  if (/^[A-Za-z#+]/.test(t)) {
    const re = new RegExp('(?:^|[^A-Za-z0-9+#])' + escapeRe(t) + '(?![A-Za-z0-9+#])', 'gi');
    let n = 0;
    while (re.exec(hay) !== null) {
      n++;
      if (re.lastIndex === 0) break;
    }
    return n;
  }
  let c = 0;
  let i = 0;
  while ((i = hay.indexOf(t, i)) !== -1) {
    c++;
    i += t.length;
  }
  return c;
}

function sectionsOf(payload: any): Array<{ title: string; text: string }> {
  const data = (payload && payload.data) || {};
  const out: Array<{ title: string; text: string }> = [];
  const walk = (node: any, acc: string[]) => {
    if (node == null) return;
    if (typeof node === 'string') {
      if (node) acc.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((n) => walk(n, acc));
      return;
    }
    if (typeof node === 'object') {
      Object.keys(node).forEach((k) => {
        if (k === 'id' || k === 'type' || k === 'logo') return;
        walk(node[k], acc);
      });
    }
  };
  const head: string[] = [];
  ['name', 'subtitle', 'meta'].forEach((k) => walk(data[k], head));
  if (Array.isArray(data.contact)) data.contact.forEach((c: any) => walk(c, head));
  if (head.length) out.push({ title: '基本信息', text: head.join('\n') });
  (Array.isArray(data.sections) ? data.sections : []).forEach((sec: any) => {
    const acc: string[] = [];
    walk(sec, acc);
    out.push({ title: String((sec && sec.title) || '未命名板块'), text: acc.join('\n') });
  });
  return out;
}

export interface MatchItem {
  term: string;
  hits: number;
  bonus: boolean;
  jdCount: number;
  inSections: string[];
}

export interface JdAnalysis {
  stats: { total: number; covered: number; weak: number; missing: number; score: number };
  groups: { covered: MatchItem[]; weak: MatchItem[]; missing: MatchItem[] };
}

export function analyze(payload: any, jdText: string): JdAnalysis {
  const terms = extractTerms(jdText);
  const secs = sectionsOf(payload);
  const allText = secs.map((s) => s.text).join('\n');
  const groups = { covered: [] as MatchItem[], weak: [] as MatchItem[], missing: [] as MatchItem[] };

  terms.forEach((t) => {
    const hits = countHits(t.term, allText);
    const inSections: string[] = [];
    if (hits > 0) {
      secs.forEach((s) => {
        if (countHits(t.term, s.text) > 0) inSections.push(s.title);
      });
    }
    const item: MatchItem = { term: t.term, hits, bonus: t.bonus, jdCount: t.count, inSections };
    if (hits >= 2) groups.covered.push(item);
    else if (hits === 1) groups.weak.push(item);
    else groups.missing.push(item);
  });

  const byWeight = (a: MatchItem, b: MatchItem) => {
    if (a.bonus !== b.bonus) return a.bonus ? 1 : -1;
    if (b.jdCount !== a.jdCount) return b.jdCount - a.jdCount;
    return a.term < b.term ? -1 : a.term > b.term ? 1 : 0;
  };
  groups.covered.sort(byWeight);
  groups.weak.sort(byWeight);
  groups.missing.sort(byWeight);

  const total = terms.length;
  return {
    stats: {
      total,
      covered: groups.covered.length,
      weak: groups.weak.length,
      missing: groups.missing.length,
      score: total ? Math.round((100 * (groups.covered.length + 0.5 * groups.weak.length)) / total) : 0,
    },
    groups,
  };
}

/* ---------------- 派生版本生成（来自 jd-derive.js） ---------------- */

function suggestSentence(term: string): string {
  const t = String(term || '').trim();
  if (!t) return '';
  return t + '：在＿＿项目中，负责＿＿，通过＿＿使＿＿（请补真实数字与背景）。';
}

function fillGroupFor(missingTerms: string[], weakTerms: string[]): any | null {
  const m = (missingTerms || []).map((t) => String(t || '').trim()).filter(Boolean);
  const w = (weakTerms || []).map((t) => String(t || '').trim()).filter(Boolean);
  const seen: Record<string, true> = {};
  const items: string[] = [];
  const push = (t: string, tag: string) => {
    if (!t || seen[t]) return;
    seen[t] = true;
    items.push(tag + suggestSentence(t));
  };
  m.forEach((t) => push(t, '【缺失】'));
  w.forEach((t) => push(t, '【弱覆盖·需突出】'));
  if (!items.length) return null;
  return {
    name: 'JD 定制待补（请逐条改写为真实经历）',
    keywords: '',
    detail: '以下由「JD 匹配分析」的缺失/弱覆盖关键词自动生成，是待填写的提示，不是最终内容。',
    items,
  };
}

/** 基于分析结果生成派生 payload（不修改入参）。 */
export function buildDerivedPayload(payload: any, analysis: JdAnalysis): any {
  const data = payload && payload.data ? payload.data : payload || {};
  const out: any = {
    data: JSON.parse(JSON.stringify(data)),
    fonts: payload && payload.fonts ? JSON.parse(JSON.stringify(payload.fonts)) : null,
    spacing: payload && payload.spacing ? JSON.parse(JSON.stringify(payload.spacing)) : null,
    v: (payload && payload.v) || 8,
    savedAt: Date.now(),
  };
  if (!Array.isArray(out.data.sections)) out.data.sections = [];

  const groups: { missing?: MatchItem[]; weak?: MatchItem[] } = (analysis && analysis.groups) || {};
  const missing = (groups.missing || []).map((x: MatchItem) => x.term);
  const weak = (groups.weak || []).map((x: MatchItem) => x.term);
  const g = fillGroupFor(missing, weak);
  if (!g) return out;

  let target: any = null;
  out.data.sections.forEach((sec: any) => {
    if (sec && sec.type === 'skills' && !target) target = sec;
  });
  if (target) {
    if (!Array.isArray(target.groups)) target.groups = [];
    target.groups.push(g);
  } else {
    out.data.sections.push({
      id: 'jd_fill_' + Date.now().toString(36),
      type: 'skills',
      title: '专业技能',
      pageBreak: false,
      groups: [g],
    });
  }
  return out;
}

/* ---------------- 派生标题（来自 jd-derive.js） ---------------- */

const TITLE_MAX = 20;
const NOISE_LABEL =
  /^(岗位职责|职位描述|工作职责|职责描述|任职要求|任职资格|任职条件|岗位要求|职位要求|工作要求|招聘|诚聘|急聘|招募|我们希望你|你需要|你将负责|工作内容|技能要求|加分项|其他要求|福利待遇|薪资福利|团队介绍|关于我们|公司介绍|Job Description|Responsibilities|Requirements|Qualifications)\s*[：:]\s*/i;
const ENUM_HEAD = /^(?:[（(]\s*\d+\s*[)）]|\d+\s*[、.．)）]|[①-⑳]|[-•·*])\s*/;
const DUR_HEAD = /^\d+\s*年(?:以上|以内|及以上|以上工作经验|以上经验|经验)?(?:相关)?/;
const TAIL_NOISE = /(?:相关)?(?:工作)?(?:经验|优先|者优先|背景)$/;
const ROLE_WORD =
  /(工程师|开发|前端|后端|全栈|客户端|服务端|测试|运维|算法|架构师|产品经理|产品|运营|设计师?|分析师?|数据分析|项目经理|主管|经理|总监|专员|顾问|实习生|研究员|科学家|销售|市场|品牌|商务|财务|人事|法务|采购|供应链|客户成功|增长|培训师?|教师|Engineer|Developer|Manager|Designer|Analyst|Architect|Intern|Specialist|Consultant|Director|Lead|PM|SRE|DevOps)/i;
const VERB_HEAD = /^(负责|熟悉|具备|掌握|精通|了解|参与|能够|能|有|具有|要求|需要|从事|完成|推动|落地|协助)/;
const CLAUSE_SEP = /[，,；;、]/;
const SENT_END = /[。；;!！?？]/;

function stripNoise(s: string): string {
  let out = String(s == null ? '' : s).trim();
  for (let i = 0; i < 6; i++) {
    const before = out;
    out = out.replace(NOISE_LABEL, '').replace(ENUM_HEAD, '').trim();
    if (out === before) break;
  }
  return out;
}

function tidyPhrase(s: string): string {
  let out = String(s == null ? '' : s).replace(DUR_HEAD, '').trim();
  for (let i = 0; i < 4; i++) {
    const before = out;
    out = out.replace(TAIL_NOISE, '').replace(/[、，,；;：:。．.]+$/, '').trim();
    if (out === before) break;
  }
  return out;
}

function firstClause(line: string): string {
  return tidyPhrase(stripNoise(line).split(SENT_END)[0]);
}

function isTitleLike(s: string): boolean {
  if (!s || s.length > 40) return false;
  if (CLAUSE_SEP.test(s) || VERB_HEAD.test(s)) return false;
  return ROLE_WORD.test(s);
}

function shortenClue(s: string): string {
  if (s.length <= TITLE_MAX) return s;
  const i = s.indexOf('（');
  if (i > 0) {
    const head = s.slice(0, i).trim();
    const inner = s.slice(i + 1).split('）')[0];
    const city = inner.split(/[·|]/)[0].trim();
    if (head.length >= 4 && city && city.length <= 6) return head + '（' + city + '）';
  }
  return s.slice(0, 16) + '…';
}

function roleSegment(text: string): string {
  const parts = stripNoise(text).split(CLAUSE_SEP);
  for (let i = 0; i < parts.length; i++) {
    const p = tidyPhrase(parts[i]);
    if (p.length < 2 || p.length > 24) continue;
    if (VERB_HEAD.test(p) || !ROLE_WORD.test(p)) continue;
    return shortenClue(p);
  }
  return '';
}

function hintFromJd(jd: string): string {
  const lines = String(jd || '')
    .split(/[\n\r]+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 6);
  for (let i = 0; i < lines.length; i++) {
    const clue = firstClause(lines[i]);
    if (isTitleLike(clue)) return shortenClue(clue);
  }
  for (let i = 0; i < lines.length; i++) {
    const clue = roleSegment(lines[i]);
    if (clue) return clue;
  }
  return '';
}

export function deriveTitle(baseTitle: string, jdText: string): string {
  const base = String(baseTitle || '简历');
  const jd = String(jdText || '').trim();
  if (!jd) return base + ' · JD 定制版';
  let clue = hintFromJd(jd);
  if (!clue) {
    const raw = jd.split(/[\n\r]+/)[0].trim();
    clue = firstClause(raw) || raw;
    if (clue.length > 16) clue = clue.slice(0, 16) + '…';
  }
  return base + ' · 定制「' + clue + '」';
}
