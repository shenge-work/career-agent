import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fmtTime, getAiUsage, type AiUsageStats } from '../api';
import { actionLabel } from '../../shared/ai';

/**
 * 用量统计面板（嵌入「账号与设置 → 用量统计」section）：账号级 AI 调用对账。
 *
 * 数据源是 append-only 的 ai_usage_events 明细（每次调用一行），因此 token 精确累加、
 * 可逐厂商 / 逐模型 / 逐用途对账。范围 7 天 / 30 天 / 全部。
 *
 * 本面板展示：
 *   1. 全局概览 —— 请求 / 失败率 / tokens / 平均耗时 / 预估费用；
 *   2. 厂商对账 —— 每个厂商的请求、失败、token、平均耗时、最近调用；
 *   3. 模型对账 —— 每个模型同上（附所属厂商）；
 *   4. 用途对账 —— 按 action（JD 解析 / 投递话术 / 面试复盘 / 面经问答等）；
 *   5. 厂商 × 模型透视 —— 每个厂商下每个模型的消耗；
 *   6. 错误码对账 —— 失败调用的错误码分布（仅在有失败时展示）；
 *   7. 成本估算 —— 手动填厂商单价，按 token 估算费用，便于与上游账单对账；
 *   8. 最近调用明细 —— 逐条流水（时间 / 厂商 / 模型 / 用途 / token / 耗时 / 状态）；
 *   9. 按日 token 趋势折线图 + 导出 CSV。
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

function fmtMoney(n: number): string {
  if (n < 0.01 && n > 0) return '¥' + n.toFixed(4);
  return '¥' + n.toFixed(2);
}

function pct(part: number, whole: number): string {
  if (!whole) return '0%';
  return ((part / whole) * 100).toFixed(1) + '%';
}

/** 厂商单价（元 / 百万 tokens）：prompt 与 completion 分别计价。 */
type PriceMap = Record<string, { prompt: number; completion: number }>;

const PRICE_KEY = 'ca.ai.usage.prices';

function loadPrices(): PriceMap {
  try {
    return JSON.parse(localStorage.getItem(PRICE_KEY) || '{}') as PriceMap;
  } catch {
    return {};
  }
}

function savePrices(p: PriceMap) {
  try {
    localStorage.setItem(PRICE_KEY, JSON.stringify(p));
  } catch {
    /* 忽略存储失败 */
  }
}

