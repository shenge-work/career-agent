/* =============================================================
 * Agent 编排层的纯函数层（可单测、无 Nest / DB 依赖）。
 *
 * 职责：把「场景上下文」组装成发给大模型的 messages 与 system prompt。
 * 服务端负责拼 prompt，前端不直接拼（防 prompt 注入 + 保证质量，见 N12 §5.2）。
 *
 * 铁律（N12 §6.4）：话术/复盘不得编造经历 —— system prompt 明确「只引用
 * 简历中真实存在的经历」，生成结果标注 basedOn: resume。
 * ============================================================= */

export interface ParsedJd {
  position: string;
  company?: string;
  summary?: string;
  requirements: string[];
  preferred: string[];
  keywords: string[];
}

export interface ResumeSnippet {
  /** 简历标题 */
  title: string;
  /** 简历正文的扁平化文本（供大模型只读引用，不落库、不出本机） */
  text: string;
}

/** 把简历 payload 扁平化为一段可注入 prompt 的文本（只读，不编造）。 */
export function flattenResume(payload: Record<string, unknown>): string {
  const data = (payload && (payload as any).data) || {};
  const parts: string[] = [];
  const walk = (node: any) => {
    if (node == null) return;
    if (typeof node === 'string') {
      if (node.trim()) parts.push(node.trim());
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'object') {
      Object.keys(node).forEach((k) => {
        if (k === 'id' || k === 'type' || k === 'logo' || k === 'pageBreak') return;
        walk(node[k]);
      });
    }
  };
  walk(data);
  return parts.join('\n').slice(0, 12000);
}

/** 组装 parse-jd 的 messages：要求输出严格 JSON，规则层结果作为可解释基线一并注入。 */
export function buildParseJdMessages(jdText: string, ruleKeywords: string[]): Array<{ role: string; content: string }> {
  const sys = [
    '你是一名资深招聘顾问，负责把中文/英文 JD（职位描述）结构化抽取成 JSON。',
    '只输出一个合法 JSON 对象，不要输出任何解释、前后缀或 markdown 代码块。',
    '字段：position（岗位名）、company（公司名，可空字符串）、summary（一句话职责概括，可空字符串）、requirements（任职要求，字符串数组）、preferred（加分项，字符串数组）、keywords（核心技能关键词，字符串数组）。',
    '凡 JD 未提及的字段填空数组或空字符串，不得臆造。',
  ].join('\n');
  return [
    { role: 'system', content: sys },
    {
      role: 'user',
      content:
        'JD 原文：\n"""\n' + String(jdText || '').slice(0, 8000) + '\n"""\n\n' +
        '（规则引擎已抽到的关键词供参考，可纳入 keywords 但不得受其局限）' +
        (ruleKeywords.length ? ruleKeywords.slice(0, 40).join('、') : '无'),
    },
  ];
}

/** 组装 gen-pitch 的 messages：基于真实简历片段 + JD 结构生成打招呼话术与求职信。 */
export function buildGenPitchMessages(input: {
  jdText: string;
  jdParsed: ParsedJd | null;
  resume: ResumeSnippet;
  company?: string | null;
}): Array<{ role: string; content: string }> {
  const sys = [
    '你是一名求职顾问，帮候选人针对具体岗位写投递话术。',
    '铁律：只引用「简历片段」里真实存在的经历与技能，不得编造任何项目、数字、头衔或成果；简历没写的一律不写。',
    '只输出一个合法 JSON 对象，不要输出解释、前后缀或 markdown 代码块。',
    '字段：greeting（打招呼话术，2~3 句，点出匹配点与差异化，适合 BOSS/猎聘等 IM 场景）、coverLetter（求职信，正式结构多段，适合邮件/官网投递）。',
  ].join('\n');

  const parsed = input.jdParsed
    ? '\n岗位结构化信息：\n' + JSON.stringify(input.jdParsed, null, 2)
    : '\n岗位要求（未结构化，直接读 JD 原文）。';

  return [
    { role: 'system', content: sys },
    {
      role: 'user',
      content:
        '目标公司：' + (input.company || '（未提供）') + '\n' +
        'JD 原文：\n"""\n' + String(input.jdText || '').slice(0, 8000) + '\n"""' +
        parsed + '\n\n' +
        '简历片段（只可引用其中内容）：\n"""\n' + (input.resume.text || '（无）') + '\n"""',
    },
  ];
}

