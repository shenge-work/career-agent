/* =============================================================
 * N14 · AI 面试练习的 prompt 纯函数层（可单测、无 Nest / DB 依赖）。
 *
 * 职责：把「练习上下文」组装成发给大模型的 messages 与 system prompt。
 * 服务端负责拼 prompt，前端不直接拼（防 prompt 注入 + 保证质量）。
 *
 * 事实护栏铁律：出题 / 范例答案只引用「简历片段」里真实存在的经历与技能，
 * 不得编造任何项目、数字、公司名、时间段；评分只依据提供的题干 + 答案原文。
 * ============================================================= */

import {
  DIMENSION_CODES,
  type DimensionCode,
  type RubricDimension,
} from './rubric';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface QuestionContext {
  /** 岗位 JD 原文（可空 → 通用题） */
  jdText: string;
  /** 简历扁平化文本（可空 → 通用题） */
  resumeText: string;
  /** behavioral / project / hr / system_design / mixed */
  questionType: string;
  /** easy / standard / hard */
  difficulty: string;
  /** 本次要出的题数 */
  questionCount: number;
  /** 弱项维度描述（可空），用于专项出题 */
  weaknessContext: string;
}

export interface FollowUpContext {
  question: string;
  answerText: string;
  /** 已完成的追问层数（0 = 首次追问） */
  turn: number;
  maxFollowUps: number;
}

export interface ScoreContext {
  question: string;
  answerText: string;
  rubric: RubricDimension[];
  rubricVersion: string;
}

export interface SampleAnswerContext {
  question: string;
  resumeText: string;
  jdText: string;
}

/** 把简历 payload 扁平化为一段可注入 prompt 的文本（只读，不编造）。 */
export function flattenResume(payload: Record<string, unknown>): string {
  const data = (payload && (payload as any).data) || {};
  const parts: string[] = [];
  const walk = (node: any): void => {
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

/** 从大模型返回的文本里稳健地解析 JSON（容忍 markdown 代码块与前后缀噪音）。 */
export function parseJsonLoose<T>(raw: string): T | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  let candidate = s;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();
  else {
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first !== -1 && last > first) candidate = s.slice(first, last + 1);
  }
  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
}

