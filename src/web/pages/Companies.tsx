import { useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, del, fmtTime, post, put, type CompanyItem, type JdItem } from '../api';
import {
  buildBrief,
  dimensionCoverage,
  expandIndustryQuery,
  INDUSTRY_TAXONOMY,
  matchCompany,
  normalizeCompany,
  RESEARCH_DIMS,
  type CompanyIntel,
} from '../company-intel';

/**
 * 公司档案（D7 第一批）：行业分类检索 + 卡片化列表 + 详情分区 + 完整度 + Markdown 简报。
 * 铁律：公司侧不出现任何投递状态（D7 §二）；配色严格黑 / 白 / 灰。
 */
export default function Companies() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [industryFilter, setIndustryFilter] = useState('');
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefCfg, setBriefCfg] = useState<{ sections: string[]; includeJds: boolean; includeRumors: boolean; includeVerdict: boolean }>({
    sections: [...RESEARCH_DIMS],
    includeJds: true,
    includeRumors: false,
    includeVerdict: false,
  });
  const [copied, setCopied] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editCategory, setEditCategory] = useState('');

  const { data: companies = [], isLoading } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<CompanyItem[]>('/companies'),
  });
  const company = companies.find((c) => c.id === selectedId) || companies[0] || null;
  const intel: CompanyIntel | null = useMemo(() => (company ? normalizeCompany(company.payload) : null), [company]);

  const { data: jds = [] } = useQuery({
    queryKey: ['jds', company?.id],
    queryFn: () => api<JdItem[]>(`/companies/${company?.id}/jds`),
    enabled: !!company?.id,
  });

  const invalidateCompanies = () => qc.invalidateQueries({ queryKey: ['companies'] });
  const invalidateJds = () => qc.invalidateQueries({ queryKey: ['jds', company?.id] });
  const onFail = (e: unknown) => setError((e as Error).message);

  const createM = useMutation({
    mutationFn: (name: string) => post<CompanyItem>('/companies', { name }),
    onSuccess: (row) => {
      setNewName('');
      setSelectedId(row.id);
      invalidateCompanies();
    },
    onError: onFail,
  });

  const deleteM = useMutation({
    mutationFn: (id: string) => del(`/companies/${id}`),
    onSuccess: () => {
      setSelectedId(null);
      invalidateCompanies();
    },
    onError: onFail,
  });

  const addJdM = useMutation({
    mutationFn: (title: string) => post<JdItem>(`/companies/${company?.id}/jds`, { payload: { title } }),
    onSuccess: () => {
      setNewJd('');
      invalidateJds();
    },
    onError: onFail,
  });

  const deleteJdM = useMutation({
    mutationFn: (jdId: string) => del(`/companies/${company?.id}/jds/${jdId}`),
    onSuccess: invalidateJds,
    onError: onFail,
  });

  /** 编辑档案元信息（摘要 / 标签 / 行业类目）——写入 payload，其余字段原样保留。 */
  const metaM = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      put<CompanyItem>(`/companies/${company?.id}`, { payload: { ...(company?.payload || {}), ...patch } }),
    onSuccess: () => {
      setEditSummary('');
      setEditTags('');
      setEditCategory('');
      invalidateCompanies();
    },
    onError: onFail,
  });

  const [newJd, setNewJd] = useState('');

  function create(e: FormEvent) {
    e.preventDefault();
    if (newName.trim()) createM.mutate(newName.trim());
  }
  function addJd(e: FormEvent) {
    e.preventDefault();
    if (newJd.trim() && company) addJdM.mutate(newJd.trim());
  }

  /* ------------------------------------------------------------ 列表派生 */

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

  const stats = useMemo(() => {
    const research = normalizedList.reduce((n, c) => n + (c.research?.length || 0), 0);
    const jdTotal = normalizedList.reduce((n, c) => n + (c.jds?.length || 0), 0) + jds.length; // jds 多在子资源
    const avg = normalizedList.length
      ? normalizedList.reduce((n, c) => n + dimensionCoverage(c).ratio, 0) / normalizedList.length
      : 0;
    return { total: companies.length, research, jdTotal, avg: Math.round(avg * 100) };
  }, [normalizedList, companies.length, jds.length]);

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

  const briefMd = useMemo(
    () => (company && intel ? buildBrief(intel, jds.map((j) => j.payload || {}), briefCfg) : ''),
    [company, intel, jds, briefCfg]
  );

  async function copyBrief() {
    try {
      await navigator.clipboard.writeText(briefMd);
      setCopied('已复制到剪贴板');
      setTimeout(() => setCopied(''), 2500);
    } catch {
      setCopied('复制失败，请手动选择文本');
    }
  }

  function downloadBrief() {
    const blob = new Blob([briefMd], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(company?.name || '公司').replace(/[\\/:*?"<>|]/g, '_')}-公司简报.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  const catOf = (id?: string) => INDUSTRY_TAXONOMY[id || 'other-none'] || INDUSTRY_TAXONOMY['other-none'];

  return (
    <>
      <div className="page-head">
        <h1>公司档案</h1>
        <p className="muted small">
          求职情报底座：只沉淀公司本身信息与岗位 JD，不展示任何投递状态（状态在投递管理维护）。
        </p>
      </div>
      {error && <div className="alert">{error}</div>}

      <div className="btn-row co-stats">
        <span className="chip">公司档案 {stats.total}</span>
        <span className="chip">调研条目 {stats.research}</span>
        <span className="chip">岗位 JD {stats.jdTotal}</span>
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

      <div className="split">
        <section className="panel">
          <form className="row" onSubmit={create}>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="新建公司名称" />
            <button type="submit" disabled={createM.isPending || !newName.trim()}>
              新建
            </button>
          </form>

          {isLoading ? (
            <p className="muted">加载中…</p>
          ) : filtered.length === 0 ? (
            <div className="empty">{companies.length ? '没有命中筛选的公司。' : '还没有公司档案。'}</div>
          ) : (
            <ul className="co-grid">
              {filtered.map(({ row: c, intel: ic, match }) => {
                const cov = dimensionCoverage(ic);
                return (
                  <li
                    key={c.id}
                    className={'co-card' + (company?.id === c.id ? ' selected' : '')}
                    onClick={() => setSelectedId(c.id)}
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
                    <div className="btn-row" onClick={(e) => e.stopPropagation()}>
                      <button className="mini" onClick={() => setSelectedId(c.id)}>详情</button>
                      <button
                        className="mini danger"
                        onClick={() => {
                          if (window.confirm(`确认删除「${c.name}」及其岗位 JD？`)) deleteM.mutate(c.id);
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <aside className="panel detail">
          {!company || !intel ? (
            <div className="empty">选择左侧公司查看详情</div>
          ) : (
            <>
              <div className="co-head">
                <h2>{company.name}</h2>
                <div className="btn-row">
                  <button className="mini" onClick={() => setBriefOpen((v) => !v)}>
                    {briefOpen ? '收起简报' : '生成简报'}
                  </button>
                </div>
              </div>
              <div className="btn-row co-meta">
                <span className="chip">{catOf(intel.industryCategory).label}</span>
                {intel.industry && intel.industry !== catOf(intel.industryCategory).label && (
                  <span className="chip">{intel.industry}</span>
                )}
                {intel.scale && <span className="chip">{intel.scale}</span>}
                {intel.location && <span className="chip">{intel.location}</span>}
                {intel.website && (
                  <a className="chip" href={String(intel.website)} target="_blank" rel="noopener noreferrer">
                    官网 ↗
                  </a>
                )}
              </div>
              {intel.summary && <p className="co-summary">{intel.summary}</p>}

              <div className="co-coverage big">
                {RESEARCH_DIMS.map((d) => {
                  const on = dimensionCoverage(intel).covered.includes(d);
                  return (
                    <span key={d} className={on ? 'on' : 'off'}>
                      {d}
                    </span>
                  );
                })}
              </div>

              <details className="co-edit">
                <summary>编辑元信息（摘要 / 标签 / 行业类目）</summary>
                <div className="form-grid">
                  <label>
                    一句话摘要
                    <input
                      value={editSummary}
                      onChange={(e) => setEditSummary(e.target.value)}
                      placeholder={intel.summary || '如：AI Agent 硬件出海，现金流健康'}
                    />
                  </label>
                  <label>
                    标签（逗号分隔）
                    <input
                      value={editTags}
                      onChange={(e) => setEditTags(e.target.value)}
                      placeholder={intel.tags?.join(', ') || 'B轮, 16薪, 重点跟进'}
                    />
                  </label>
                  <label>
                    标准行业类目
                    <select
                      value={editCategory || intel.industryCategory || ''}
                      onChange={(e: ChangeEvent<HTMLSelectElement>) => setEditCategory(e.target.value)}
                    >
                      {Object.values(INDUSTRY_TAXONOMY).map((cat) => (
                        <option key={cat.id} value={cat.id}>
                          {cat.group} · {cat.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="btn-row">
                  <button
                    className="mini"
                    disabled={metaM.isPending}
                    onClick={() =>
                      metaM.mutate({
                        summary: editSummary.trim() || intel.summary || '',
                        tags: editTags.trim() ? editTags.split(/[,，]/).map((t) => t.trim()).filter(Boolean) : intel.tags || [],
                        industryCategory: editCategory || intel.industryCategory || 'other-none',
                      })
                    }
                  >
                    {metaM.isPending ? '保存中…' : '保存元信息'}
                  </button>
                </div>
              </details>

              {briefOpen && (
                <div className="co-brief">
                  <p className="muted small">
                    勾选要包含的内容；风闻与「我的判断」默认排除（脱敏铁律），勾选即内部使用。
                  </p>
                  <div className="btn-row co-brief-cfg">
                    {RESEARCH_DIMS.map((d) => (
                      <label key={d} className="check-line">
                        <input
                          type="checkbox"
                          checked={briefCfg.sections.includes(d)}
                          onChange={(e) =>
                            setBriefCfg((c) => ({
                              ...c,
                              sections: e.target.checked ? [...c.sections, d] : c.sections.filter((s) => s !== d),
                            }))
                          }
                        />
                        {d}
                      </label>
                    ))}
                    <label className="check-line">
                      <input
                        type="checkbox"
                        checked={briefCfg.includeJds}
                        onChange={(e) => setBriefCfg((c) => ({ ...c, includeJds: e.target.checked }))}
                      />
                      岗位 JD
                    </label>
                    <label className="check-line">
                      <input
                        type="checkbox"
                        checked={briefCfg.includeRumors}
                        onChange={(e) => setBriefCfg((c) => ({ ...c, includeRumors: e.target.checked }))}
                      />
                      风闻（内部）
                    </label>
                    <label className="check-line">
                      <input
                        type="checkbox"
                        checked={briefCfg.includeVerdict}
                        onChange={(e) => setBriefCfg((c) => ({ ...c, includeVerdict: e.target.checked }))}
                      />
                      我的判断（内部）
                    </label>
                  </div>
                  <textarea className="mono brief-out" rows={12} value={briefMd} readOnly spellCheck={false} />
                  <div className="btn-row">
                    <button className="mini" onClick={copyBrief}>复制 Markdown</button>
                    <button className="mini" onClick={downloadBrief}>下载 .md</button>
                    {copied && <span className="muted small">{copied}</span>}
                  </div>
                </div>
              )}

              {RESEARCH_DIMS.map((dim) => {
                const items = (intel.research || []).filter((r) => r.dim === dim);
                if (!items.length) return null;
                return (
                  <section key={dim} className="co-dim">
                    <h3 className="sub">
                      {dim} <span className="muted small">（{items.length}）</span>
                    </h3>
                    <ul className="mini-list">
                      {items.map((r, i) => (
                        <li key={r.id || i}>
                          <span className="muted small">
                            {r.platform || '—'} · {r.date || '—'}
                            {r.url && (
                              <a href={String(r.url)} target="_blank" rel="noopener noreferrer">
                                {' '}来源 ↗
                              </a>
                            )}
                          </span>
                          <div className="muted small clamp-4">{r.content || ''}</div>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
              {!(intel.research || []).length && <p className="muted small">暂无调研条目。</p>}

              <h3 className="sub">
                岗位 JD <span className="muted small">（{jds.length}）</span>
              </h3>
              <form className="row compact" onSubmit={addJd}>
                <input value={newJd} onChange={(e) => setNewJd(e.target.value)} placeholder="新增岗位名称" />
                <button className="mini" type="submit" disabled={addJdM.isPending || !newJd.trim()}>
                  添加
                </button>
              </form>
              {jds.length ? (
                <ul className="mini-list">
                  {jds.map((j) => (
                    <li key={j.id}>
                      <strong>{j.payload?.title || '未命名岗位'}</strong>
                      <span className="muted small">
                        {' '}· {j.payload?.salary || '—'} · {j.payload?.city || '—'}
                      </span>
                      <div className="btn-row">
                        <button className="mini danger" onClick={() => deleteJdM.mutate(j.id)}>删除</button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">暂无岗位 JD。</p>
              )}
            </>
          )}
        </aside>
      </div>
    </>
  );
}