/** 按厂商算预估费用 = (promptTokens * prompt价 + completionTokens * completion价) / 1e6 */
function costOf(g: { promptTokens: number; completionTokens: number }, prices: PriceMap, provider: string): number {
  const p = prices[provider];
  if (!p) return 0;
  return (g.promptTokens * p.prompt + g.completionTokens * p.completion) / 1_000_000;
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

/** 按用途对账表（action：JD 解析 / 投递话术 / 面试复盘 / 面经问答 / 连接测试 / 试用台）。 */
function ActionTable({ actions, totalTokens }: { actions: AiUsageStats['actions']; totalTokens: number }) {
  if (actions.length === 0) return null;
  return (
    <section className="panel">
      <h3 className="sub" style={{ margin: 0 }}>按用途对账</h3>
      <div className="usage-table-wrap">
        <table className="usage-table">
          <thead>
            <tr>
              <th>用途</th>
              <th className="num">请求</th>
              <th className="num">失败</th>
              <th className="num">Prompt Tokens</th>
              <th className="num">Completion Tokens</th>
              <th className="num">Tokens 占比</th>
              <th className="num">平均耗时</th>
            </tr>
          </thead>
          <tbody>
            {actions.map((a) => {
              const gt = a.promptTokens + a.completionTokens;
              const errRate = a.requests ? (a.errors / a.requests) * 100 : 0;
              return (
                <tr key={a.key}>
                  <td>{actionLabel(a.key)}<span className="mono small faint" style={{ marginLeft: 6 }}>{a.key}</span></td>
                  <td className="num">{a.requests}</td>
                  <td className={'num' + (errRate >= 20 ? ' tone-red' : '')}>{a.errors}</td>
                  <td className="num">{fmtTokens(a.promptTokens)}</td>
                  <td className="num">{fmtTokens(a.completionTokens)}</td>
                  <td className="num">
                    <span className="usage-bar">
                      <span className="usage-bar-fill" style={{ width: pct(gt, totalTokens) }} />
                      <span className="usage-bar-text">{pct(gt, totalTokens)}</span>
                    </span>
                  </td>
                  <td className="num">{a.avgLatencyMs != null ? `${a.avgLatencyMs}ms` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** 错误码对账表：失败调用的错误码分布（含典型厂商/模型），便于定位哪个上游在报错。 */
function ErrorCodeTable({ errorCodes }: { errorCodes: AiUsageStats['errorCodes'] }) {
  if (errorCodes.length === 0) return null;
  return (
    <section className="panel">
      <h3 className="sub" style={{ margin: 0 }}>错误码对账</h3>
      <div className="usage-table-wrap">
        <table className="usage-table">
          <thead>
            <tr>
              <th>错误码</th>
              <th className="num">次数</th>
              <th>典型厂商</th>
              <th>典型模型</th>
            </tr>
          </thead>
          <tbody>
            {errorCodes.map((e) => (
              <tr key={e.code}>
                <td className="mono tone-red">{e.code}</td>
                <td className="num tone-red">{e.requests}</td>
                <td className="mono small faint">{e.provider || '—'}</td>
                <td className="mono small faint">{e.model || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** 厂商 × 模型交叉透视：每个厂商下每个模型的消耗。 */
function ProviderModelTable({ providerModels, totalTokens }: { providerModels: AiUsageStats['providerModels']; totalTokens: number }) {
  if (providerModels.length === 0) return null;
  return (
    <section className="panel">
      <h3 className="sub" style={{ margin: 0 }}>厂商 × 模型透视</h3>
      <div className="usage-table-wrap">
        <table className="usage-table">
          <thead>
            <tr>
              <th>厂商</th>
              <th>模型</th>
              <th className="num">请求</th>
              <th className="num">失败</th>
              <th className="num">Prompt Tokens</th>
              <th className="num">Completion Tokens</th>
              <th className="num">Tokens 占比</th>
              <th className="num">平均耗时</th>
            </tr>
          </thead>
          <tbody>
            {providerModels.map((pm) => {
              const gt = pm.promptTokens + pm.completionTokens;
              const errRate = pm.requests ? (pm.errors / pm.requests) * 100 : 0;
              return (
                <tr key={`${pm.provider}\u0000${pm.model}`}>
                  <td className="mono">{pm.provider}</td>
                  <td className="mono">{pm.model}</td>
                  <td className="num">{pm.requests}</td>
                  <td className={'num' + (errRate >= 20 ? ' tone-red' : '')}>{pm.errors}</td>
                  <td className="num">{fmtTokens(pm.promptTokens)}</td>
                  <td className="num">{fmtTokens(pm.completionTokens)}</td>
                  <td className="num">
                    <span className="usage-bar">
                      <span className="usage-bar-fill" style={{ width: pct(gt, totalTokens) }} />
                      <span className="usage-bar-text">{pct(gt, totalTokens)}</span>
                    </span>
                  </td>
                  <td className="num">{pm.avgLatencyMs != null ? `${pm.avgLatencyMs}ms` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** 成本估算：手动填厂商单价（元/百万 tokens），按 token 估算费用，便于与上游账单对账。 */
function CostEstimate({ providers, prices, onPriceChange }: { providers: AiUsageStats['providers']; prices: PriceMap; onPriceChange: (p: PriceMap) => void }) {
  const [open, setOpen] = useState(false);
  if (providers.length === 0) return null;

  const totalCost = providers.reduce((sum, g) => sum + costOf(g, prices, g.key), 0);
  const anyPriced = providers.some((g) => prices[g.key]);

  const setPrice = (provider: string, field: 'prompt' | 'completion', raw: string) => {
    const v = Number(raw);
    const next = { ...prices, [provider]: { ...(prices[provider] ?? { prompt: 0, completion: 0 }), [field]: Number.isFinite(v) && v >= 0 ? v : 0 } };
    onPriceChange(next);
  };

  return (
    <section className="panel">
      <div className="ai-section-head">
        <h3 className="sub" style={{ margin: 0 }}>成本估算（元 / 百万 tokens）</h3>
        <button className="mini" onClick={() => setOpen((v) => !v)}>{open ? '收起' : '展开'}</button>
      </div>
      {open ? (
        <div className="usage-table-wrap">
          <table className="usage-table">
            <thead>
              <tr>
                <th>厂商</th>
                <th>Prompt Tokens</th>
                <th>Completion Tokens</th>
                <th className="num">Prompt 单价</th>
                <th className="num">Completion 单价</th>
                <th className="num">预估费用</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((g) => {
                const price = prices[g.key];
                return (
                  <tr key={g.key}>
                    <td className="mono">{g.key}</td>
                    <td className="num">{fmtTokens(g.promptTokens)}</td>
                    <td className="num">{fmtTokens(g.completionTokens)}</td>
                    <td className="num">
                      <input
                        className="usage-price-input"
                        type="number"
                        min={0}
                        step={0.01}
                        placeholder="—"
                        value={price?.prompt ?? ''}
                        onChange={(e) => setPrice(g.key, 'prompt', e.target.value)}
                      />
                    </td>
                    <td className="num">
                      <input
                        className="usage-price-input"
                        type="number"
                        min={0}
                        step={0.01}
                        placeholder="—"
                        value={price?.completion ?? ''}
                        onChange={(e) => setPrice(g.key, 'completion', e.target.value)}
                      />
                    </td>
                    <td className="num">{price ? fmtMoney(costOf(g, prices, g.key)) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5} className="num" style={{ fontWeight: 600 }}>合计</td>
                <td className="num" style={{ fontWeight: 600 }}>{anyPriced ? fmtMoney(totalCost) : '—'}</td>
              </tr>
            </tfoot>
          </table>
          <p className="muted small" style={{ marginTop: 8 }}>
            单价为元 / 百万 tokens，按 Prompt 与 Completion 分别计价；留空视为不参与估算。价格仅供参考，实际以厂商账单为准。
          </p>
        </div>
      ) : (
        <p className="muted small" style={{ marginTop: 8 }}>
          {anyPriced ? `已估算费用 ${fmtMoney(totalCost)}（点击「展开」调整单价）` : '展开后可填写各厂商单价，按 token 用量估算费用。'}
        </p>
      )}
    </section>
  );
}

/** 按天 token 消耗趋势折线图（SVG）。 */
function TokenTrend({ days }: { days: AiUsageStats['days'] }) {
  if (days.length < 2) return null;
  const W = 640;
  const H = 160;
  const PAD = 24;
  const values = days.map((d) => d.promptTokens + d.completionTokens);
  const max = Math.max(1, ...values);
  const stepX = (W - PAD * 2) / Math.max(1, days.length - 1);
  const x = (i: number) => PAD + i * stepX;
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
  const pts = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const area = `${PAD},${H - PAD} ${pts} ${x(days.length - 1)},${H - PAD}`;

  return (
    <section className="panel">
      <h3 className="sub" style={{ margin: 0 }}>Token 消耗趋势</h3>
      <svg viewBox={`0 0 ${W} ${H}`} className="usage-trend" role="img" aria-label="按天 token 消耗趋势折线图">
        <polygon points={area} fill="var(--accent-soft)" />
        <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {values.map((v, i) => (
          <circle key={i} cx={x(i)} cy={y(v)} r={3} fill="var(--accent)">
            <title>{`${days[i].day} · ${fmtTokens(v)} tokens`}</title>
          </circle>
        ))}
        {days.map((d, i) => (
          <text key={d.day} x={x(i)} y={H - 6} textAnchor="middle" className="usage-trend-label">{d.day.slice(5)}</text>
        ))}
      </svg>
    </section>
  );
}

/** 最近调用明细流水：逐条追溯时间 / 厂商 / 模型 / 用途 / token / 耗时 / 状态。 */
function LatestTable({ latest }: { latest: AiUsageStats['latest'] }) {
  if (latest.length === 0) return null;
  return (
    <section className="panel">
      <h3 className="sub" style={{ margin: 0 }}>最近调用明细</h3>
      <div className="usage-table-wrap">
        <table className="usage-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>厂商</th>
              <th>模型</th>
              <th>用途</th>
              <th className="num">Prompt</th>
              <th className="num">Completion</th>
              <th className="num">耗时</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {latest.map((r, i) => (
              <tr key={i}>
                <td className="small muted">{r.at ? fmtTime(r.at) : '—'}</td>
                <td className="mono">{r.provider || '—'}</td>
                <td className="mono">{r.model || '—'}</td>
                <td className="small">{r.action ? actionLabel(r.action) : '—'}</td>
                <td className="num">{r.promptTokens ?? '—'}</td>
                <td className="num">{r.completionTokens ?? '—'}</td>
                <td className="num">{r.latencyMs != null ? `${r.latencyMs}ms` : '—'}</td>
                <td>
                  {r.status === 'error' ? (
                    <span className="status-badge tone-red" title={r.errorCode ?? ''}>失败{r.errorCode ? ` · ${r.errorCode}` : ''}</span>
                  ) : (
                    <span className="status-badge tone-green">成功</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {latest.length >= 50 && <p className="muted small" style={{ marginTop: 8 }}>仅展示最近 50 条，完整明细可通过「导出 CSV」获取。</p>}
    </section>
  );
}

/** 导出当前范围的对账汇总为 CSV（厂商/模型/用途三张子表），便于与上游账单核对。 */
function exportCsv(data: AiUsageStats) {
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines: string[] = [];
  lines.push('【按厂商对账】');
  lines.push('厂商,请求,失败,Prompt Tokens,Completion Tokens,Tokens 合计,平均耗时ms,最近调用');
  for (const g of data.providers) {
    lines.push([g.key, g.requests, g.errors, g.promptTokens, g.completionTokens, g.promptTokens + g.completionTokens, g.avgLatencyMs ?? '', g.lastAt ?? ''].map(esc).join(','));
  }
  lines.push('');
  lines.push('【按模型对账】');
  lines.push('模型,厂商,请求,失败,Prompt Tokens,Completion Tokens,Tokens 合计,平均耗时ms,最近调用');
  for (const g of data.models) {
    lines.push([g.key, g.provider ?? '', g.requests, g.errors, g.promptTokens, g.completionTokens, g.promptTokens + g.completionTokens, g.avgLatencyMs ?? '', g.lastAt ?? ''].map(esc).join(','));
  }
  lines.push('');
  lines.push('【按用途对账】');
  lines.push('用途,请求,失败,Prompt Tokens,Completion Tokens,Tokens 合计,平均耗时ms');
  for (const a of data.actions) {
    lines.push([actionLabel(a.key), a.requests, a.errors, a.promptTokens, a.completionTokens, a.promptTokens + a.completionTokens, a.avgLatencyMs ?? ''].map(esc).join(','));
  }
  lines.push('');
  lines.push('【厂商×模型透视】');
  lines.push('厂商,模型,请求,失败,Prompt Tokens,Completion Tokens,Tokens 合计,平均耗时ms');
  for (const pm of data.providerModels) {
    lines.push([pm.provider, pm.model, pm.requests, pm.errors, pm.promptTokens, pm.completionTokens, pm.promptTokens + pm.completionTokens, pm.avgLatencyMs ?? ''].map(esc).join(','));
  }
  lines.push('');
  lines.push('【最近调用明细】');
  lines.push('时间,厂商,模型,用途,状态,错误码,耗时ms,Prompt Tokens,Completion Tokens');
  for (const r of data.latest) {
    lines.push([r.at ?? '', r.provider ?? '', r.model ?? '', r.action ?? '', r.status ?? '', r.errorCode ?? '', r.latencyMs ?? '', r.promptTokens ?? '', r.completionTokens ?? ''].map(esc).join(','));
  }

  const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ai-usage-${data.range}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function UsagePanel() {
  const [range, setRange] = useState<string>('30d');
  const [prices, setPrices] = useState<PriceMap>(loadPrices);

  const { data, isLoading } = useQuery({
    queryKey: ['ai-usage', range],
    queryFn: () => getAiUsage(range),
  });

  const totalTokens = useMemo(() => data?.totals.totalTokens ?? 0, [data]);

  const handlePriceChange = (p: PriceMap) => {
    setPrices(p);
    savePrices(p);
  };

  const totalCost = useMemo(() => {
    if (!data) return 0;
    return data.providers.reduce((sum, g) => sum + costOf(g, prices, g.key), 0);
  }, [data, prices]);
  const anyPriced = data?.providers.some((g) => prices[g.key]) ?? false;

  return (
    <section className="panel">
      <h2>用量统计</h2>
      <p className="muted small">本账号的 AI 调用对账：按厂商与模型拆分 token 用量，支持成本估算与逐条明细追溯，便于与上游账单核对。</p>

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
        <span className="spacer" style={{ flex: 1 }} />
        <button className="mini" onClick={() => data && exportCsv(data)} disabled={!data || data.totals.requests === 0} title="导出当前范围的对账汇总 CSV（含透视与明细）">
          导出 CSV
        </button>
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
            <div className="usage-metric usage-metric-cost">
              <span className="usage-metric-label">预估费用</span>
              <span className="usage-metric-value">{anyPriced ? fmtMoney(totalCost) : '—'}</span>
              <span className="muted small">{anyPriced ? '按厂商单价估算，仅供参考' : '需在下方「成本估算」填厂商单价'}</span>
            </div>
          </div>

          {data.totals.requests === 0 && (
            <div className="hint">
              该时间范围内还没有 AI 调用记录。配置并保存模型后，JD 解析、投递话术、面试复盘等会在此累计用量。
            </div>
          )}

          <GroupTable title="按厂商对账" groups={data.providers} totalTokens={totalTokens} />
          <GroupTable title="按模型对账" groups={data.models} totalTokens={totalTokens} />
          <ActionTable actions={data.actions} totalTokens={totalTokens} />
          <ProviderModelTable providerModels={data.providerModels} totalTokens={totalTokens} />
          <ErrorCodeTable errorCodes={data.errorCodes} />
          <CostEstimate providers={data.providers} prices={prices} onPriceChange={handlePriceChange} />
          <TokenTrend days={data.days} />
          <LatestTable latest={data.latest} />
          <DailyTrend days={data.days} />
        </>
      )}
    </section>
  );
}