/** 出题 messages：一次出 1~N 道，只基于材料出题，不编造经历/公司/数字。 */
export function buildQuestionsMessages(ctx: QuestionContext): ChatMessage[] {
  const sys = [
    '你是一名资深面试官，负责为候选人出面试练习题。',
    '铁律（事实护栏）：只依据「简历片段 / JD / 弱项上下文」里真实存在的内容出题，不得编造候选人的任何经历、公司名、项目数字或时间段；材料没写的一律不写。',
    '题目必须能追溯到材料里的具体片段（用 basis 标明来源）。',
    '只输出一个合法 JSON 对象，不要输出解释、前后缀或 markdown 代码块。',
    '字段：questions（字符串数组对象数组），每个元素含：question（题干）、type（behavioral|project|hr|system_design）、dimension（D1|D2|D3|D4|D5|D6，行为题可给 D1，项目深挖可给 D2/D3，系统设计可给 D5，HR 动机可给 D2，不确定给 null）、basis（对象：{source: resume|jd|generic|weakness, excerpt: 材料原文片段}）、difficulty（easy|standard|hard）。',
  ].join('\n');

  const user =
    '目标题型：' + (ctx.questionType || 'mixed') + '\n' +
    '难度：' + (ctx.difficulty || 'standard') + '\n' +
    '出题数量：' + Math.max(1, Math.min(ctx.questionCount || 3, 10)) + '\n\n' +
    '岗位 JD：\n"""\n' + (ctx.jdText || '（未提供）').slice(0, 8000) + '\n"""\n\n' +
    '简历片段（只可引用其中内容）：\n"""\n' + (ctx.resumeText || '（未提供）').slice(0, 12000) + '\n"""\n\n' +
    '弱项上下文（若提供，请针对性出题）：\n"""\n' + (ctx.weaknessContext || '（无）') + '\n"""';

  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

/** 追问 messages：引用上一轮回答，按 STAR 缺项补齐，≤2 层，证据够了就停。 */
export function buildFollowUpMessages(ctx: FollowUpContext): ChatMessage[] {
  const sys = [
    '你是一名面试官，正在做结构化追问。',
    '铁律：必须引用上一轮回答的具体内容（非通用追问模板），按 STAR 缺项（S/T/A/R/Reflection）补齐追问；最多追问 ' + Math.max(1, ctx.maxFollowUps || 2) + ' 层，证据够了就停；不因答得短而无限追问。',
    '只输出一个合法 JSON 对象，不要输出解释、前后缀或 markdown 代码块。',
    '字段：followUp（追问文本，一句话）、target（本轮追问针对的缺项，如「缺 Result」「缺个人动作」）、enough（布尔，证据已足够无需再追问时为 true）。',
  ].join('\n');

  const user =
    '题干：\n"""\n' + (ctx.question || '').slice(0, 4000) + '\n"""\n\n' +
    '候选人上一轮回答：\n"""\n' + (ctx.answerText || '').slice(0, 6000) + '\n"""\n\n' +
    '已追问层数：' + Math.max(0, ctx.turn || 0) + ' / ' + Math.max(1, ctx.maxFollowUps || 2);

  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

/** 评分 messages：rubric 执行器，6 维 1~4，reason 先于 level，evidence 必须引用原文。 */
export function buildScoreMessages(ctx: ScoreContext): ChatMessage[] {
  const sys = [
    '你是 Rubric 执行器，负责给面试回答打分。',
    '铁律：固定 6 维，每维只给 1~4 档；每维先写 reason（为什么这档）再写 level；evidence 必须逐字引用答案原文片段。',
    '反偏差：不因答案更长、格式更漂亮、语气更自信而加分；不奖励空洞自信，只依据证据给档。',
    '只输出一个合法 JSON 对象，不要输出解释、前后缀或 markdown 代码块。',
    '字段：dimensions（恰好 6 条，每条含 dimension、reason、level、evidence，reason 写在 level 之前）、strengths（做得好，字符串数组，≥1 条）、actions（可执行改进动作，字符串数组，≥1 条，每条含动词 + 可替换的具体片段）、sampleAnswer（参考范例，开头标注「示范，非标准答案」）、summary（一句话总评）。',
  ].join('\n');

  const rubricJson = JSON.stringify(
    ctx.rubric.map((d) => ({
      code: d.code,
      name: d.name,
      anchors: d.anchors,
      workedExamples: d.workedExamples,
    }))
  );

  const user =
    '评分 rubric 版本：' + ctx.rubricVersion + '\n' +
    'Rubric（6 维锚定 + 每档 worked example）：\n"""\n' + rubricJson + '\n"""\n\n' +
    '题干：\n"""\n' + (ctx.question || '').slice(0, 4000) + '\n"""\n\n' +
    '候选人答案：\n"""\n' + (ctx.answerText || '').slice(0, 8000) + '\n"""';

  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

/** 范例答案 messages：基于简历 + JD 生成示范，只引用真实经历，标注「示范非标准答案」。 */
export function buildSampleAnswerMessages(ctx: SampleAnswerContext): ChatMessage[] {
  const sys = [
    '你是一名求职顾问，负责写一版参考范例答案。',
    '铁律（事实护栏）：只引用「简历片段」里真实存在的经历与技能，不得编造任何项目、数字、公司名或时间段；简历没写的一律不写。',
    '输出开头必须标注「示范，非标准答案，请用自己的话重说」。',
    '只输出一个合法 JSON 对象，不要输出解释、前后缀或 markdown 代码块。',
    '字段：sampleAnswer（参考范例答案正文）、basedOn（resume|generic，引用了简历内容为 resume，否则 generic）。',
  ].join('\n');

  const user =
    '题干：\n"""\n' + (ctx.question || '').slice(0, 4000) + '\n"""\n\n' +
    '岗位 JD：\n"""\n' + (ctx.jdText || '（未提供）').slice(0, 8000) + '\n"""\n\n' +
    '简历片段（只可引用其中内容）：\n"""\n' + (ctx.resumeText || '（未提供）').slice(0, 12000) + '\n"""';

  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

/** 范例答案的规则层降级：无 AI 时给通用结构提示，不编造经历。 */
export function fallbackSampleAnswer(question: string): { sampleAnswer: string; basedOn: 'generic' } {
  return {
    sampleAnswer:
      '（示范，非标准答案，请用自己的话重说）\n针对这道题，可以按 STAR 结构组织：先用一句话交代情境（S）与任务（T），' +
      '再重点展开你个人采取的行动（A），最后给出可量化的结果（R）与一句反思。示例骨架：\n\n' +
      '「在（时间/背景）下，我需要（任务）。我做了（个人动作 1、2、3），最终（可量化结果）。' +
      '回头看，我会（反思/改进）。」\n\n' +
      '（当前为模板范例，配置 AI 模型后可基于你的简历与 JD 生成更贴合的内容。）\n\n题目：' + String(question || '').slice(0, 400),
    basedOn: 'generic',
  };
}

/** 校验维度覆盖是否完整（供出题结果归一化使用）。 */
export function pickDimension(raw: unknown): DimensionCode | null {
  return typeof raw === 'string' && (DIMENSION_CODES as string[]).includes(raw)
    ? (raw as DimensionCode)
    : null;
}