/** 从大模型返回的文本里稳健地解析 JSON（容忍 markdown 代码块与前后缀噪音）。 */
export function parseJsonLoose<T>(raw: string): T | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  let candidate = s;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();
  else candidate = extractBalancedJson(s);

  try {
    return JSON.parse(candidate) as T;
  } catch {
    // 失败回退：直接对整段文本再试一次（有些模型输出就是裸 JSON）。
    try {
      return JSON.parse(s) as T;
    } catch {
      return null;
    }
  }
}

/**
 * 从带噪音的文本里截取「首尾平衡的大括号」包围的 JSON 片段。
 * 用括号计数找首尾，而非 firstIndexOf/lastIndexOf，正确处理嵌套大括号：
 * 例如 `{"a":{"b":1},"c":[1,2]}` 不会在内部第一个 `}` 处截断。
 */
function extractBalancedJson(s: string): string {
  const first = s.indexOf('{');
  if (first === -1) return s;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = first; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(first, i + 1);
    }
  }
  // 未闭合的 JSON（半截输出）：回退到整段文本，交给 JSON.parse 报错。
  return s.slice(first);
}

/** 规则层降级：未配置 AI 时，从 JD 文本用纯规则拼一个「结构化」结果（能力有限但可用）。 */
export function fallbackParseJd(jdText: string, ruleKeywords: string[]): ParsedJd {
  const text = String(jdText || '').trim();
  const firstLine = text.split(/[\n\r]+/).map((l) => l.trim()).find(Boolean) || '';
  const position = firstLine.slice(0, 40);
  return {
    position,
    company: '',
    summary: '',
    requirements: [],
    preferred: [],
    keywords: ruleKeywords.slice(0, 40),
  };
}

/** 规则层降级：未配置 AI 时，用模板拼装打招呼话术（提示配置 AI 可获得更精准结果）。 */
export function fallbackPitch(input: {
  jdParsed: ParsedJd | null;
  ruleKeywords: string[];
}): { greeting: string; coverLetter: string; fallback: true } {
  const pos = (input.jdParsed && input.jdParsed.position) || '贵司岗位';
  const kws = input.ruleKeywords.slice(0, 5);
  const kwText = kws.length ? kws.join('、') : '相关技能';
  return {
    greeting:
      `您好，看到贵司「${pos}」岗位与我的经历高度匹配，我在 ${kwText} 方向有扎实的实战积累，期待有机会进一步沟通。` +
      '（当前为模板话术，配置 AI 模型后可生成更精准的针对性话术。）',
    coverLetter:
      `尊敬的招聘负责人：\n\n您好！我关注到贵司「${pos}」岗位，结合 JD 要求，我在 ${kwText} 方面有对应经验，` +
      '相信能胜任该岗位职责。恳请审阅我的简历，期待您的回复。\n\n此致\n敬礼',
    fallback: true,
  };
}

/* =============================================================
 * N12 S2 · 面试复盘（review-interview）+ 面经问答（kb-ask）
 * ============================================================= */

export interface InterviewReview {
  /** 一句话总评 */
  summary: string;
  /** 亮点（答得好的点） */
  strengths: string[];
  /** 待改进（答得不好 / 需补的点） */
  weaknesses: string[];
  /** 建议（下次怎么答 / 准备什么） */
  suggestions: string[];
  /** 预估通过概率提示（可空，避免过度承诺） */
  verdict?: string;
}

