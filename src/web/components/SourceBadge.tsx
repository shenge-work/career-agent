import type { AiActionSource } from '../api';

/**
 * P1-1 · 动作结果来源徽标：统一渲染「AI / 规则 / 规则（降级）」。
 * ai=大模型成功；fallback=未配置 AI 的规则/模板结果；error=AI 失败后的降级结果。
 */
export default function SourceBadge({ source }: { source: AiActionSource }) {
  const map: Record<AiActionSource, { label: string; tone: string }> = {
    ai: { label: 'AI', tone: 'tone-blue' },
    fallback: { label: '规则', tone: 'tone-amber' },
    error: { label: '规则（降级）', tone: 'tone-red' },
  };
  const m = map[source] || map.fallback;
  return <span className={`status-badge ${m.tone}`}>{m.label}</span>;
}
