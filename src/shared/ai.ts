/** 前后端共用的 AI 用途常量。保持零依赖，server 与 web 都可 import。 */

/**
 * fast / strong 两档模型的用途映射（已拍板）：
 *   · fast   高频轻量：JD 解析（parseJd）+ 投递话术（genPitch）
 *   · strong 复杂推理/长上下文：面试复盘（reviewInterview）+ 面经问答（kbAsk）
 */
export const MODEL_USAGE_MAP: Readonly<Record<'fast' | 'strong', readonly string[]>> = {
  fast: ['parseJd', 'genPitch'],
  strong: ['reviewInterview', 'kbAsk'],
};

export type ModelTier = 'fast' | 'strong';

/** 快/强模型的中文用途说明（AiSettings 内嵌提示与错误文案复用）。 */
export const MODEL_USAGE_HINT: Readonly<Record<ModelTier, string>> = {
  fast: '快模型用于 JD 解析与话术生成',
  strong: '强模型用于面试复盘与面经问答',
};

/** 根据动作名返回它应使用的模型档位；未知动作默认 fast（高频轻量）。 */
export function modelTierForAction(action?: string | null): ModelTier {
  const a = String(action || '');
  if ((MODEL_USAGE_MAP.strong as readonly string[]).includes(a)) return 'strong';
  return 'fast';
}

/** 动作名 → 中文用途（用量统计「按用途对账」展示用；未知动作回退原样）。 */
export const ACTION_LABELS: Readonly<Record<string, string>> = {
  parseJd: 'JD 解析',
  genPitch: '投递话术',
  reviewInterview: '面试复盘',
  kbAsk: '面经问答',
  test: '连接测试',
  chat: '试用台对话',
  complete: '结构化补全',
};

export function actionLabel(action?: string | null): string {
  const a = String(action || '');
  return ACTION_LABELS[a] ?? a;
}
