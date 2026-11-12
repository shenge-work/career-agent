/* =============================================================
 * N14 · AI 面试练习的评分 Rubric（纯常量 + 纯函数，无 Nest / DB 依赖）。
 *
 * 版本冻结铁律：
 *   · 改维度定义 / 文字锚 / 锚定样例 = 升级 RUBRIC_VERSION 为新常量并新增数组，
 *     绝不原地改 v1（否则历史评分口径漂移）；
 *   · 改评分 prompt 模板措辞 = 升级 PROMPT_VERSION；
 *   · 每次评分把两者写入 practice_evaluations，成长页按 rubric_version 分段。
 * ============================================================= */

export const RUBRIC_VERSION = 'v1';
export const PROMPT_VERSION = 'v1';

export type DimensionCode = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6';

export const DIMENSION_CODES: DimensionCode[] = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'];

export function isDimensionCode(v: unknown): v is DimensionCode {
  return typeof v === 'string' && (DIMENSION_CODES as string[]).includes(v);
}

export interface RubricDimension {
  code: DimensionCode;
  name: string;
  /** 每档文字锚（1~4），1 = 最弱，4 = 最强。 */
  anchors: Record<'1' | '2' | '3' | '4', string>;
  /** 每档一条 worked example（可虚构，禁止使用用户真实数据）。 */
  workedExamples: Record<'1' | '2' | '3' | '4', string>;
}

export const RUBRIC_DIMENSIONS: RubricDimension[] = [
  {
    code: 'D1',
    name: '结构与完整性',
    anchors: {
      '1': '无结构，只给结论，缺情境/任务/行动/结果',
      '2': '有情境与行动，但缺结果或反思，行动未占主体',
      '3': 'STAR 基本完整，行动占主体，有结果与少量反思',
      '4': 'STAR 完整，行动清晰主导，结果量化，反思到位',
    },
    workedExamples: {
      '1': '「我做过类似的事，最后完成了。」',
      '2': '「项目很赶，我们加班做完了。」（有情境+行动，缺量化结果）',
      '3': '「负责重构缓存层，把接口 P99 从 800ms 降到 120ms，上线无回滚。」',
      '4': '「我主导灰度方案，先 5% 再全量，回滚时间从 40 分钟压到 5 分钟，并复盘沉淀成文档。」',
    },
  },
  {
    code: 'D2',
    name: '相关性与岗位匹配',
    anchors: {
      '1': '答非所问，例子与岗位无关',
      '2': '沾边但例子难度/场景与目标岗位不匹配',
      '3': '例子与岗位相关，直击问题核心',
      '4': '例子与岗位强相关，并主动关联 JD 要求',
    },
    workedExamples: {
      '1': '问「性能优化」，答「会写 SQL 增删改查」。',
      '2': '问「高并发」，答「做过一个简单的表单页面」。',
      '3': '「针对高并发写入，我重写了缓存层并压测验证。」',
      '4': '「JD 要求高并发与稳定性，我在重构缓存层时重点解决了写放大，压测 QPS 提升 3 倍。」',
    },
  },
  {
    code: 'D3',
    name: '证据具体性',
    anchors: {
      '1': '全是形容词，无场景无数字',
      '2': '有场景但缺可核验数字与个人动作区分',
      '3': '有具体场景+部分数字，能区分个人与团队',
      '4': '数字可核验、动作归个人、结果可复现',
    },
    workedExamples: {
      '1': '「我很负责，执行力强，推动了很多事。」',
      '2': '「我们上线了新功能。」（有场景，无数字、无个人动作）',
      '3': '「我负责排期和联调，项目提前两天上线。」',
      '4': '「我主导灰度方案，把回滚时间从 40 分钟压到 5 分钟，线上故障影响用户从 2 万降到 0。」',
    },
  },
  {
    code: 'D4',
    name: '表达清晰与简洁',
    anchors: {
      '1': '逻辑跳跃、口语噪音多、听不出主线',
      '2': '主线隐约可见但冗余/绕弯',
      '3': '主线清晰、20 秒内成立、无冗余',
      '4': '简洁有力，重点前置，节奏好',
    },
    workedExamples: {
      '1': '「就是……那个……我们做了很多东西，反正最后还行。」',
      '2': '「我先说背景，再说我，然后团队也做了，最后结果还可以，中间还有个小插曲。」',
      '3': '开场即点明时间与背景，然后按行动-结果推进，无冗余。',
      '4': '「结论先行：回滚时间从 40 分钟压到 5 分钟。做法是……」重点前置，节奏干脆。',
    },
  },
  {
    code: 'D5',
    name: '逻辑自洽与抗压',
    anchors: {
      '1': '因果断裂，被追问就改口/卡壳',
      '2': '因果基本成立但经不起追问',
      '3': '因果成立，被追问后能补充',
      '4': '因果链完整，主动回应质疑与边界',
    },
    workedExamples: {
      '1': '「因为大家都很忙，所以功能没上线。」（因果不成立）',
      '2': '「我做了优化所以更快了。」（经不起「怎么做的」追问）',
      '3': '「回滚从 40 分钟压到 5 分钟，因为我把配置外置并做了预演。」',
      '4': '「5 分钟回滚的前提是配置外置；若改到核心表结构仍需停服，我准备了 B 方案。」',
    },
  },
  {
    code: 'D6',
    name: '篇幅与时间控制',
    anchors: {
      '1': '过长或过短，要点密度极低',
      '2': '篇幅失衡，部分展开过多或过少',
      '3': '篇幅适中，要点密度合理',
      '4': '篇幅与信息密度平衡，时间感强',
    },
    workedExamples: {
      '1': '只答「可以」两个字，或讲了 3 分钟无关背景。',
      '2': '前面铺垫 80 字才进入正题，结尾又仓促收尾。',
      '3': '全文约 180 字，3 段，每段一个要点。',
      '4': '约 90 秒说完：背景一句、行动一句、结果一句、反思一句，密度均衡。',
    },
  },
];

