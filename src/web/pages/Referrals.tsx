import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, del, fmtTime, post, put, type CompanyItem, type ReferralItem } from '../api';
import {
  followUpInfo,
  isActiveReferral,
  matchReferral,
  normalizeReferral,
  REFERRAL_CHANNELS,
  REFERRAL_STATUSES,
  referralStats,
  referralTitle,
  statusMeta,
  type Referral,
} from '../referrals';

interface FormState {
  companyId: string;
  referrer: string;
  referrerRole: string;
  contact: string;
  position: string;
  city: string;
  salary: string;
  channel: string;
  status: string;
  jobUrl: string;
  referralCode: string;
  validUntil: string;
  appliedAt: string;
  followUpAt: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  companyId: '',
  referrer: '',
  referrerRole: '',
  contact: '',
  position: '',
  city: '',
  salary: '',
  channel: '',
  status: 'pending',
  jobUrl: '',
  referralCode: '',
  validUntil: '',
  appliedAt: '',
  followUpAt: '',
  notes: '',
};

function toForm(r: Referral): FormState {
  return {
    companyId: r.companyId || '',
    referrer: r.referrer,
    referrerRole: r.referrerRole,
    contact: r.contact,
    position: r.position,
    city: r.city,
    salary: r.salary,
    channel: r.channel,
    status: r.status,
    jobUrl: r.jobUrl,
    referralCode: r.referralCode,
    validUntil: r.validUntil,
    appliedAt: r.appliedAt,
    followUpAt: r.followUpAt,
    notes: r.notes,
  };
}

/**
 * 内推板块：统一管理所有内推信息。
 *
 * 与「投递管理 / 公司档案」的分工：
 *   · 这里存的是「资源」——谁可以帮你内推、哪个岗位、内推码、链接、进展到哪一步；
 *   · 公司档案只做公司本身的情报，通过 companyId 反向关联到这里的记录；
 *   · 投递记录（tracker / applications）才是「我已经投了哪家」的事实源。
 */
