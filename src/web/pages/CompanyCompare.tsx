import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type CompanyItem, type ReferralItem } from '../api';
import {
  buildCompareTable,
  companyCompareRow,
  COMPARE_DIMS,
  type CompareDimKey,
} from '../company-intel';

const MAX = 5;
const MIN = 2;

/**
 * 多公司横向对比：勾选 2~5 家公司，维度为行、公司为列，统一口径横向摆开。
 * 只对比「已录入」的决策字段，黑白灰主题，缺失单元格显示为空态。
 */
export default function CompanyCompare() {
  const [selected, setSelected] = useState<string[]>([]);

  const { data: companies = [], isLoading } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<CompanyItem[]>('/companies'),
  });
  const { data: referrals = [] } = useQuery({
    queryKey: ['referrals'],
    queryFn: () => api<ReferralItem[]>('/referrals'),
  });

  const referralCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of referrals) if (r.companyId) m.set(r.companyId, (m.get(r.companyId) || 0) + 1);
    return m;
  }, [referrals]);

  function toggle(id: string) {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX) return prev;
      return [...prev, id];
    });
  }

  const picked = useMemo(
    () => companies.filter((c) => selected.includes(c.id)),
    [companies, selected]
  );

  const table = useMemo(() => {
    if (picked.length < MIN) return null;
    const rows = picked.map((c) => ({
      name: c.name,
      row: companyCompareRow(c.payload, {
        referralCount: referralCount.get(c.id) || 0,
      }),
    }));
    return { rows, table: buildCompareTable(rows) };
  }, [picked, referralCount]);

  // 突出显示维度：有差异的「决策」行给予视觉强调（纯文字，不用颜色）
  const diffDims = useMemo(() => {
    if (!table) return new Set<CompareDimKey>();
    const set = new Set<CompareDimKey>();
    for (const row of table.table) {
      const vals = new Set(row.cells.map((c) => c.text));
      if (vals.size > 1) set.add(row.dim);
    }
    return set;
  }, [table]);

  if (isLoading) return <p className="muted">加载中…</p>;

  return (
    <>
      <div className="page-head">
        <div className="section-head">
          <div>
            <h1>公司横向对比</h1>
            <p className="muted small">
              勾选 2~5 家公司，把行业、规模、完整度、推荐度、薪资、风险这些决策字段并排看。
            </p>
          </div>
          <Link to="/companies" className="detail-back">← 返回公司档案</Link>
        </div>
      </div>

      {companies.length < MIN ? (
        <div className="empty">至少需要 {MIN} 家公司才能对比，先去公司档案录入。</div>
      ) : (
        <>
          {/* 选择区 */}
          <section className="detail-section">
            <h3 className="sub">
              选择公司（{selected.length}/{MAX}）
            </h3>
            <div className="co-grid">
              {companies.map((c) => {
                const on = selected.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={'co-card compare-pick' + (on ? ' picked' : '')}
                    onClick={() => toggle(c.id)}
                    aria-pressed={on}
                  >
                    <div className="co-card-head">
                      <strong>{c.name}</strong>
                      <span className="tag">{on ? '已选' : '点击选择'}</span>
                    </div>
                    <div className="muted small">{String(c.payload?.industry || '—')}</div>
                  </button>
                );
              })}
            </div>
            {selected.length > MAX && <p className="muted small">最多对比 {MAX} 家。</p>}
          </section>

          {/* 对比表 */}
          {table ? (
            <section className="detail-section">
              <h3 className="sub">对比结果</h3>
              <div className="compare-table-wrap">
                <table className="compare-table">
                  <thead>
                    <tr>
                      <th className="compare-dim-col">维度</th>
                      {table.rows.map((r) => (
                        <th key={r.name}>
                          <Link to={`/companies/${companies.find((c) => c.name === r.name)?.id}`} className="compare-company">
                            {r.name}
                          </Link>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.table.map((row) => (
                      <tr key={row.dim} className={diffDims.has(row.dim) ? 'diff' : ''}>
                        <th className="compare-dim-col">
                          {row.label}
                          {diffDims.has(row.dim) && <span className="tag diff-mark">有差异</span>}
                        </th>
                        {row.cells.map((cell, i) => (
                          <td key={i} className={cell.empty ? 'empty' : ''}>
                            {cell.empty ? '—' : cell.text}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : (
            <div className="empty">
              {selected.length < MIN ? `已选 ${selected.length} 家，再选 ${MIN - selected.length} 家即可开始对比。` : ''}
            </div>
          )}
        </>
      )}
    </>
  );
}
