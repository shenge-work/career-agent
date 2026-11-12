import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fmtTime, getAiUsage, type AiUsageStats } from '../api';

/**
 * 用量统计面板（嵌入「账号与设置 → 用量统计」section）：账号级 AI 调用对账。
 *
 * 数据源是 append-only 的 ai_usage_events 明细（每次调用一行），因此 token 精确累加、
 * 可逐厂商 / 逐模型对账。范围 7 天 / 30 天 / 全部。
 *
 * 本面板展示三层：
 *   1. 全局概览 —— 请求 / 失败率 / tokens / 平均耗时；
 *   2. 厂商对账 —— 每个厂商的请求、失败、token、平均耗时、最近调用；
 *   3. 模型对账 —— 每个模型同上（附所属厂商）。
 * 底部是按日趋势（从明细实时聚合）。
 */

const RANGES = [
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
  { key: 'all', label: '全部' },
] as const;

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function pct(part: number, whole: number): string {
  if (!whole) return '0%';
  return ((part / whole) * 100).toFixed(1) + '%';
}

function MetricCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'green' | 'red' | 'amber' }) {
  return (
    <div className="usage-metric">
      <span className="usage-metric-label">{label}</span>
      <span className={'usage-metric-value' + (tone ? ` tone-${tone}` : '')}>{value}</span>
      {sub && <span className="muted small">{sub}</span>}
    </div>
  );
}

/** 通用分组对账表：厂商 / 模型共用。 */
function GroupTable({
  title,
  groups,
  totalTokens,
}: {
  title: string;
  groups: AiUsageStats['providers'] | AiUsageStats['models'];
  totalTokens: number;
}) {
  if (groups.length === 0) {
    return (
      <section className="panel">
        <h3 className="sub" style={{ margin: 0 }}>{title}</h3>
        <p className="muted small" style={{ marginTop: 8 }}>该时间范围内还没有调用记录。</p>
      </section>
    );
  }
  return (
    <section className="panel">
      <h3 className="sub" style={{ margin: 0 }}>{title}</h3>
      <div className="usage-table-wrap">
        <table className="usage-table">
          <thead>
            <tr>
              <th>{title === '按厂商对账' ? '厂商' : '模型'}</th>
              {title === '按模型对账' && <th>厂商</th>}
              <th className="num">请求</th>
              <th className="num">失败</th>
              <th className="num">Prompt Tokens</th>
              <th className="num">Completion Tokens</th>
              <th className="num">Tokens 占比</th>
              <th className="num">平均耗时</th>
              <th>最近调用</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const gt = g.promptTokens + g.completionTokens;
              const errRate = g.requests ? (g.errors / g.requests) * 100 : 0;
              return (
                <tr key={g.key}>
                  <td className="mono">{g.key}</td>
                  {title === '按模型对账' && <td className="mono small faint">{g.provider || '—'}</td>}
                  <td className="num">{g.requests}</td>
                  <td className={'num' + (errRate >= 20 ? ' tone-red' : '')}>{g.errors}</td>
                  <td className="num">{fmtTokens(g.promptTokens)}</td>
                  <td className="num">{fmtTokens(g.completionTokens)}</td>
                  <td className="num">
                    <span className="usage-bar">
                      <span className="usage-bar-fill" style={{ width: pct(gt, totalTokens) }} />
                      <span className="usage-bar-text">{pct(gt, totalTokens)}</span>
                    </span>
                  </td>
                  <td className="num">{g.avgLatencyMs != null ? `${g.avgLatencyMs}ms` : '—'}</td>
                  <td className="small muted">{g.lastAt ? fmtTime(g.lastAt) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** 按日趋势迷你柱状图（请求量，成功/失败分色）。 */
function DailyTrend({ days }: { days: AiUsageStats['days'] }) {
  const max = Math.max(1, ...days.map((d) => d.requests + d.errors));
  if (days.length === 0) return null;
  return (
    <section className="panel">
      <h3 className="sub" style={{ margin: 0 }}>按日趋势</h3>
      <div className="ai-chart-bars" style={{ marginTop: 12 }}>
        {days.map((d) => {
          const ok = d.requests;
          const err = d.errors;
          const hOk = Math.max(ok ? 3 : 2, Math.round((ok / max) * 100));
          const hErr = Math.max(err ? 3 : 0, Math.round((err / max) * 100));
          return (
            <div className="ai-chart-col" key={d.day} title={`${d.day} · 成功 ${ok} / 失败 ${err} · ${fmtTokens(d.promptTokens + d.completionTokens)} tokens`}>
              <div className="ai-chart-stack">
                <div className="ai-chart-bar ai-bar-ok" style={{ height: `${hOk}%` }} />
                {err > 0 && <div className="ai-chart-bar ai-bar-err" style={{ height: `${hErr}%` }} />}
              </div>
              <span className="ai-chart-label">{d.day.slice(5)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function UsagePanel() {
  const [range, setRange] = useState<string>('30d');

  const { data, isLoading } = useQuery({
    queryKey: ['ai-usage', range],
    queryFn: () => getAiUsage(range),
  });

  const totalTokens = useMemo(() => data?.totals.totalTokens ?? 0, [data]);

  return (
    <section className="panel">
      <h2>用量统计</h2>
      <p className="muted small">本账号的 AI 调用对账：按厂商与模型拆分 token 用量，便于后续与上游账单核对。</p>

      <div className="btn-row" style={{ marginBottom: 16 }}>
        {RANGES.map((r) => (
          <button
            key={r.key}
            className={'mini' + (range === r.key ? ' primary' : '')}
            onClick={() => setRange(r.key)}
          >
            {r.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <p className="muted small">正在读取用量…</p>
      ) : !data ? (
        <p className="muted small">加载失败。</p>
      ) : (
        <>
          {/* 全局概览 */}
          <div className="usage-metrics">
            <MetricCard label="请求次数" value={String(data.totals.requests)} sub={`失败 ${data.totals.errors}`} />
            <MetricCard
              label="失败率"
              value={data.totals.errorRate.toFixed(1) + '%'}
              tone={data.totals.errorRate >= 20 ? 'red' : data.totals.errorRate > 0 ? 'amber' : 'green'}
              sub={data.totals.errorRate >= 20 ? '超过 20% 告警阈值' : undefined}
            />
            <MetricCard label="Prompt Tokens" value={fmtTokens(data.totals.promptTokens)} />
            <MetricCard label="Completion Tokens" value={fmtTokens(data.totals.completionTokens)} />
            <MetricCard label="Tokens 合计" value={fmtTokens(data.totals.totalTokens)} />
            <MetricCard label="平均耗时" value={data.totals.avgLatencyMs != null ? `${data.totals.avgLatencyMs}ms` : '—'} />
          </div>

          {data.totals.requests === 0 && (
            <div className="hint">
              该时间范围内还没有 AI 调用记录。配置并保存模型后，JD 解析、投递话术、面试复盘等会在此累计用量。
            </div>
          )}

          <GroupTable title="按厂商对账" groups={data.providers} totalTokens={totalTokens} />
          <GroupTable title="按模型对账" groups={data.models} totalTokens={totalTokens} />
          <DailyTrend days={data.days} />
        </>
      )}
    </section>
  );
}