/** 把一次面试复盘的问题/回答/反思组装成 messages。 */
export function buildReviewInterviewMessages(input: {
  company?: string | null;
  position?: string | null;
  round?: string | null;
  /** 面试原始记录：问的问题、自己的回答、主观感受等 */
  transcript: string;
}): Array<{ role: string; content: string }> {
  const sys = [
    '你是一名资深面试复盘教练，帮候选人复盘一次面试。',
    '铁律：只基于「面试记录」里真实发生的内容给出评价与建议，不得编造面试过程或候选人没说的细节；不确定就明确说不确定。',
    '只输出一个合法 JSON 对象，不要输出解释、前后缀或 markdown 代码块。',
    '字段：summary（一句话总评，字符串）、strengths（亮点，字符串数组）、weaknesses（待改进，字符串数组）、suggestions（可执行建议，字符串数组）、verdict（一句话通过概率/信心提示，可空字符串）。',
    '语气务实、可执行，避免空洞套话。',
  ].join('\n');

  const meta = [
    input.company ? `公司：${input.company}` : '',
    input.position ? `岗位：${input.position}` : '',
    input.round ? `轮次：${input.round}` : '',
  ]
    .filter(Boolean)
    .join('，');

  return [
    { role: 'system', content: sys },
    {
      role: 'user',
      content:
        (meta ? meta + '\n' : '') +
        '面试记录：\n"""\n' + String(input.transcript || '').slice(0, 8000) + '\n"""',
    },
  ];
}

/** 规则层降级：未配置 AI 时，给出结构化空壳 + 提示配置 AI 获得智能复盘。 */
export function fallbackReviewInterview(input: {
  company?: string | null;
  position?: string | null;
}): InterviewReview {
  const pos = input.position || '该岗位';
  return {
    summary: `已完成「${input.company || '目标公司'} ${pos}」的面试记录整理（当前为模板复盘，配置 AI 模型后可生成更深入的分析）。`,
    strengths: [],
    weaknesses: [],
    suggestions: [
      '复盘时重点记录：被问到的技术/行为问题、自己的回答要点、卡壳的地方。',
      '针对答得不好的问题，补充对应的知识点或 STAR 案例。',
    ],
    verdict: '',
  };
}

export interface KbAskAnswer {
  /** 回答正文（基于知识库 + 通用经验，标注依据） */
  answer: string;
  /** 引用了哪些知识库条目（标题） */
  sources: string[];
  /** 是否直接命中知识库（false = 库中没有相关条目，答案偏通用） */
  grounded: boolean;
}

/** 把「面经库检索结果 + 用户问题」组装成 kb-ask 的 messages。 */
export function buildKbAskMessages(input: {
  question: string;
  /** 检索到的知识库片段（标题 + 分类 + 正文截断） */
  passages: Array<{ title: string; category?: string | null; content: string }>;
}): Array<{ role: string; content: string }> {
  const sys = [
    '你是一名求职顾问，回答用户关于面试/求职的问题。',
    '铁律：优先只基于「知识库片段」作答；知识库没覆盖的部分，只能给通用且不编造的建议，并明确区分「来自你的知识库」和「通用建议」。',
    '只输出一个合法 JSON 对象，不要输出解释、前后缀或 markdown 代码块。',
    '字段：answer（回答正文，字符串）、sources（引用的知识库条目标题，字符串数组，未引用则空数组）、grounded（是否直接命中知识库，布尔）。',
  ].join('\n');

  const passagesText = input.passages.length
    ? input.passages
        .map((p, i) => `[${i + 1}] ${p.title}${p.category ? `（${p.category}）` : ''}\n${p.content.slice(0, 1500)}`)
        .join('\n\n')
    : '（知识库中未检索到相关内容）';

  return [
    { role: 'system', content: sys },
    {
      role: 'user',
      content:
        '用户问题：\n"""\n' + String(input.question || '').slice(0, 2000) + '\n"""\n\n' +
        '知识库片段：\n"""\n' + passagesText + '\n"""',
    },
  ];
}

/** 规则层降级：未配置 AI 时，直接把命中的知识库原文拼出来作为回答。 */
export function fallbackKbAsk(input: {
  question: string;
  passages: Array<{ title: string; category?: string | null; content: string }>;
}): KbAskAnswer {
  const q = String(input.question || '').trim();
  if (!input.passages.length) {
    return {
      answer:
        `知识库中暂未找到与「${q}」相关的面经条目。` +
        '你可以先在面经库补充相关内容，或配置 AI 模型让我给出通用建议。',
      sources: [],
      grounded: false,
    };
  }
  const body = input.passages
    .map((p) => `【${p.title}${p.category ? ' · ' + p.category : ''}】\n${p.content.slice(0, 2000)}`)
    .join('\n\n');
  return {
    answer: `以下来自你的面经知识库：\n\n${body}`,
    sources: input.passages.map((p) => p.title),
    grounded: true,
  };
}