export default function Referrals() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const companyFilter = params.get('company') || '';
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['referrals'],
    queryFn: () => api<ReferralItem[]>('/referrals'),
  });

  const { data: companies = [] } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<CompanyItem[]>('/companies'),
  });

  const list = useMemo(
    () => rows.map((r) => ({ row: r, ref: normalizeReferral(r.payload, r.companyId) })),
    [rows]
  );

  const stats = useMemo(() => {
    const all = list.filter(({ ref }) => (companyFilter ? ref.companyId === companyFilter : true));
    return referralStats(all.map((x) => x.ref));
  }, [list, companyFilter]);

  const filtered = useMemo(() => {
    return list
      .filter(({ ref }) => (companyFilter ? ref.companyId === companyFilter : true))
      .filter(({ ref }) => (statusFilter ? ref.status === statusFilter : true))
      .filter(({ ref }) => matchReferral(ref, query))
      .sort((a, b) => {
        // 进行中优先，其次按下次跟进日期，再按更新时间。
        const activeDiff = Number(!isActiveReferral(a.ref)) - Number(!isActiveReferral(b.ref));
        if (activeDiff !== 0) return activeDiff;
        const fa = a.ref.followUpAt || '9999-12-31';
        const fb = b.ref.followUpAt || '9999-12-31';
        if (fa !== fb) return fa < fb ? -1 : 1;
        return String(b.row.updatedAt).localeCompare(String(a.row.updatedAt));
      });
  }, [list, companyFilter, statusFilter, query]);

  const companyOptions = useMemo(
    () => companies.map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
    [companies]
  );

  const selected = selectedId ? list.find((x) => x.row.id === selectedId) : null;

  const invalidate = () => qc.invalidateQueries({ queryKey: ['referrals'] });
  const onFail = (e: unknown) => {
    setError((e as Error).message);
    setNote('');
  };

  const buildPayload = () => ({
    referrer: form.referrer.trim(),
    referrerRole: form.referrerRole.trim(),
    contact: form.contact.trim(),
    position: form.position.trim(),
    city: form.city.trim(),
    salary: form.salary.trim(),
    channel: form.channel.trim(),
    status: form.status,
    jobUrl: form.jobUrl.trim(),
    referralCode: form.referralCode.trim(),
    validUntil: form.validUntil,
    appliedAt: form.appliedAt,
    followUpAt: form.followUpAt,
    notes: form.notes.trim(),
  });

  const createM = useMutation({
    mutationFn: () =>
      post<ReferralItem>('/referrals', {
        companyId: form.companyId || null,
        payload: buildPayload(),
      }),
    onSuccess: (row) => {
      invalidate();
      setEditing(false);
      setSelectedId(row.id);
      const ref = normalizeReferral(row.payload, row.companyId);
      setForm(toForm(ref));
      setError('');
      setNote('已新增内推信息');
    },
    onError: onFail,
  });

  const updateM = useMutation({
    mutationFn: () =>
      put<ReferralItem>(`/referrals/${selectedId}`, {
        companyId: form.companyId || null,
        payload: buildPayload(),
      }),
    onSuccess: (row) => {
      invalidate();
      setEditing(false);
      setSelectedId(row.id);
      setForm(toForm(normalizeReferral(row.payload, row.companyId)));
      setError('');
      setNote('已保存');
    },
    onError: onFail,
  });

  const deleteM = useMutation({
    mutationFn: (id: string) => del(`/referrals/${id}`),
    onSuccess: () => {
      invalidate();
      setSelectedId(null);
      setEditing(false);
      setForm(EMPTY_FORM);
      setError('');
      setNote('已删除内推信息');
    },
    onError: onFail,
  });

  function startNew() {
    setSelectedId(null);
    setEditing(true);
    setForm({ ...EMPTY_FORM, companyId: companyFilter });
    setError('');
    setNote('');
  }

  function startEdit(row: ReferralItem, ref: Referral) {
    setSelectedId(row.id);
    setEditing(true);
    setForm(toForm(ref));
    setError('');
    setNote('');
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!form.referrer.trim() && !form.position.trim()) {
      setError('内推人与岗位至少填一个');
      return;
    }
    if (editing && selectedId) updateM.mutate();
    else createM.mutate();
  }

  function setCompanyFilter(v: string) {
    const next = new URLSearchParams(params);
    if (v) next.set('company', v);
    else next.delete('company');
    setParams(next, { replace: true });
    setSelectedId(null);
    setEditing(false);
  }

  const companyNameOf = (id: string) => companyOptions.find((c) => c.id === id)?.name || '';
  const busy = createM.isPending || updateM.isPending;
  return (
    <>
      <div className="page-head">
        <h1>内推管理</h1>
        <p className="muted small">
          统一管理所有内推信息：内推人、岗位、渠道、内推码、跟进节奏。公司档案通过记录里的公司自动关联。
          {companyFilter && companyNameOf(companyFilter) ? ` 当前只显示「${companyNameOf(companyFilter)}」。` : ''}
        </p>
      </div>

      {error && <div className="alert">{error}</div>}
      {note && <div className="hint">{note}</div>}

      <div className="btn-row ref-stats">
        <span className="chip">内推 {stats.total}</span>
        <span className="chip">进行中 {stats.active}</span>
        <span className="chip">已内推 {stats.submitted}</span>
        <span className="chip">已录用 {stats.offered}</span>
        <span className="chip">3 天内需跟进 {stats.dueSoon}</span>
        <span className="chip">覆盖公司 {stats.companies}</span>
      </div>

      <div className="ref-toolbar">
        <input
          className="ref-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索公司 / 岗位 / 内推人 / 渠道 / 内推码 / 备注"
        />
        <select value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)}>
          <option value="">全部公司</option>
          {companyOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">全部状态</option>
          {REFERRAL_STATUSES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <button className="mini primary" onClick={startNew}>
          + 新增内推
        </button>
      </div>

      <div className="ref-layout">
        {/* 左：内推列表 */}
        <div className="ref-list">
          {isLoading ? (
            <p className="muted">加载中…</p>
          ) : filtered.length === 0 ? (
            <div className="empty">
              {rows.length ? '没有命中筛选的内推信息。' : '还没有内推信息，点右上角「新增内推」开始记录。'}
            </div>
          ) : (
            filtered.map(({ row, ref }) => {
              const meta = statusMeta(ref.status);
              const due = followUpInfo(ref);
              return (
                <div
                  key={row.id}
                  className={'ref-card' + (selectedId === row.id ? ' selected' : '')}
                  onClick={() => {
                    setSelectedId(row.id);
                    setEditing(false);
                  }}
                >
                  <div className="ref-card-head">
                    <strong className="ref-card-title">{referralTitle(ref)}</strong>
                    <span className={`status-badge tone-${meta.tone}`}>{meta.label}</span>
                  </div>
                  <div className="ref-card-meta">
                    {ref.referrer && <span>内推人：{ref.referrer}{ref.referrerRole ? `（${ref.referrerRole}）` : ''}</span>}
                    {ref.channel && <span>渠道：{ref.channel}</span>}
                    {ref.city && <span>{ref.city}</span>}
                    {ref.salary && <span className="li-salary">{ref.salary}</span>}
                  </div>
                  {(ref.referralCode || ref.jobUrl || ref.sourceUrl) && (
                    <div className="ref-card-links" onClick={(e) => e.stopPropagation()}>
                      {ref.referralCode && <span className="tag">内推码 {ref.referralCode}</span>}
                      {ref.jobUrl && (
                        <a href={ref.jobUrl} target="_blank" rel="noopener noreferrer">
                          岗位链接 ↗
                        </a>
                      )}
                      {ref.sourceUrl && (
                        <a href={ref.sourceUrl} target="_blank" rel="noopener noreferrer">
                          {ref.source === '脉脉' ? '脉脉原帖 ↗' : '原帖 ↗'}
                        </a>
                      )}
                    </div>
                  )}
                  <div className="ref-card-foot">
                    {due ? <span className={`status-badge tone-${due.tone}`}>{due.text}</span> : <span />}
                    <span className="muted small">更新 {fmtTime(row.updatedAt)}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* 右：查看 / 编辑 */}
        <div className="ref-main">
          {editing ? (
            <section className="panel">
              <h2>{selectedId ? '编辑内推' : '新增内推'}</h2>
              <form className="ref-form" onSubmit={submit}>
                <label>
                  关联公司
                  <select
                    value={form.companyId}
                    onChange={(e) => setForm({ ...form, companyId: e.target.value })}
                  >
                    <option value="">不关联公司</option>
                    {companyOptions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="ref-form-row">
                  <label>
                    内推人
                    <input
                      value={form.referrer}
                      onChange={(e) => setForm({ ...form, referrer: e.target.value })}
                      placeholder="如：张伟"
                    />
                  </label>
                  <label>
                    身份/部门
                    <input
                      value={form.referrerRole}
                      onChange={(e) => setForm({ ...form, referrerRole: e.target.value })}
                      placeholder="如：后端 / 前同事"
                    />
                  </label>
                </div>
                <label>
                  联系方式
                  <input
                    value={form.contact}
                    onChange={(e) => setForm({ ...form, contact: e.target.value })}
                    placeholder="微信 / 手机 / 邮箱 / 飞书"
                  />
                </label>
                <div className="ref-form-row">
                  <label>
                    岗位
                    <input
                      value={form.position}
                      onChange={(e) => setForm({ ...form, position: e.target.value })}
                      placeholder="如：高级 Java 工程师"
                    />
                  </label>
                  <label>
                    城市
                    <input
                      value={form.city}
                      onChange={(e) => setForm({ ...form, city: e.target.value })}
                      placeholder="如：深圳"
                    />
                  </label>
                </div>
                <div className="ref-form-row">
                  <label>
                    渠道
                    <input
                      value={form.channel}
                      list="ref-channel-options"
                      onChange={(e) => setForm({ ...form, channel: e.target.value })}
                      placeholder="朋友 / 脉脉 / 内推码"
                    />
                    <datalist id="ref-channel-options">
                      {REFERRAL_CHANNELS.map((c) => (
                        <option key={c} value={c} />
                      ))}
                    </datalist>
                  </label>
                  <label>
                    状态
                    <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                      {REFERRAL_STATUSES.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="ref-form-row">
                  <label>
                    薪资
                    <input
                      value={form.salary}
                      onChange={(e) => setForm({ ...form, salary: e.target.value })}
                      placeholder="如：30-45K · 16 薪"
                    />
                  </label>
                  <label>
                    内推码
                    <input
                      value={form.referralCode}
                      onChange={(e) => setForm({ ...form, referralCode: e.target.value })}
                      placeholder="可选"
                    />
                  </label>
                </div>
                <label>
                  岗位链接
                  <input
                    value={form.jobUrl}
                    onChange={(e) => setForm({ ...form, jobUrl: e.target.value })}
                    placeholder="https://…"
                  />
                </label>
                <div className="ref-form-row three">
                  <label>
                    内推日期
                    <input
                      type="date"
                      value={form.appliedAt}
                      onChange={(e) => setForm({ ...form, appliedAt: e.target.value })}
                    />
                  </label>
                  <label>
                    下次跟进
                    <input
                      type="date"
                      value={form.followUpAt}
                      onChange={(e) => setForm({ ...form, followUpAt: e.target.value })}
                    />
                  </label>
                  <label>
                    内推码有效至
                    <input
                      type="date"
                      value={form.validUntil}
                      onChange={(e) => setForm({ ...form, validUntil: e.target.value })}
                    />
                  </label>
                </div>
                <label>
                  备注
                  <textarea
                    rows={4}
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    placeholder="内推流程、需要准备的材料、对方给的答复…"
                  />
                </label>
                <div className="btn-row">
                  <button className="mini primary" type="submit" disabled={busy}>
                    {busy ? '保存中…' : '保存'}
                  </button>
                  <button
                    className="mini"
                    type="button"
                    onClick={() => {
                      setEditing(false);
                      if (selected) setForm(toForm(selected.ref));
                    }}
                  >
                    取消
                  </button>
                  {selectedId && (
                    <button
                      className="mini danger"
                      type="button"
                      onClick={() => {
                        const title = selected ? referralTitle(selected.ref) : '这条内推';
                        if (window.confirm(`确认删除「${title}」？`)) deleteM.mutate(selectedId);
                      }}
                    >
                      删除
                    </button>
                  )}
                </div>
              </form>
            </section>
          ) : selected ? (
            <section className="panel">
              <div className="ref-detail-head">
                <h2>{referralTitle(selected.ref)}</h2>
                <span className={`status-badge tone-${statusMeta(selected.ref.status).tone}`}>
                  {statusMeta(selected.ref.status).label}
                </span>
              </div>
              <div className="kv">
                <span>公司</span>
                <span>
                  {selected.ref.companyId ? (
                    <Link to={`/companies/${selected.ref.companyId}`}>{selected.ref.companyName || '查看公司档案'}</Link>
                  ) : (
                    selected.ref.companyName || '未关联'
                  )}
                </span>
                <span>内推人</span>
                <span>
                  {selected.ref.referrer || '—'}
                  {selected.ref.referrerRole ? `（${selected.ref.referrerRole}）` : ''}
                </span>
                <span>联系方式</span>
                <span>{selected.ref.contact || '—'}</span>
                <span>渠道</span>
                <span>{selected.ref.channel || '—'}</span>
                <span>岗位</span>
                <span>{selected.ref.position || '—'}</span>
                <span>薪资</span>
                <span>{selected.ref.salary || '—'}</span>
                <span>城市</span>
                <span>{selected.ref.city || '—'}</span>
                <span>内推码</span>
                <span>{selected.ref.referralCode || '—'}</span>
                <span>来源</span>
                <span>
                  {selected.ref.source || '手工录入'}
                  {selected.ref.publishedAt ? ` · 原帖 ${selected.ref.publishedAt}` : ''}
                </span>
                <span>内推日期</span>
                <span>{selected.ref.appliedAt || '—'}</span>
                <span>下次跟进</span>
                <span>{selected.ref.followUpAt || '—'}</span>
                <span>更新</span>
                <span>{fmtTime(selected.row.updatedAt)}</span>
              </div>
              {(selected.ref.jobUrl || selected.ref.sourceUrl) && (
                <div className="btn-row">
                  {selected.ref.jobUrl && (
                    <a className="mini" href={selected.ref.jobUrl} target="_blank" rel="noopener noreferrer">
                      打开岗位链接 ↗
                    </a>
                  )}
                  {selected.ref.sourceUrl && (
                    <a className="mini" href={selected.ref.sourceUrl} target="_blank" rel="noopener noreferrer">
                      打开原帖 ↗
                    </a>
                  )}
                </div>
              )}
              {selected.ref.notes && <p className="ref-notes">{selected.ref.notes}</p>}
              <div className="btn-row">
                <button className="mini" onClick={() => startEdit(selected.row, selected.ref)}>
                  编辑
                </button>
              </div>
            </section>
          ) : filtered.length ? (
            <div className="empty">从左侧选择一条内推信息查看详情，或点「新增内推」录入。</div>
          ) : null}
        </div>
      </div>
    </>
  );
}
