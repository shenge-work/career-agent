import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, fmtTime, post, type CompanyItem } from '../api';
import {
  dimensionCoverage,
  expandIndustryQuery,
  INDUSTRY_TAXONOMY,
  matchCompany,
  normalizeCompany,
  RESEARCH_DIMS,
} from '../company-intel';

/**
 * 公司档案列表页：纯列表，点击进入独立详情页。
 */
export default function Companies() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [industryFilter, setIndustryFilter] = useState('');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 12;

  const { data: companies = [], isLoading } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<CompanyItem[]>('/companies'),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['companies'] });
  const onFail = (e: unknown) => setError((e as Error).message);

  const createM = useMutation({
    mutationFn: (name: string) => post<CompanyItem>('/companies', { name }),
    onSuccess: (row) => {
      setNewName('');
      navigate(`/companies/${row.id}`);
    },
    onError: onFail,
  });

  function create(e: FormEvent) {
    e.preventDefault();
    if (newName.trim()) createM.mutate(newName.trim());
  }

  const normalizedList = useMemo(() => companies.map((c) => normalizeCompany(c.payload)), [companies]);
  const q = query.trim();
  const expanded = useMemo(() => expandIndustryQuery(q), [q]);

  const filtered = useMemo(() => {
    return companies
      .map((c) => ({ row: c, intel: normalizeCompany(c.payload), match: matchCompany(c.payload, q) }))
      .filter(({ intel, match }) => {
        if (!match.hit) return false;
        if (industryFilter && intel.industryCategory !== industryFilter) return false;
        return true;
      });
  }, [companies, q, industryFilter]);

  // 分页
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageData = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const stats = useMemo(() => {
    const research = normalizedList.reduce((n, c) => n + (c.research?.length || 0), 0);
    const avg = normalizedList.length
      ? normalizedList.reduce((n, c) => n + dimensionCoverage(c).ratio, 0) / normalizedList.length
      : 0;
    return { total: companies.length, research, avg: Math.round(avg * 100) };
  }, [normalizedList, companies.length]);

  const industryGroups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of normalizedList) {
      counts.set(c.industryCategory || 'other-none', (counts.get(c.industryCategory || 'other-none') || 0) + 1);
    }
    const byGroup = new Map<string, Array<{ id: string; label: string; n: number }>>();
    for (const [id, n] of counts) {
      const cat = INDUSTRY_TAXONOMY[id] || INDUSTRY_TAXONOMY['other-none'];
      const arr = byGroup.get(cat.group) || [];
      arr.push({ id, label: cat.label, n });
      byGroup.set(cat.group, arr);
    }
    return [...byGroup.entries()];
  }, [normalizedList]);

  const catOf = (cid?: string) => INDUSTRY_TAXONOMY[cid || 'other-none'] || INDUSTRY_TAXONOMY['other-none'];

  return (
    <>
      <div className="page-head">
        <h1>公司档案</h1>
        <p className="muted small">
          求职情报底座：只沉淀公司本身信息与岗位 JD，不展示任何投递状态。点击进入详情页查看完整调研。
        </p>
      </div>
      {error && <div className="alert">{error}</div>}

      <div className="btn-row co-stats">
        <span className="chip">公司档案 {stats.total}</span>
        <span className="chip">调研条目 {stats.research}</span>
        <span className="chip">平均完整度 {stats.avg}%</span>
      </div>

      <div className="co-toolbar">
        <input
          className="co-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索公司 / 行业词（如 大模型、芯片、银行）/ 调研正文 / JD 技能"
        />
        <select value={industryFilter} onChange={(e) => setIndustryFilter(e.target.value)}>
          <option value="">全行业</option>
          {industryGroups.map(([group, cats]) => (
            <optgroup key={group} label={group}>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}（{c.n}）
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {q && expanded.categories.length > 0 && (
          <span className="muted small">
            按行业匹配：{expanded.categories.map((id) => catOf(id).label).join(' / ')}
          </span>
        )}
      </div>

      {/* 新建公司 */}
      <div className="list-create-bar">
        <form className="form-grid" onSubmit={create}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="新建公司名称"
          />
          <button type="submit" disabled={createM.isPending || !newName.trim()}>
            新建公司
          </button>
        </form>
      </div>

      {/* 公司卡片列表 */}
      {isLoading ? (
        <p className="muted">加载中…</p>
      ) : filtered.length === 0 ? (
        <div className="empty">{companies.length ? '没有命中筛选的公司。' : '还没有公司档案。'}</div>
      ) : (
        <>
          <div className="co-grid">
            {pageData.map(({ row: c, intel: ic, match }) => {
              const cov = dimensionCoverage(ic);
              return (
                <Link
                  key={c.id}
                  to={`/companies/${c.id}`}
                  className="co-card"
                >
                  <div className="co-card-head">
                    <strong>{c.name}</strong>
                    {match.viaIndustry && <span className="tag">按行业：{match.viaIndustry}</span>}
                  </div>
                  <div className="muted small">
                    {catOf(ic.industryCategory).label} · {ic.location || '—'}
                  </div>
                  <div className="co-coverage" title={`六维完整度 ${Math.round(cov.ratio * 100)}%`}>
                    {RESEARCH_DIMS.map((d) => (
                      <span key={d} className={cov.covered.includes(d) ? 'on' : 'off'} />
                    ))}
                    <em className="muted small">
                      {cov.covered.length}/6 · 调研 {ic.research?.length || 0} · JD {ic.jds?.length || 0}
                    </em>
                  </div>
                  <div className="muted small">更新 {fmtTime(c.updatedAt)}</div>
                </Link>
              );
            })}
          </div>

          {/* 分页 */}
          {totalPages > 1 && (
            <div className="pagination">
              <button className="page-btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                ← 上一页
              </button>
              <span className="page-info">第 {page} / {totalPages} 页</span>
              <button className="page-btn" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                下一页 →
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
