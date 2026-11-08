import { useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { api, del, fmtTime, post, put, type CompanyItem, type JdItem } from '../api';
import {
  buildBrief,
  dimensionCoverage,
  expandIndustryQuery,
  INDUSTRY_TAXONOMY,
  RESEARCH_DIMS,
  type CompanyIntel,
} from '../company-intel';

/** 公司详情页：独立页面，宽度更宽。 */
export default function CompanyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [newJd, setNewJd] = useState('');
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
  const company = companies.find((c) => c.id === id);
  const intel: CompanyIntel | null = useMemo(() => (company ? normalizeCompany(company.payload) : null), [company]);

  const { data: jds = [] } = useQuery({
    queryKey: ['jds', id],
    queryFn: () => api<JdItem[]>(`/companies/${id}/jds`),
    enabled: !!id,
  });

  const invalidateCompanies = () => qc.invalidateQueries({ queryKey: ['companies'] });
  const invalidateJds = () => qc.invalidateQueries({ queryKey: ['jds', id] });
  const onFail = (e: unknown) => setError((e as Error).message);

  const deleteM = useMutation({
    mutationFn: (cid: string) => del(`/companies/${cid}`),
    onSuccess: () => navigate('/companies'),
    onError: onFail,
  });

  const addJdM = useMutation({
    mutationFn: (title: string) => post<JdItem>(`/companies/${id}/jds`, { payload: { title } }),
    onSuccess: () => {
      setNewJd('');
      invalidateJds();
    },
    onError: onFail,
  });

  const deleteJdM = useMutation({
    mutationFn: (jdId: string) => del(`/companies/${id}/jds/${jdId}`),
    onSuccess: invalidateJds,
    onError: onFail,
  });

  const metaM = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      put<CompanyItem>(`/companies/${id}`, { payload: { ...(company?.payload || {}), ...patch } }),
    onSuccess: () => {
      setEditSummary('');
      setEditTags('');
      setEditCategory('');
      invalidateCompanies();
    },
    onError: onFail,
  });

  function addJd(e: FormEvent) {
    e.preventDefault();
    if (newJd.trim()) addJdM.mutate(newJd.trim());
  }

  const catOf = (cid?: string) => INDUSTRY_TAXONOMY[cid || 'other-none'] || INDUSTRY_TAXONOMY['other-none'];

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

  if (isLoading) return <p className="muted">加载中…</p>;
  if (!company || !intel) return <p className="muted">未找到公司。</p>;

  const cov = dimensionCoverage(intel);

  return (
    <div className="detail-page">
      {/* 顶部导航 */}
      <div className="detail-nav">
        <Link to="/companies" className="detail-back">
          ← 返回公司档案
        </Link>
        <div className="detail-nav-actions">
          <button className="mini" onClick={() => setBriefOpen((v) => !v)}>
            {briefOpen ? '收起简报' : '生成简报'}
          </button>
          <button
            className="mini danger"
            onClick={() => {
              if (window.confirm(`确认删除「${company.name}」及其岗位 JD？`)) deleteM.mutate(company.id);
            }}
          >
            删除公司
          </button>
        </div>
      </div>

      {/* 头部信息 */}
      <div className="detail-header">
        <h1 className="detail-title">{company.name}</h1>
        <div className="detail-meta-row">
          <span className="meta-chip">{catOf(intel.industryCategory).label}</span>
          {intel.industry && intel.industry !== catOf(intel.industryCategory).label && (
            <span className="meta-chip">{intel.industry}</span>
          )}
          {intel.scale && <span className="meta-chip">{intel.scale}</span>}
          {intel.location && <span className="meta-chip">{intel.location}</span>}
          {intel.website && (
            <a className="meta-chip" href={String(intel.website)} target="_blank" rel="noopener noreferrer">
              官网 ↗
            </a>
          )}
        </div>
        {intel.summary && <p className="co-summary">{intel.summary}</p>}
        <div className="detail-meta-grid">
          <div>
            <span className="muted small">完整度</span>
            <div>{cov.covered.length}/6 维</div>
          </div>
          <div>
            <span className="muted small">调研条目</span>
            <div>{intel.research?.length || 0} 条</div>
          </div>
          <div>
            <span className="muted small">岗位 JD</span>
            <div>{jds.length} 个</div>
          </div>
          <div>
            <span className="muted small">更新时间</span>
            <div>{fmtTime(company.updatedAt)}</div>
          </div>
        </div>
      </div>

      {error && <div className="alert">{error}</div>}

      {/* 六维完整度 */}
      <section className="detail-section">
        <h3 className="sub">六维调研完整度</h3>
        <div className="co-coverage big">
          {RESEARCH_DIMS.map((d) => {
            const on = cov.covered.includes(d);
            return (
              <span key={d} className={on ? 'on' : 'off'}>
                {d}
              </span>
            );
          })}
        </div>
      </section>

      {/* 编辑元信息 */}
      <details className="detail-section">
        <summary className="sub">编辑元信息（摘要 / 标签 / 行业类目）</summary>
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
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button
            className="mini primary"
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

      {/* 简报生成 */}
      {briefOpen && (
        <section className="detail-section">
          <h3 className="sub">公司简报</h3>
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
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button className="mini primary" onClick={copyBrief}>复制 Markdown</button>
            <button className="mini" onClick={downloadBrief}>下载 .md</button>
            {copied && <span className="muted small">{copied}</span>}
          </div>
        </section>
      )}

      {/* 调研条目，按维度分组 */}
      <section className="detail-section">
        <h3 className="sub">调研条目</h3>
        {RESEARCH_DIMS.map((dim) => {
          const items = (intel.research || []).filter((r) => r.dim === dim);
          if (!items.length) return null;
          return (
            <details key={dim} className="co-dim" open>
              <summary>
                {dim} <span className="muted small">（{items.length}）</span>
              </summary>
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
            </details>
          );
        })}
        {!(intel.research || []).length && <p className="muted small">暂无调研条目。</p>}
      </section>

      {/* 岗位 JD */}
      <section className="detail-section">
        <h3 className="sub">岗位 JD（{jds.length}）</h3>
        <form className="row compact" onSubmit={addJd}>
          <input value={newJd} onChange={(e) => setNewJd(e.target.value)} placeholder="新增岗位名称" />
          <button className="mini" type="submit" disabled={addJdM.isPending || !newJd.trim()}>
            添加
          </button>
        </form>
        {jds.length ? (
          <ul className="mini-list" style={{ marginTop: 12 }}>
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
      </section>
    </div>
  );
}

// 从原 Companies.tsx 复制的 normalizeCompany
import { normalizeCompany } from '../company-intel';
