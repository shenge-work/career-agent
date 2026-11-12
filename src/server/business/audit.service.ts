/* =============================================================
 * 投递体检：对一份简历 payload 做三级规则检查（纯函数、不联网）
 * -------------------------------------------------------------
 * 移植自 v1 audit.js 的思路，服务端化。五个维度：
 *   1. 基本信息完整性 —— 姓名 / 头衔 / 联系方式（电话 / 邮箱）
 *   2. 量化成果 —— career 项目 results 里含数字/百分比的占比
 *   3. 页数估算 —— 按内容量粗估 A4 页数（超页提示精简）
 *   4. ATS 友好度 —— 文本可提取性（图片 / 特殊符号 / 富文本残留）
 *   5. 敏感信息 —— 身份证 / 完整生日 / 具体门牌 / 薪资等扫描
 *
 * 返回结构化报告：每项带 level（ok / warn / fail）+ 建议文案，
 * 前端据此渲染分级体检单。
 * ============================================================= */

export interface AuditItem {
  key: string;
  title: string;
  level: 'ok' | 'warn' | 'fail';
  message: string;
  detail?: string[];
}

export interface AuditReport {
  checkedAt: number;
  score: number; // 0~100
  items: AuditItem[];
  summary: { ok: number; warn: number; fail: number };
}

const stripMark = (s: unknown): string => String(s == null ? '' : s).replace(/\*\*/g, '');

/** 遍历所有板块，产出带语义的结构化片段（复用 jd.service 的遍历思路）。 */
function walkSections(payload: any): {
  head: { name: string; subtitle: string; meta: string; contacts: string[] };
  sections: Array<{ type: string; title: string; text: string }>;
  careerResults: string[];
  allText: string;
} {
  const data = (payload && payload.data) || {};
  const walk = (node: any, acc: string[]): void => {
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
        if (k === 'id' || k === 'type' || k === 'logo' || k === 'spacing' || /Spacing$/.test(k)) return;
        walk(node[k], acc);
      });
    }
  };

  const contacts: string[] = (Array.isArray(data.contact) ? data.contact : []).map((c: any) =>
    typeof c === 'string' ? c : c && c.text ? String(c.text) : ''
  ).filter(Boolean);

  const sections: Array<{ type: string; title: string; text: string }> = [];
  const careerResults: string[] = [];

  (Array.isArray(data.sections) ? data.sections : []).forEach((sec: any) => {
    const sacc: string[] = [];
    walk(sec, sacc);
    const title = String((sec && sec.title) || '未命名板块');
    const type = String((sec && sec.type) || '');
    sections.push({ type, title, text: sacc.join('\n') });

    // 提取 career 项目的量化成果，用于「量化成果」维度
    if (type === 'career' && Array.isArray(sec.items)) {
      sec.items.forEach((job: any) => {
        (Array.isArray(job.projects) ? job.projects : []).forEach((prj: any) => {
          (Array.isArray(prj.results) ? prj.results : []).forEach((r: any) => {
            const t = r && r.text ? String(r.text) : '';
            if (t) careerResults.push(t);
          });
        });
      });
    }
    // 独立项目板块的成果同样计入
    if (type === 'projects' && Array.isArray(sec.items)) {
      sec.items.forEach((prj: any) => {
        (Array.isArray(prj.results) ? prj.results : []).forEach((r: any) => {
          const t = r && r.text ? String(r.text) : '';
          if (t) careerResults.push(t);
        });
      });
    }
  });

  const headAcc: string[] = [];
  ['name', 'subtitle', 'meta'].forEach((k) => walk(data[k], headAcc));
  contacts.forEach((c) => headAcc.push(c));
  const allText = headAcc.join('\n') + '\n' + sections.map((s) => s.text).join('\n');

  return {
    head: { name: String(data.name || ''), subtitle: String(data.subtitle || ''), meta: String(data.meta || ''), contacts },
    sections,
    careerResults,
    allText,
  };
}

/* ---------------- 维度 1：基本信息完整性 ---------------- */

const PHONE_RE = /(?:\+?86[-\s]?)?1[3-9]\d{9}|\d{3,4}[-\s]?\d{7,8}/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

function checkBasics(s: ReturnType<typeof walkSections>): AuditItem {
  const missing: string[] = [];
  if (!s.head.name.trim()) missing.push('姓名');
  if (!s.head.subtitle.trim()) missing.push('求职定位 / 头衔');
  const hasPhone = s.head.contacts.some((c) => PHONE_RE.test(c));
  const hasEmail = s.head.contacts.some((c) => EMAIL_RE.test(c));
  if (!hasPhone && !hasEmail) missing.push('联系方式（电话或邮箱）');

  if (missing.length === 0) {
    return { key: 'basics', title: '基本信息', level: 'ok', message: '姓名、定位与联系方式齐全。' };
  }
  return {
    key: 'basics',
    title: '基本信息',
    level: 'fail',
    message: `缺少：${missing.join('、')}。`,
    detail: missing,
  };
}

/* ---------------- 维度 2：量化成果 ---------------- */

const QUANT_RE = /\d+(\.\d+)?\s*(%|％|倍|万|亿|k|w|ms|qps|tps|次|个|人|项|套|台|元|条|家)/i;

