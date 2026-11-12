import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getPracticeGrowth, type GrowthResult } from '../api';
import { LineTrend, PracticeCalendar, RadarChart } from './interview/charts';
import { diffText, type DiffSegment } from './interview/diff';
import './interview/styles.css';

const DIM_ORDER = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'];
const DIM_NAMES: Record<string, string> = {
  D1: '结构与完整性',
  D2: '相关性与岗位匹配',
  D3: '证据具体性',
  D4: '表达清晰与简洁',
  D5: '逻辑自洽与抗压',
  D6: '篇幅与时间控制',
};

/** N14 · 成长 / 复盘页：趋势 / 雷达 / 里程碑 / 日历 / 同题对比（严格黑白灰）。 */
export default function InterviewGrowth() {
  const { data: growth, isLoading } = useQuery({
    queryKey: ['practice-growth'],
    queryFn: () => getPracticeGrowth(),
  });

  const hasScores = useMemo(
    () => !!growth && DIM_ORDER.some((d) => (growth.profile[d]?.count || 0) > 0),
    [growth]
  );

  if (isLoading) return <div className="iv-page iv-muted">正在加载成长数据…</div>;
  if (!growth) return <div className="iv-page iv-muted">数据加载失败</div>;

  const trendLines = DIM_ORDER.filter((d) => (growth.trend[d] || []).length > 0).map((d) => ({
    label: DIM_NAMES[d],
    values: (growth.trend[d] || []).map((p) => p.level),
  }));

  return (
    <div className="iv-page">
      <div className="iv-head">
        <div>
          <h1>成长</h1>
          <p className="iv-sub">6 维画像跨会话累积 · 中断不清零 · 跨 rubric 版本不连线</p>
        </div>
        <Link className="iv-btn ghost small" to="/interview">
          ← 返回练习
        </Link>
      </div>

      {!hasScores && (
        <div className="iv-hint" style={{ marginBottom: 16 }}>
          数据不足：完成至少一次 AI 评分后，这里会显示 6 维趋势与雷达图。未配置 AI 时可用自评记录回看历史（自评不计入趋势）。
        </div>
      )}

      <div className="iv-grid-2">
        <div className="iv-card">
          <h2>6 维趋势（灰阶折线 + 线型）</h2>
          {trendLines.length ? (
            <LineTrend lines={trendLines} />
          ) : (
            <div className="iv-empty">暂无趋势数据</div>
          )}
        </div>

        <div className="iv-card">
          <h2>能力雷达（浅灰=首次，深灰粗描边=最近）</h2>
          {hasScores ? (
            <RadarChart
              labels={DIM_ORDER.map((d) => DIM_NAMES[d])}
              first={DIM_ORDER.map((d) => growth.radar.first[d] ?? null)}
              recent={DIM_ORDER.map((d) => growth.radar.recent[d] ?? null)}
            />
          ) : (
            <div className="iv-empty">暂无雷达数据</div>
          )}
        </div>
      </div>

      <div className="iv-grid-2">
        <div className="iv-card">
          <h2>里程碑</h2>
          {growth.milestones.length ? (
            growth.milestones.map((m, i) => (
              <div key={i} className="iv-milestone">
                <span className="iv-milestone-marker">▪</span>
                {m}
              </div>
            ))
          ) : (
            <div className="iv-empty">暂无里程碑</div>
          )}
        </div>

        <div className="iv-card">
          <h2>练习日历（累计 {growth.calendar.totalDays} 天，中断不清零）</h2>
          <PracticeCalendar days={growth.calendar.days} />
        </div>
      </div>

      <div className="iv-card">
        <h2>同题前后对比</h2>
        {growth.sameQuestion.length === 0 ? (
          <div className="iv-empty">暂无同题重练记录。在反馈页点「同题重练」即可生成前后对比。</div>
        ) : (
          growth.sameQuestion.map((item) => (
            <SameQuestionCard key={item.questionKey} item={item} />
          ))
        )}
      </div>
    </div>
  );
}

function SameQuestionCard({
  item,
}: {
  item: GrowthResult['sameQuestion'][number];
}) {
  const first = item.attempts[0];
  const last = item.attempts[item.attempts.length - 1];
  const levelOf = (attempt: (typeof item.attempts)[number], code: string) =>
    attempt.levels.find((l) => l.dimension === code)?.level ?? null;

  return (
    <div className="iv-compare-panel" style={{ marginBottom: 16 }}>
      <h4>{item.question}</h4>
      <div className="iv-muted iv-small" style={{ marginBottom: 8 }}>
        共 {item.attempts.length} 次作答
      </div>
      <div className="iv-compare-grid">
        <div className="iv-compare-panel">
          <h4>第 1 次答案（删除处灰底加粗）</h4>
          <DiffView segments={diffText(first?.answer || '', last?.answer || '')} mode="del" />
        </div>
        <div className="iv-compare-panel">
          <h4>本次答案（新增处灰底加粗）</h4>
          <DiffView segments={diffText(first?.answer || '', last?.answer || '')} mode="add" />
        </div>
      </div>
      <div className="iv-row" style={{ marginTop: 10 }}>
        {DIM_ORDER.map((code) => {
          const a = levelOf(first, code);
          const b = levelOf(last, code);
          const delta = a != null && b != null ? b - a : null;
          return (
            <span key={code} className="iv-small" style={{ marginRight: 12 }}>
              {DIM_NAMES[code]} <span className="iv-strong">{a ?? '—'}</span>
              <span className="iv-muted"> → </span>
              <span className="iv-strong">{b ?? '—'}</span>
              {delta != null && delta !== 0 && (
                <span className="iv-muted">（{delta > 0 ? '+' : ''}{delta} 档）</span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function DiffView({ segments, mode }: { segments: DiffSegment[]; mode: 'add' | 'del' }) {
  return (
    <div className="iv-diff">
      {segments.map((s, i) => {
        if (s.type === 'same') return <span key={i}>{s.text}</span>;
        if (mode === 'add' && s.type === 'add') return <span key={i} className="add">{s.text}</span>;
        if (mode === 'del' && s.type === 'del') return <span key={i} className="del">{s.text}</span>;
        return null;
      })}
    </div>
  );
}