/** LLM 输出的单维评分契约。字段顺序约定 reason 先于 level（降打分漂移）。 */
export interface DimensionScore {
  dimension: DimensionCode;
  level: 1 | 2 | 3 | 4;
  reason: string;
  evidence: string;
}

/** 评分 JSON 的完整契约（与设计文档 §2.3 一致）。 */
export interface PracticeScore {
  dimensions: DimensionScore[]; // 恰好 6 条，每维一条
  strengths: string[]; // ≥1 条「做得好」（置顶）
  actions: string[]; // ≥1 条可执行改进动作
  sampleAnswer: string; // 参考范例（标注「示范，非标准答案」）
  summary: string; // 一句话总评
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function strArr(v: unknown, max = 20): string[] {
  return Array.isArray(v) ? v.slice(0, max).map((x) => str(x)).filter(Boolean) : [];
}

/**
 * 服务端白名单校验 + 归一化。任何一条不满足返回 null（= 判「未生成」，不产低分、不写画像）。
 *   · dimensions 恰好 6 条，dimension 覆盖 D1..D6 且不重复；
 *   · level 必须是 1..4 整数；reason / evidence 非空字符串；
 *   · actions 至少 1 条非空。
 * 归一化时把 reason 排在 level 之前写入对象键序，保证落库 jsonb 的字段顺序稳定。
 */
export function normalizeScore(raw: unknown): PracticeScore | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const dimsRaw = obj.dimensions;
  if (!Array.isArray(dimsRaw) || dimsRaw.length !== 6) return null;

  const seen = new Set<string>();
  const dimensions: DimensionScore[] = [];
  for (const d of dimsRaw) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    const dd = d as Record<string, unknown>;
    const dimension = dd.dimension;
    if (!isDimensionCode(dimension) || seen.has(dimension)) return null;
    seen.add(dimension);

    const level = dd.level;
    if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 4) return null;

    const reason = str(dd.reason);
    const evidence = str(dd.evidence);
    if (!reason || !evidence) return null;

    // 归一化：reason 先于 level（字段顺序不依赖 LLM 输出顺序，落库键序固定）。
    dimensions.push({ dimension, reason, level: level as 1 | 2 | 3 | 4, evidence });
  }
  if (seen.size !== 6) return null;

  const strengths = strArr(obj.strengths);
  const actions = strArr(obj.actions);
  if (!actions.length) return null;

  return {
    dimensions,
    strengths,
    actions,
    sampleAnswer: str(obj.sampleAnswer),
    summary: str(obj.summary),
  };
}

/** 用户自评维度的归一化：只收 dimension + level，reason/evidence 可空（不计入画像）。 */
export function normalizeSelfScore(
  raw: unknown
): Array<{ dimension: DimensionCode; level: 1 | 2 | 3 | 4 }> | null {
  if (!Array.isArray(raw)) return null;
  const out: Array<{ dimension: DimensionCode; level: 1 | 2 | 3 | 4 }> = [];
  const seen = new Set<string>();
  for (const d of raw) {
    if (!d || typeof d !== 'object') return null;
    const dd = d as Record<string, unknown>;
    if (!isDimensionCode(dd.dimension) || seen.has(dd.dimension)) return null;
    const level = dd.level;
    if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 4) return null;
    seen.add(dd.dimension);
    out.push({ dimension: dd.dimension, level: level as 1 | 2 | 3 | 4 });
  }
  return out.length ? out : null;
}