function checkQuantified(s: ReturnType<typeof walkSections>): AuditItem {
  const total = s.careerResults.length;
  if (total === 0) {
    return { key: 'quant', title: '量化成果', level: 'warn', message: '尚未填写项目量化成果，建议补充数据支撑（提升率 / 性能 / 规模等）。' };
  }
  const quantified = s.careerResults.filter((r) => QUANT_RE.test(r)).length;
  const ratio = quantified / total;
  if (ratio >= 0.7) {
    return { key: 'quant', title: '量化成果', level: 'ok', message: `${quantified}/${total} 条成果含量化数据，说服力强。` };
  }
  if (ratio >= 0.4) {
    return { key: 'quant', title: '量化成果', level: 'warn', message: `${quantified}/${total} 条成果含量化数据，仍可继续补数据。` };
  }
  return { key: 'quant', title: '量化成果', level: 'warn', message: `仅 ${quantified}/${total} 条成果含量化数据，建议用数字替代形容词。` };
}

/* ---------------- 维度 3：页数估算 ---------------- */

function estimatePages(s: ReturnType<typeof walkSections>): number {
  // 粗估：中文按每行约 40 字、每页约 30 行估算；英文/符号按字符计数折算。
  const text = s.allText;
  const chars = text.length;
  // 每个板块标题/项目名额外占行，粗略 +20%
  const lines = chars / 40 * 1.2 + s.sections.length * 2 + s.careerResults.length * 1.5;
  return Math.max(1, Math.ceil(lines / 28));
}

function checkLength(s: ReturnType<typeof walkSections>): AuditItem {
  const pages = estimatePages(s);
  if (pages <= 1) {
    return { key: 'length', title: '篇幅', level: 'ok', message: `估算约 ${pages} 页，篇幅合理。` };
  }
  if (pages === 2) {
    return { key: 'length', title: '篇幅', level: 'ok', message: `估算约 2 页，资深岗位可接受。` };
  }
  return { key: 'length', title: '篇幅', level: 'warn', message: `估算约 ${pages} 页，偏长，建议精简或聚焦最相关经历。` };
}

/* ---------------- 维度 4：ATS 友好度 ---------------- */

function checkAts(s: ReturnType<typeof walkSections>): AuditItem {
  const problems: string[] = [];
  const text = s.allText;

  // 富文本加粗标记残留（** 未在渲染层消费的字段）
  if (text.includes('**')) problems.push('文本含 ** 加粗标记（ATS 会当字面字符）');

  // 特殊符号 / 图标（ATS 常无法解析）
  const iconRe = /[\u2600-\u27BF\uE000-\uF8FF]|[\u{1F300}-\u{1FAFF}]/u;
  if (iconRe.test(text)) problems.push('含 emoji / 图标字符，ATS 可能无法识别');

  // 是否依赖图片（简历内嵌图片 URL 或 base64）
  if (/data:image\/|\.(png|jpe?g|gif|svg|webp)(\?|\)|"|')/i.test(text)) problems.push('疑似含图片引用，ATS 无法解析图片内容');

  // 表格 / 竖线密集（可能是表格结构）
  if ((text.match(/\|/g) || []).length > 6) problems.push('竖线符号密集，可能来自表格，ATS 易错位');

  if (problems.length === 0) {
    return { key: 'ats', title: 'ATS 友好度', level: 'ok', message: '文本结构清晰，ATS 可正常解析。' };
  }
  return { key: 'ats', title: 'ATS 友好度', level: 'warn', message: `发现 ${problems.length} 处可能影响 ATS 解析的问题。`, detail: problems };
}

/* ---------------- 维度 5：敏感信息 ---------------- */

const SENSITIVE_RE: Array<{ name: string; re: RegExp }> = [
  { name: '身份证号', re: /\b\d{17}[\dXx]\b|\b\d{15}\b/ },
  { name: '完整出生日期', re: /(19|20)\d{2}[-年.\/]\d{1,2}[-月.\/]\d{1,2}/ },
  { name: '银行卡号', re: /\b\d{16,19}\b/ },
  { name: '具体门牌号', re: /\d{1,4}号\d{1,3}室|\d{1,4}栋\d{1,4}单元/ },
];

function checkSensitive(s: ReturnType<typeof walkSections>): AuditItem {
  const hits: string[] = [];
  const text = s.allText;
  SENSITIVE_RE.forEach(({ name, re }) => {
    if (re.test(text)) hits.push(name);
  });
  if (hits.length === 0) {
    return { key: 'sensitive', title: '敏感信息', level: 'ok', message: '未发现身份证 / 生日 / 银行卡等敏感信息。' };
  }
  return { key: 'sensitive', title: '敏感信息', level: 'fail', message: `检测到敏感信息：${hits.join('、')}，投递前建议脱敏。`, detail: hits };
}

/* ---------------- 汇总 ---------------- */

export function auditResume(payload: any): AuditReport {
  const s = walkSections(payload);
  const items: AuditItem[] = [
    checkBasics(s),
    checkQuantified(s),
    checkLength(s),
    checkAts(s),
    checkSensitive(s),
  ];
  const ok = items.filter((i) => i.level === 'ok').length;
  const warn = items.filter((i) => i.level === 'warn').length;
  const fail = items.filter((i) => i.level === 'fail').length;
  // 计分：ok 100、warn 60、fail 0，平均。
  const score = Math.round(
    items.reduce((sum, i) => sum + (i.level === 'ok' ? 100 : i.level === 'warn' ? 60 : 0), 0) / items.length
  );
  return { checkedAt: Date.now(), score, items, summary: { ok, warn, fail } };
}
