import { useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { api, del, fmtTime, post, put, type CompanyItem, type JdItem, type ReferralItem } from '../api';
import ConfirmModal from '../components/ConfirmModal';
import {
  buildBrief,
  dimensionCoverage,
  expandIndustryQuery,
  FUNDING_CURRENCIES,
  FUNDING_ROUNDS,
  INDUSTRY_TAXONOMY,
  INTERVIEW_FORMS,
  INTERVIEW_ROUNDS,
  normalizeFundingRounds,
  normalizeSalaries,
  QUESTION_STATUS,
  RESEARCH_DIMS,
  SALARY_CURRENCIES,
  SALARY_PERIODS,
  VERDICT_LEVELS,
  type CompanyIntel,
} from '../company-intel';
import {
  careersUrlOf,
  normalizeReferral,
  referralEntryUrlOf,
  referralTitle,
  statusMeta,
} from '../referrals';

/** 公司详情页：独立页面，宽度更宽。 */
export default function CompanyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [newJd, setNewJd] = useState('');
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefCfg, setBriefCfg] = useState<{ sections: string[]; includeJds: boolean; includeRumors: boolean; includeVerdict: boolean; includeInterviews: boolean; includeQuestions: boolean }>({
    sections: [...RESEARCH_DIMS],
    includeJds: true,
    includeRumors: false,
    includeVerdict: false,
    includeInterviews: false,
    includeQuestions: false,
  });
  const [copied, setCopied] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editCategory, setEditCategory] = useState('');
  // 招聘官网 / 内推入口：直接写 companies.payload，用独立输入框避免被「编辑元信息」覆盖。
  const [careersDraft, setCareersDraft] = useState<string | null>(null);
  const [referralDraft, setReferralDraft] = useState<string | null>(null);
  const [quickRef, setQuickRef] = useState({ referrer: '', position: '', channel: '', status: 'pending' });
  const [deleteCompanyOpen, setDeleteCompanyOpen] = useState(false);
  const [deleteReferralId, setDeleteReferralId] = useState<string | null>(null);

  // 决策闭环三件套：我的判断 / 面试面经 / 待核实问题
  const [verdictDraft, setVerdictDraft] = useState<{
    recommendation: string; expectedSalary: string; resumeFor: string; concerns: string; redline: string;
  }>({ recommendation: '', expectedSalary: '', resumeFor: '', concerns: '', redline: '' });
  const [interviewDraft, setInterviewDraft] = useState<{
    round: string; form: string; date: string; duration: string; questions: string; style: string; feedback: string; offerDeadline: string;
  }>({ round: '', form: '', date: '', duration: '', questions: '', style: '', feedback: '', offerDeadline: '' });
  const [questionDraft, setQuestionDraft] = useState({ text: '' });

  // 薪资样本 / 融资轮次录入
  const [salaryDraft, setSalaryDraft] = useState<{
    role: string; level: string; low: string; high: string; avg: string; period: string; months: string; sampleSize: string; source: string; date: string; note: string;
  }>({ role: '', level: '', low: '', high: '', avg: '', period: '月薪', months: '', sampleSize: '', source: '', date: '', note: '' });
  const [fundingDraft, setFundingDraft] = useState<{
    round: string; date: string; amount: string; amountUnit: string; currency: string; investors: string; valuation: string; source: string; note: string;
  }>({ round: '', date: '', amount: '', amountUnit: '亿', currency: 'CNY', investors: '', valuation: '', source: '', note: '' });

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

  // 该公司的内推信息：与内推板块共用同一份数据，这里只读 + 快速新增。
  const { data: referralRows = [] } = useQuery({
    queryKey: ['referrals', 'company', id],
    queryFn: () => api<ReferralItem[]>(`/referrals?companyId=${encodeURIComponent(String(id))}`),
    enabled: !!id,
  });
  const referralList = referralRows.map((r) => ({ row: r, ref: normalizeReferral(r.payload, r.companyId) }));

  const invalidateCompanies = () => qc.invalidateQueries({ queryKey: ['companies'] });
  const invalidateJds = () => qc.invalidateQueries({ queryKey: ['jds', id] });
  const invalidateReferrals = () => {
    qc.invalidateQueries({ queryKey: ['referrals', 'company', id] });
    qc.invalidateQueries({ queryKey: ['referrals'] });
  };
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

  /** 招聘官网 / 内推入口：只补这两个键，其余 payload 原样带回去。 */
  const linksM = useMutation({
    mutationFn: (patch: Record<string, string>) =>
      put<CompanyItem>(`/companies/${id}`, { payload: { ...(company?.payload || {}), ...patch } }),
    onSuccess: () => {
      setCareersDraft(null);
      setReferralDraft(null);
      invalidateCompanies();
    },
    onError: onFail,
  });

  /** 决策闭环三件套：verdict / interviews / questions 统一走这个整包写回。 */
  const patchM = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      put<CompanyItem>(`/companies/${id}`, { payload: { ...(company?.payload || {}), ...patch } }),
    onSuccess: invalidateCompanies,
    onError: onFail,
  });

  const addReferralM = useMutation({
    mutationFn: () =>
      post<ReferralItem>('/referrals', {
        companyId: id,
        payload: {
          companyName: company?.name,
          referrer: quickRef.referrer.trim(),
          position: quickRef.position.trim(),
          channel: quickRef.channel.trim(),
          status: quickRef.status,
        },
      }),
    onSuccess: () => {
      setQuickRef({ referrer: '', position: '', channel: '', status: 'pending' });
      invalidateReferrals();
    },
    onError: onFail,
  });

  const deleteReferralM = useMutation({
    mutationFn: (rid: string) => del(`/referrals/${rid}`),
    onSuccess: invalidateReferrals,
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

  const [pngBusy, setPngBusy] = useState(false);
  const [pngError, setPngError] = useState('');

  /** 简报 PNG：走服务端 headless Chrome 截图（同源 cookie 自动带上鉴权）。 */
  async function downloadBriefPng() {
    if (!company) return;
    setPngBusy(true);
    setPngError('');
    try {
      const q = new URLSearchParams({
        rumors: briefCfg.includeRumors ? '1' : '0',
        verdict: briefCfg.includeVerdict ? '1' : '0',
        interviews: briefCfg.includeInterviews ? '1' : '0',
        questions: briefCfg.includeQuestions ? '1' : '0',
      });
      const resp = await fetch(`/api/companies/${company.id}/brief.png?${q.toString()}`, {
        credentials: 'same-origin',
      });
      if (!resp.ok) {
        let msg = `生成失败（${resp.status}）`;
        try {
          const j = await resp.json();
          if (j?.hint) msg += `：${j.hint}`;
          else if (j?.error) msg += `：${j.error}`;
        } catch { /* 非 JSON 响应忽略 */ }
        setPngError(msg);
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(company.name || '公司').replace(/[\\/:*?"<>|]/g, '_')}-公司简报.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) {
      setPngError((e as Error).message || '生成失败');
    } finally {
      setPngBusy(false);
    }
  }

  if (isLoading) return <p className="muted">加载中…</p>;
  if (!company || !intel) return <p className="muted">未找到公司。</p>;

  const cov = dimensionCoverage(intel);
  const careersUrl = careersDraft ?? careersUrlOf(company?.payload);
  const referralUrl = referralDraft ?? referralEntryUrlOf(company?.payload);

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
            onClick={() => setDeleteCompanyOpen(true)}
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
          {careersUrl && (
            <a className="meta-chip" href={careersUrl} target="_blank" rel="noopener noreferrer">
              招聘官网 ↗
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

      {/* 招聘入口 + 内推信息：公司详情只读展示，编辑统一在内推板块 */}
      <section className="detail-section">
        <div className="section-head">
          <h3 className="sub">招聘官网与内推（{referralList.length}）</h3>
          <Link to={`/referrals?company=${company.id}`} className="detail-back">
            在内推板块管理 →
          </Link>
        </div>

        <div className="ref-link-grid">
          <label>
            招聘官网链接
            <input
              value={careersUrl}
              onChange={(e) => setCareersDraft(e.target.value)}
              placeholder="https://careers.example.com"
            />
          </label>
          <label>
            内推入口（可选）
            <input
              value={referralUrl}
              onChange={(e) => setReferralDraft(e.target.value)}
              placeholder="https://…/referral"
            />
          </label>
          <button
            className="mini primary"
            disabled={linksM.isPending}
            onClick={() =>
              linksM.mutate({ careersUrl: careersUrl.trim(), referralUrl: referralUrl.trim() })
            }
          >
            {linksM.isPending ? '保存中…' : '保存链接'}
          </button>
        </div>

        <div className="btn-row">
          {careersUrl ? (
            <a className="mini" href={careersUrl} target="_blank" rel="noopener noreferrer">
              打开招聘官网 ↗
            </a>
          ) : (
            <span className="muted small">还没有记录招聘官网链接。</span>
          )}
          {referralUrl && (
            <a className="mini" href={referralUrl} target="_blank" rel="noopener noreferrer">
              打开内推入口 ↗
            </a>
          )}
        </div>

        {/* 快速新增：完整字段在内推板块里编辑 */}
        <form
          className="ref-quick"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (!quickRef.referrer.trim() && !quickRef.position.trim()) {
              setError('内推人与岗位至少填一个');
              return;
            }
            addReferralM.mutate();
          }}
        >
          <input
            value={quickRef.referrer}
            onChange={(e) => setQuickRef({ ...quickRef, referrer: e.target.value })}
            placeholder="内推人"
          />
          <input
            value={quickRef.position}
            onChange={(e) => setQuickRef({ ...quickRef, position: e.target.value })}
            placeholder="内推岗位"
          />
          <input
            value={quickRef.channel}
            onChange={(e) => setQuickRef({ ...quickRef, channel: e.target.value })}
            placeholder="渠道（朋友 / 脉脉…）"
          />
          <select
            value={quickRef.status}
            onChange={(e) => setQuickRef({ ...quickRef, status: e.target.value })}
          >
            <option value="pending">待沟通</option>
            <option value="contacted">已沟通</option>
            <option value="submitted">已内推</option>
            <option value="screening">简历通过</option>
            <option value="interviewing">面试中</option>
            <option value="offered">已录用</option>
            <option value="closed">已失效</option>
          </select>
          <button className="mini" type="submit" disabled={addReferralM.isPending}>
            {addReferralM.isPending ? '添加中…' : '添加内推'}
          </button>
        </form>

        {referralList.length ? (
          <ul className="mini-list ref-list-mini">
            {referralList.map(({ row, ref: r }, i) => {
              const meta = statusMeta(r.status);
              return (
                <li key={row.id || i}>
                  <div className="ref-row-head">
                    <strong>{r.position || r.referrer || '未命名内推'}</strong>
                    <span className={`status-badge tone-${meta.tone}`}>{meta.label}</span>
                  </div>
                  <div className="muted small">
                    {r.referrer ? `内推人 ${r.referrer}` : '内推人未填'}
                    {r.channel ? ` · ${r.channel}` : ''}
                    {r.followUpAt ? ` · ${r.followUpAt} 跟进` : ''}
                  </div>
                  <div className="btn-row">
                    {r.jobUrl && (
                      <a className="mini" href={r.jobUrl} target="_blank" rel="noopener noreferrer">
                        岗位链接 ↗
                      </a>
                    )}
                    {r.sourceUrl && (
                      <a className="mini" href={r.sourceUrl} target="_blank" rel="noopener noreferrer">
                        原帖 ↗
                      </a>
                    )}
                    {r.referralCode && <span className="tag">内推码 {r.referralCode}</span>}
                    <button
                      className="mini danger"
                      onClick={() => setDeleteReferralId(row.id)}
                    >
                      删除
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted small" style={{ marginTop: 12 }}>
            还没有这家公司的内推信息。上方快速添加，或去内推板块录入完整信息（内推码、有效期、跟进日期）。
          </p>
        )}
      </section>

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
            <label className="check-line">
              <input
                type="checkbox"
                checked={briefCfg.includeInterviews}
                onChange={(e) => setBriefCfg((c) => ({ ...c, includeInterviews: e.target.checked }))}
              />
              面试与面经
            </label>
            <label className="check-line">
              <input
                type="checkbox"
                checked={briefCfg.includeQuestions}
                onChange={(e) => setBriefCfg((c) => ({ ...c, includeQuestions: e.target.checked }))}
              />
              待核实问题
            </label>
          </div>
          <textarea className="mono brief-out" rows={12} value={briefMd} readOnly spellCheck={false} />
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button className="mini primary" onClick={copyBrief}>复制 Markdown</button>
            <button className="mini" onClick={downloadBrief}>下载 .md</button>
            <button className="mini" onClick={downloadBriefPng} disabled={pngBusy}>
              {pngBusy ? '生成中…' : '下载图片 PNG'}
            </button>
            {pngError && <span className="muted small">{pngError}</span>}
            {copied && <span className="muted small">{copied}</span>}
          </div>
        </section>
      )}

      {/* 我的判断（决策闭环） */}
      <section className="detail-section">
        <h3 className="sub">我的判断（决策结论）</h3>
        {intel.verdict ? (
          <div className="verdict-card">
            <div className="verdict-head">
              {intel.verdict.recommendation ? (
                <strong className="verdict-level">{intel.verdict.recommendation}</strong>
              ) : (
                <span className="muted small">未标推荐度</span>
              )}
            </div>
            <dl className="verdict-kv">
              {intel.verdict.expectedSalary && (
                <div><dt>期望薪资 / 谈判底线</dt><dd>{intel.verdict.expectedSalary}</dd></div>
              )}
              {intel.verdict.resumeFor && (
                <div><dt>对应简历</dt><dd>{intel.verdict.resumeFor}</dd></div>
              )}
              {intel.verdict.concerns && (
                <div><dt>关注点</dt><dd>{intel.verdict.concerns}</dd></div>
              )}
              {intel.verdict.redline && (
                <div><dt>风险红线</dt><dd>{intel.verdict.redline}</dd></div>
              )}
            </dl>
            <div className="btn-row">
              <button
                className="mini danger"
                disabled={patchM.isPending}
                onClick={() => patchM.mutate({ verdict: null })}
              >
                清除判断
              </button>
            </div>
          </div>
        ) : (
          <p className="muted small">还没有记录判断结论。投递前把「值不值得投、要什么价、踩什么红线」落下来。</p>
        )}
        <div className="form-grid" style={{ marginTop: 12 }}>
          <label>
            推荐度
            <select
              value={verdictDraft.recommendation || (intel.verdict?.recommendation as string) || ''}
              onChange={(e) => setVerdictDraft((d) => ({ ...d, recommendation: e.target.value }))}
            >
              <option value="">—</option>
              {VERDICT_LEVELS.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </label>
          <label>
            期望薪资 / 谈判底线
            <input
              value={verdictDraft.expectedSalary}
              onChange={(e) => setVerdictDraft((d) => ({ ...d, expectedSalary: e.target.value }))}
              placeholder="如：30K×14，底线 28K"
            />
          </label>
          <label>
            对应简历
            <input
              value={verdictDraft.resumeFor}
              onChange={(e) => setVerdictDraft((d) => ({ ...d, resumeFor: e.target.value }))}
              placeholder="如：AI 工程师主简历"
            />
          </label>
          <label>
            关注点
            <input
              value={verdictDraft.concerns}
              onChange={(e) => setVerdictDraft((d) => ({ ...d, concerns: e.target.value }))}
              placeholder="如：现金流、加班"
            />
          </label>
          <label>
            风险红线
            <input
              value={verdictDraft.redline}
              onChange={(e) => setVerdictDraft((d) => ({ ...d, redline: e.target.value }))}
              placeholder="如：不接受大小周"
            />
          </label>
        </div>
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button
            className="mini primary"
            disabled={patchM.isPending}
            onClick={() => {
              const v = {
                ...(intel.verdict || {}),
                recommendation: verdictDraft.recommendation || (intel.verdict?.recommendation as string) || '',
                expectedSalary: verdictDraft.expectedSalary || (intel.verdict?.expectedSalary as string) || '',
                resumeFor: verdictDraft.resumeFor || (intel.verdict?.resumeFor as string) || '',
                concerns: verdictDraft.concerns || (intel.verdict?.concerns as string) || '',
                redline: verdictDraft.redline || (intel.verdict?.redline as string) || '',
              };
              patchM.mutate({ verdict: v });
              setVerdictDraft({ recommendation: '', expectedSalary: '', resumeFor: '', concerns: '', redline: '' });
            }}
          >
            保存判断
          </button>
        </div>
      </section>

      {/* 面试与面经 */}
      <section className="detail-section">
        <h3 className="sub">面试与面经（{(intel.interviews || []).length}）</h3>
        {(intel.interviews || []).length ? (
          <ul className="mini-list">
            {(intel.interviews || []).map((it: any, i: number) => (
              <li key={it.id || i}>
                <div className="ref-row-head">
                  <strong>
                    {[it.round, it.form, it.date].filter(Boolean).join(' · ') || '面试'}
                    {it.duration ? `（${it.duration}）` : ''}
                  </strong>
                </div>
                {it.questions && <div className="muted small clamp-4">{it.questions}</div>}
                {it.style && <div className="muted small">面试官风格：{it.style}</div>}
                {it.feedback && <div className="muted small">反馈 / 结果：{it.feedback}</div>}
                {it.offerDeadline && <div className="muted small">offer 时效：{it.offerDeadline}</div>}
                <div className="btn-row">
                  <button
                    className="mini danger"
                    disabled={patchM.isPending}
                    onClick={() =>
                      patchM.mutate({ interviews: (intel.interviews || []).filter((_: any, idx: number) => idx !== i) })
                    }
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">暂无面经。这家公司「怎么面人」的信息记这里。</p>
        )}
        <details className="detail-section" style={{ marginTop: 8 }}>
          <summary className="sub">添加一条面经</summary>
          <div className="form-grid">
            <label>
              轮次
              <select
                value={interviewDraft.round}
                onChange={(e) => setInterviewDraft((d) => ({ ...d, round: e.target.value }))}
              >
                <option value="">—</option>
                {INTERVIEW_ROUNDS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </label>
            <label>
              形式
              <select
                value={interviewDraft.form}
                onChange={(e) => setInterviewDraft((d) => ({ ...d, form: e.target.value }))}
              >
                <option value="">—</option>
                {INTERVIEW_FORMS.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </label>
            <label>
              日期
              <input
                value={interviewDraft.date}
                onChange={(e) => setInterviewDraft((d) => ({ ...d, date: e.target.value }))}
                placeholder="2026-11"
              />
            </label>
            <label>
              时长
              <input
                value={interviewDraft.duration}
                onChange={(e) => setInterviewDraft((d) => ({ ...d, duration: e.target.value }))}
                placeholder="如：60 分钟"
              />
            </label>
            <label>
              真题 / 内容
              <textarea
                rows={3}
                value={interviewDraft.questions}
                onChange={(e) => setInterviewDraft((d) => ({ ...d, questions: e.target.value }))}
                placeholder="问了什么、考了什么"
              />
            </label>
            <label>
              面试官风格
              <input
                value={interviewDraft.style}
                onChange={(e) => setInterviewDraft((d) => ({ ...d, style: e.target.value }))}
                placeholder="如：追问系统设计"
              />
            </label>
            <label>
              反馈 / 结果
              <input
                value={interviewDraft.feedback}
                onChange={(e) => setInterviewDraft((d) => ({ ...d, feedback: e.target.value }))}
                placeholder="如：算法偏弱"
              />
            </label>
            <label>
              offer 时效
              <input
                value={interviewDraft.offerDeadline}
                onChange={(e) => setInterviewDraft((d) => ({ ...d, offerDeadline: e.target.value }))}
                placeholder="如：3 天内回复"
              />
            </label>
          </div>
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button
              className="mini primary"
              disabled={patchM.isPending}
              onClick={() => {
                const it = {
                  id: `int-${Date.now()}`,
                  round: interviewDraft.round,
                  form: interviewDraft.form,
                  date: interviewDraft.date,
                  duration: interviewDraft.duration,
                  questions: interviewDraft.questions,
                  style: interviewDraft.style,
                  feedback: interviewDraft.feedback,
                  offerDeadline: interviewDraft.offerDeadline,
                };
                patchM.mutate({ interviews: [...(intel.interviews || []), it] });
                setInterviewDraft({ round: '', form: '', date: '', duration: '', questions: '', style: '', feedback: '', offerDeadline: '' });
              }}
            >
              添加面经
            </button>
          </div>
        </details>
      </section>

      {/* 待核实问题清单 */}
      <section className="detail-section">
        <h3 className="sub">待核实问题清单（{(intel.questions || []).length}）</h3>
        {(intel.questions || []).length ? (
          <ul className="mini-list">
            {(intel.questions || []).map((q: any, i: number) => (
              <li key={q.id || i}>
                <div className="ref-row-head">
                  <span>{q.text}</span>
                  <span className="tag">{q.status || '待核实'}</span>
                </div>
                <div className="btn-row">
                  {q.status !== '已核实' && (
                    <button
                      className="mini"
                      disabled={patchM.isPending}
                      onClick={() =>
                        patchM.mutate({
                          questions: (intel.questions || []).map((_: any, idx: number) =>
                            idx === i ? { ..._, status: '已核实' } : _
                          ),
                        })
                      }
                    >
                      标记已核实
                    </button>
                  )}
                  <button
                    className="mini danger"
                    disabled={patchM.isPending}
                    onClick={() =>
                      patchM.mutate({ questions: (intel.questions || []).filter((_: any, idx: number) => idx !== i) })
                    }
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">把「不知道的」显式记下来，驱动下一次采集——融资是否到账、团队是否扩张、这个岗是不是新设。</p>
        )}
        <form
          className="row compact"
          style={{ marginTop: 8 }}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (!questionDraft.text.trim()) return;
            patchM.mutate({
              questions: [...(intel.questions || []), { id: `q-${Date.now()}`, text: questionDraft.text.trim(), status: '待核实' }],
            });
            setQuestionDraft({ text: '' });
          }}
        >
          <input
            value={questionDraft.text}
            onChange={(e) => setQuestionDraft({ text: e.target.value })}
            placeholder="如：融资 B 轮是否已到账？"
          />
          <button className="mini" type="submit" disabled={patchM.isPending || !questionDraft.text.trim()}>
            添加
          </button>
        </form>
      </section>

      {/* 薪资水平（按岗位族分箱） */}
      <section className="detail-section">
        <h3 className="sub">薪资水平（{(intel.salaries || []).length}）</h3>
        {(intel.salaries || []).length ? (
          <ul className="mini-list">
            {normalizeSalaries(intel.salaries).map((s: any, i: number) => (
              <li key={s.id || i}>
                <div className="ref-row-head">
                  <strong>
                    {s.role || '岗位'} {s.level ? `· ${s.level}` : ''}
                  </strong>
                  <span className="tag">
                    {s.period === '年薪' ? `${s.low}–${s.high} 万/年` : `${s.low}–${s.high}K/月`}
                    {s.months ? ` ×${s.months}` : ''}
                  </span>
                </div>
                {s.avg != null && <div className="muted small">均值 {s.avg}（{s.currency || 'CNY'}）</div>}
                {(s.sampleSize != null || s.source || s.date) && (
                  <div className="muted small">
                    {s.sampleSize != null ? `样本 ${s.sampleSize}` : ''}
                    {s.source ? ` · 来源 ${s.source}` : ''}
                    {s.date ? ` · ${s.date}` : ''}
                  </div>
                )}
                {s.note && <div className="muted small clamp-4">{s.note}</div>}
                <div className="btn-row">
                  <button
                    className="mini danger"
                    disabled={patchM.isPending}
                    onClick={() => patchM.mutate({ salaries: (intel.salaries || []).filter((_: any, idx: number) => idx !== i) })}
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">暂无薪资样本。员工自述样本，仅供参考；按岗位族分箱，不做公司整体平均。</p>
        )}
        <details className="detail-section" style={{ marginTop: 8 }}>
          <summary className="sub">添加薪资样本</summary>
          <div className="form-grid two">
            <label>
              岗位族
              <input value={salaryDraft.role} onChange={(e) => setSalaryDraft((d) => ({ ...d, role: e.target.value }))} placeholder="如：算法 / 后端" />
            </label>
            <label>
              职级
              <input value={salaryDraft.level} onChange={(e) => setSalaryDraft((d) => ({ ...d, level: e.target.value }))} placeholder="如：P6 / 3-1" />
            </label>
            <label>
              下限（{salaryDraft.period === '年薪' ? '万/年' : 'K/月'}）
              <input value={salaryDraft.low} onChange={(e) => setSalaryDraft((d) => ({ ...d, low: e.target.value }))} placeholder="25" />
            </label>
            <label>
              上限（{salaryDraft.period === '年薪' ? '万/年' : 'K/月'}）
              <input value={salaryDraft.high} onChange={(e) => setSalaryDraft((d) => ({ ...d, high: e.target.value }))} placeholder="40" />
            </label>
            <label>
              均值（可选）
              <input value={salaryDraft.avg} onChange={(e) => setSalaryDraft((d) => ({ ...d, avg: e.target.value }))} placeholder="32" />
            </label>
            <label>
              周期
              <select value={salaryDraft.period} onChange={(e) => setSalaryDraft((d) => ({ ...d, period: e.target.value }))}>
                {SALARY_PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label>
              薪资月数（13/14/16 薪）
              <input value={salaryDraft.months} onChange={(e) => setSalaryDraft((d) => ({ ...d, months: e.target.value }))} placeholder="14" />
            </label>
            <label>
              样本数
              <input value={salaryDraft.sampleSize} onChange={(e) => setSalaryDraft((d) => ({ ...d, sampleSize: e.target.value }))} placeholder="5" />
            </label>
            <label>
              来源
              <input value={salaryDraft.source} onChange={(e) => setSalaryDraft((d) => ({ ...d, source: e.target.value }))} placeholder="脉脉 / OfferShow" />
            </label>
            <label>
              采集日期
              <input value={salaryDraft.date} onChange={(e) => setSalaryDraft((d) => ({ ...d, date: e.target.value }))} placeholder="2026-11" />
            </label>
            <label>
              备注
              <input value={salaryDraft.note} onChange={(e) => setSalaryDraft((d) => ({ ...d, note: e.target.value }))} placeholder="含绩效 / 不含股" />
            </label>
          </div>
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button
              className="mini primary"
              disabled={patchM.isPending || !salaryDraft.role.trim()}
              onClick={() => {
                const s = {
                  id: `sal-${Date.now()}`,
                  role: salaryDraft.role.trim(),
                  level: salaryDraft.level.trim(),
                  low: Number(salaryDraft.low) || 0,
                  high: Number(salaryDraft.high) || 0,
                  avg: salaryDraft.avg ? Number(salaryDraft.avg) : undefined,
                  period: salaryDraft.period,
                  months: salaryDraft.months ? Number(salaryDraft.months) : undefined,
                  sampleSize: salaryDraft.sampleSize ? Number(salaryDraft.sampleSize) : undefined,
                  currency: 'CNY',
                  source: salaryDraft.source.trim(),
                  date: salaryDraft.date.trim(),
                  note: salaryDraft.note.trim(),
                };
                patchM.mutate({ salaries: [...(intel.salaries || []), s] });
                setSalaryDraft({ role: '', level: '', low: '', high: '', avg: '', period: '月薪', months: '', sampleSize: '', source: '', date: '', note: '' });
              }}
            >
              添加薪资样本
            </button>
          </div>
        </details>
      </section>

      {/* 连续融资情况 */}
      <section className="detail-section">
        <h3 className="sub">连续融资（{(intel.fundingRounds || []).length}）</h3>
        {(intel.fundingRounds || []).length ? (
          <ul className="mini-list">
            {normalizeFundingRounds(intel.fundingRounds).map((r: any, i: number) => (
              <li key={r.id || i}>
                <div className="ref-row-head">
                  <strong>
                    {r.round} {r.date ? `· ${r.date}` : ''}
                  </strong>
                  <span className="tag">
                    {r.amount != null ? `${r.amount}${r.amountUnit || '亿'} ${r.currency || 'CNY'}` : '金额未披露'}
                  </span>
                </div>
                {(r.investors?.length || r.valuation) && (
                  <div className="muted small">
                    {r.investors?.length ? `投资方 ${r.investors.join('、')}` : ''}
                    {r.valuation ? ` · 估值 ${r.valuation}` : ''}
                  </div>
                )}
                {(r.source || r.note) && (
                  <div className="muted small">{r.source ? `来源 ${r.source}` : ''}{r.note ? ` · ${r.note}` : ''}</div>
                )}
                <div className="btn-row">
                  <button
                    className="mini danger"
                    disabled={patchM.isPending}
                    onClick={() => patchM.mutate({ fundingRounds: (intel.fundingRounds || []).filter((_: any, idx: number) => idx !== i) })}
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">暂无融资轮次数据。补充轮次数据即可生成融资节奏（累计额 / 轮次数 / 间隔）。</p>
        )}
        <details className="detail-section" style={{ marginTop: 8 }}>
          <summary className="sub">添加融资轮次</summary>
          <div className="form-grid two">
            <label>
              轮次
              <select value={fundingDraft.round} onChange={(e) => setFundingDraft((d) => ({ ...d, round: e.target.value }))}>
                <option value="">—</option>
                {FUNDING_ROUNDS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <label>
              日期
              <input value={fundingDraft.date} onChange={(e) => setFundingDraft((d) => ({ ...d, date: e.target.value }))} placeholder="2026-05" />
            </label>
            <label>
              金额
              <input value={fundingDraft.amount} onChange={(e) => setFundingDraft((d) => ({ ...d, amount: e.target.value }))} placeholder="3" />
            </label>
            <label>
              金额单位
              <select value={fundingDraft.amountUnit} onChange={(e) => setFundingDraft((d) => ({ ...d, amountUnit: e.target.value }))}>
                <option value="亿">亿</option>
                <option value="万">万</option>
              </select>
            </label>
            <label>
              币种
              <select value={fundingDraft.currency} onChange={(e) => setFundingDraft((d) => ({ ...d, currency: e.target.value }))}>
                {FUNDING_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label>
              投资方（逗号分隔）
              <input value={fundingDraft.investors} onChange={(e) => setFundingDraft((d) => ({ ...d, investors: e.target.value }))} placeholder="红杉, 高瓴" />
            </label>
            <label>
              估值
              <input value={fundingDraft.valuation} onChange={(e) => setFundingDraft((d) => ({ ...d, valuation: e.target.value }))} placeholder="10 亿" />
            </label>
            <label>
              来源
              <input value={fundingDraft.source} onChange={(e) => setFundingDraft((d) => ({ ...d, source: e.target.value }))} placeholder="企查查 / 36氪" />
            </label>
            <label>
              备注
              <input value={fundingDraft.note} onChange={(e) => setFundingDraft((d) => ({ ...d, note: e.target.value }))} placeholder="领投方 / 老股东跟投" />
            </label>
          </div>
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button
              className="mini primary"
              disabled={patchM.isPending || !fundingDraft.round}
              onClick={() => {
                const r = {
                  id: `fund-${Date.now()}`,
                  round: fundingDraft.round,
                  date: fundingDraft.date.trim(),
                  amount: fundingDraft.amount ? Number(fundingDraft.amount) : undefined,
                  amountUnit: fundingDraft.amountUnit,
                  currency: fundingDraft.currency,
                  investors: fundingDraft.investors ? fundingDraft.investors.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [],
                  valuation: fundingDraft.valuation.trim(),
                  source: fundingDraft.source.trim(),
                  note: fundingDraft.note.trim(),
                };
                patchM.mutate({ fundingRounds: [...(intel.fundingRounds || []), r] });
                setFundingDraft({ round: '', date: '', amount: '', amountUnit: '亿', currency: 'CNY', investors: '', valuation: '', source: '', note: '' });
              }}
            >
              添加融资轮次
            </button>
          </div>
        </details>
      </section>

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
                  {j.payload?.publishDate
                    ? ` · 发布于 ${j.payload.publishDate}`
                    : j.payload?.updatedDate
                      ? ` · 更新于 ${j.payload.updatedDate}`
                      : ''}
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

      <ConfirmModal
        open={deleteCompanyOpen}
        title="删除公司"
        message={`确认删除「${company.name}」及其全部岗位 JD？此操作不可撤销。`}
        confirmLabel="删除"
        busy={deleteM.isPending}
        onConfirm={() => {
          deleteM.mutate(company.id);
          setDeleteCompanyOpen(false);
        }}
        onCancel={() => setDeleteCompanyOpen(false)}
      />

      <ConfirmModal
        open={deleteReferralId !== null}
        title="删除内推"
        message={
          deleteReferralId
            ? `确认删除「${(() => { const hit = referralList.find((x) => x.row.id === deleteReferralId); return hit ? referralTitle(hit.ref) : '这条内推'; })()}」？此操作不可撤销。`
            : ''
        }
        confirmLabel="删除"
        busy={deleteReferralM.isPending}
        onConfirm={() => {
          if (deleteReferralId) deleteReferralM.mutate(deleteReferralId);
          setDeleteReferralId(null);
        }}
        onCancel={() => setDeleteReferralId(null)}
      />
    </div>
  );
}

// 从原 Companies.tsx 复制的 normalizeCompany
import { normalizeCompany } from '../company-intel';
