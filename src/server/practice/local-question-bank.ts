/* =============================================================
 * N14 · 内置本地题库（无 API Key / 断云降级用）。
 *
 * 纯常量 + 纯函数，无 Nest / DB 依赖。AI 不可用时从这里确定性选题，
 * 保证「无 Key 不空白、可手动作答 + 自评」的降级闭环。
 * ============================================================= */

import type { DimensionCode } from './rubric';

export type QuestionType = 'behavioral' | 'project' | 'hr' | 'system_design';
export type QuestionDifficulty = 'easy' | 'standard' | 'hard';

export interface LocalQuestion {
  question: string;
  type: QuestionType;
  difficulty: QuestionDifficulty;
  dimension: DimensionCode | null;
}

export const LOCAL_QUESTION_BANK: LocalQuestion[] = [
  // ---- 行为面（behavioral）
  { question: '讲一次你和同事在技术方案上有分歧的经历，你是怎么处理的？', type: 'behavioral', difficulty: 'standard', dimension: 'D1' },
  { question: '讲一次你主导过的最有挑战的项目，你个人做了什么、结果如何？', type: 'behavioral', difficulty: 'standard', dimension: 'D3' },
  { question: '讲一次你在截止日期前没能完成任务的经历，后来怎么补救的？', type: 'behavioral', difficulty: 'hard', dimension: 'D5' },
  { question: '讲一次你主动承担额外责任的经历。', type: 'behavioral', difficulty: 'easy', dimension: 'D1' },
  { question: '讲一次你收到负面反馈并据此改进的经历。', type: 'behavioral', difficulty: 'standard', dimension: 'D5' },
  // ---- 项目深挖（project）
  { question: '介绍一个你最近做的项目，重点讲你的角色和最有技术含量的部分。', type: 'project', difficulty: 'standard', dimension: 'D3' },
  { question: '这个项目里你做过的最关键的技术决策是什么？为什么这么选？', type: 'project', difficulty: 'standard', dimension: 'D5' },
  { question: '如果让你重做这个项目，你会在哪些地方做出不同的选择？', type: 'project', difficulty: 'hard', dimension: 'D5' },
  { question: '这个项目上线后遇到了什么线上问题，你是如何定位和解决的？', type: 'project', difficulty: 'hard', dimension: 'D3' },
  { question: '你如何评估这个项目的技术债，以及你如何控制它？', type: 'project', difficulty: 'hard', dimension: 'D2' },
  // ---- HR 动机（hr）
  { question: '你为什么想离开现在的公司？', type: 'hr', difficulty: 'easy', dimension: 'D2' },
  { question: '为什么想加入我们公司、应聘这个岗位？', type: 'hr', difficulty: 'standard', dimension: 'D2' },
  { question: '你未来三到五年的职业规划是什么？', type: 'hr', difficulty: 'standard', dimension: 'D2' },
  { question: '你期望的薪资是多少？你的理由是什么？', type: 'hr', difficulty: 'standard', dimension: 'D2' },
  // ---- 系统设计口述（system_design）
  { question: '请口述设计一个支持高并发读写的短链接系统，重点讲数据模型与扩容思路。', type: 'system_design', difficulty: 'standard', dimension: 'D5' },
  { question: '请口述设计一个分布式 ID 生成器，说明你的取舍。', type: 'system_design', difficulty: 'hard', dimension: 'D5' },
  { question: '请口述设计一个消息队列的消费者幂等与重试机制。', type: 'system_design', difficulty: 'standard', dimension: 'D5' },
  { question: '请口述如何设计一个支持千万级用户的会话（登录态）存储。', type: 'system_design', difficulty: 'hard', dimension: 'D2' },
];

function normalizeType(v: unknown): QuestionType | null {
  return v === 'behavioral' || v === 'project' || v === 'hr' || v === 'system_design' ? v : null;
}

function normalizeDifficulty(v: unknown): QuestionDifficulty | null {
  return v === 'easy' || v === 'standard' || v === 'hard' ? v : null;
}

/**
 * 从本地题库确定性选题。
 *   · type/difficulty 未指定或为 mixed 时不过滤；
 *   · 命中不足时按题库顺序循环补齐，保证返回恰好 count 道（题库非空时）。
 */
export function pickLocalQuestions(
  config: { questionType?: unknown; difficulty?: unknown; count?: number },
  count?: number
): LocalQuestion[] {
  const type = normalizeType(config.questionType);
  const difficulty = normalizeDifficulty(config.difficulty);
  const n = Math.max(1, Math.min(Number(count) || Number(config.count) || 3, 10));

  let pool = LOCAL_QUESTION_BANK.filter(
    (q) => (!type || q.type === type) && (!difficulty || q.difficulty === difficulty)
  );
  if (!pool.length) pool = LOCAL_QUESTION_BANK;

  const out: LocalQuestion[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(pool[i % pool.length]);
  }
  return out;
}
