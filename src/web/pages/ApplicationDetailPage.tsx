import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useNavigate } from 'react-router-dom';
import ConfirmModal from '../components/ConfirmModal';
import {
  api,
  del,
  fmtTime,
  post,
  put,
  type ApplicationEvent,
  type ApplicationItem,
  type CompanyItem,
  type GenPitchResult,
  type InterviewNoteItem,
  type ReviewInterviewResult,
  type ResumeItem,
} from '../api';

const STATUSES: Array<ApplicationItem['status']> = [
  'interested',
  'applied',
  'interviewing',
  'offered',
  'rejected',
  'withdrawn',
];

const STATUS_LABEL: Record<ApplicationItem['status'], string> = {
  interested: '有意向',
  applied: '已投递',
  interviewing: '面试中',
  offered: '已录用',
  rejected: '已拒绝',
  withdrawn: '已撤回',
};

const STATUS_TONE: Record<ApplicationItem['status'], string> = {
  interested: 'tone-gray',
  applied: 'tone-blue',
  interviewing: 'tone-amber',
  offered: 'tone-green',
  rejected: 'tone-red',
  withdrawn: 'tone-gray',
};

type MatchTerm = { term: string; hits: number; jdCount: number };
type MatchResult = {
  stats: { total: number; covered: number; weak: number; missing: number; score: number };
  groups: { covered: MatchTerm[]; weak: MatchTerm[]; missing: MatchTerm[] };
};

function MatchGroup({
  title,
  tone,
  terms,
}: {
  title: string;
  tone: 'covered' | 'weak' | 'missing';
  terms: MatchTerm[];
}) {
  if (!terms.length) return null;
  return (
    <div className="match-group">
      <span className={`match-label ${tone}`}>
        {title}（{terms.length}）
      </span>
      <div className="match-tags">
        {terms.slice(0, 12).map((t, i) => (
          <span
            key={i}
            className={`match-tag ${tone}`}
            title={`简历命中 ${t.hits} 次 · JD 出现 ${t.jdCount} 次`}
          >
            {t.term}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function ApplicationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [pitchError, setPitchError] = useState('');
  const [copied, setCopied] = useState<'greeting' | 'coverLetter' | null>(null);
  const [jdText, setJdText] = useState('');
  const [jdSaved, setJdSaved] = useState(false);
  const [jdEditing, setJdEditing] = useState(false);
  const [match, setMatch] = useState<MatchResult | null>(null);
  const [matchError, setMatchError] = useState('');
  const [derivedId, setDerivedId] = useState<string | null>(null);
  const [deleteAppOpen, setDeleteAppOpen] = useState(false);

  const { data: app, isLoading } = useQuery({
    queryKey: ['application', id],
    queryFn: () => api<ApplicationItem>(`/applications/${id}`),
    enabled: !!id,
  });

  const { data: companies = [] } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<CompanyItem[]>('/companies'),
  });
  const { data: resumes = [] } = useQuery({
    queryKey: ['resumes'],
    queryFn: () => api<ResumeItem[]>('/resumes'),
  });

  const company = app?.companyId ? companies.find((c) => c.id === app.companyId) : null;
  const resume = app?.resumeId ? resumes.find((r) => r.id === app.resumeId) : null;

  // 初始化 JD 文本：必须等 app 异步到达后再回填。
  // （曾用 useState(() => ...) 误当副作用，惰性初始化只在首帧跑一次，app 永远是 undefined，
  //  导致「已录入 JD」的岗位打开详情页却显示「暂无 JD」。）
  useEffect(() => {
    if (!app) return;
    setJdText((app.payload?.jdText as string) || '');
    setJdSaved(true);
    setJdEditing(false);
    // 仅在切换岗位时重置；保存后 app 对象会刷新，但 id 不变，不能覆盖用户正在编辑的内容。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app?.id]);

  const { data: events = [] } = useQuery({
    queryKey: ['application-events', id],
    queryFn: () => api<ApplicationEvent[]>(`/applications/${id}/events`),
    enabled: !!id,
  });

  const targetResumeId = () =>
    app?.resumeId || resumes.find((r) => r.isMaster)?.id || resumes[0]?.id || '';

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['application', id] });
    qc.invalidateQueries({ queryKey: ['applications'] });
  };

  const statusM = useMutation({
    mutationFn: (status: ApplicationItem['status']) =>
      put(`/applications/${id}`, { status }),
    onSuccess: invalidate,
    onError: (e) => setMatchError((e as Error).message),
  });

  const deleteM = useMutation({
    mutationFn: () => del(`/applications/${id}`),
    onSuccess: () => navigate('/applications'),
    onError: (e) => setMatchError((e as Error).message),
  });

  const jdSaveM = useMutation({
    mutationFn: () => put(`/applications/${id}`, { payload: { ...(app?.payload || {}), jdText } }),
    onSuccess: () => {
      setJdSaved(true);
      setJdEditing(false);
      invalidate();
    },
    onError: (e) => setMatchError((e as Error).message),
  });

  const resumeM = useMutation({
    mutationFn: (resumeId: string) => put(`/applications/${id}`, { resumeId: resumeId || undefined }),
    onSuccess: () => invalidate(),
    onError: (e) => setMatchError((e as Error).message),
  });

  const pitchM = useMutation({
    mutationFn: () => post<GenPitchResult>('/agent/gen-pitch', { applicationId: id, jdText: jdText.trim() }),
    onSuccess: () => {
      setPitchError('');
      setCopied(null);
      invalidate();
    },
    onError: (e) => setPitchError((e as Error).message),
  });

  const matchM = useMutation({
    mutationFn: () => {
      const rid = targetResumeId();
      if (!rid) throw new Error('请先在「简历库」创建或关联一份简历');
      if (!jdText.trim()) throw new Error('请先填写岗位 JD');
      return post<MatchResult>('/resumes/' + rid + '/jd-analyze', { jdText: jdText.trim() });
    },
    onSuccess: (r) => {
      setMatch(r);
      setMatchError('');
    },
    onError: (e) => {
      setMatch(null);
      setMatchError((e as Error).message);
    },
  });

  const deriveM = useMutation({
    mutationFn: async () => {
      const rid = targetResumeId();
      if (!rid) throw new Error('请先关联一份简历');
      if (!jdText.trim()) throw new Error('请先填写岗位 JD');
      const tags = company ? [company.name] : [];
      const row = await post<ResumeItem>('/resumes/' + rid + '/jd-derive', {
        jdText: jdText.trim(),
        jobId: id,
        tags,
      });
      await put(`/applications/${id}`, { resumeId: row.id });
      return row;
    },
    onSuccess: (row) => {
      setDerivedId(row.id);
      invalidate();
      qc.invalidateQueries({ queryKey: ['resumes'] });
      setMatchError('');
    },
    onError: (e) => setMatchError((e as Error).message),
  });

  const pitch = app?.payload?.pitch as {
    greeting?: string;
    coverLetter?: string;
    generatedAt?: number;
    model?: string | null;
    degraded?: boolean;
  } | undefined;

  async function copy(text: string, kind: 'greeting' | 'coverLetter') {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* 剪贴板不可用则忽略 */
    }
  }

  if (isLoading || !app) return <p className="muted">加载中…</p>;

  const salary = (app.payload?.salary as string) || '';
  const location = (app.payload?.location as string) || '';
  // 岗位发布时间：招聘页上抓到的原始发布日期（xTool 内推页不展示，故可能为空）。
  const publishDate = (app.payload?.publishDate as string) || '';

  return (
    <div className="detail-page">
      {/* 顶部导航 */}
      <div className="detail-nav">
        <Link to="/applications" className="detail-back">
          ← 返回岗位列表
        </Link>
        <div className="detail-nav-actions">
          <button
            className="mini danger"
            onClick={() => setDeleteAppOpen(true)}
          >
            删除岗位
          </button>
        </div>
      </div>

      {/* 头部信息 */}
      <div className="detail-header">
        <h1 className="detail-title">{app.position}</h1>
        <div className="detail-meta-row">
          <span className={`status-badge ${STATUS_TONE[app.status]}`}>
            {STATUS_LABEL[app.status]}
          </span>
          {company && <span className="meta-chip">{company.name}</span>}
          {salary && <span className="meta-chip salary">{salary}</span>}
          {location && <span className="meta-chip">{location}</span>}
          {publishDate && <span className="meta-chip">发布于 {publishDate}</span>}
        </div>
        <div className="detail-meta-grid">
          <div>
            <span className="muted small">投递时间</span>
            <div>{app.appliedAt ? fmtTime(app.appliedAt) : '—'}</div>
          </div>
          <div>
            <span className="muted small">跟进</span>
            <div>{app.followUpAfterDays != null ? `${app.followUpAfterDays} 天后` : '—'}</div>
          </div>
          <div>
            <span className="muted small">关联简历</span>
            <div>
              <select
                value={app.resumeId || ''}
                onChange={(e) => resumeM.mutate(e.target.value)}
                style={{ maxWidth: 200 }}
              >
                <option value="">— 可选 —</option>
                {resumes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}{r.isMaster ? '（主）' : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <span className="muted small">更新时间</span>
            <div>{fmtTime(app.updatedAt)}</div>
          </div>
        </div>
      </div>

      {/* 推进状态 */}
      <section className="detail-section">
        <h3 className="sub">推进状态</h3>
        <div className="status-actions">
          {STATUSES.map((s) => (
            <button
              key={s}
              className={`mini ${app.status === s ? 'primary' : ''}`}
              disabled={statusM.isPending || app.status === s}
              onClick={() => statusM.mutate(s)}
            >
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>
      </section>

      {/* 两栏布局：JD + 话术 / 匹配 + 派生 */}
      <div className="detail-cols">
        <section className="detail-section">
          <div className="section-head">
            <h3 className="sub">岗位 JD</h3>
            <div className="btn-row">
              {jdEditing ? (
                <>
                  <button
                    className="mini primary"
                    disabled={jdSaveM.isPending || !jdText.trim()}
                    onClick={() => jdSaveM.mutate()}
                  >
                    {jdSaveM.isPending ? '保存中…' : '保存'}
                  </button>
                  <button
                    className="mini"
                    onClick={() => {
                      setJdText((app?.payload?.jdText as string) || '');
                      setJdSaved(true);
                      setJdEditing(false);
                    }}
                  >
                    取消
                  </button>
                </>
              ) : (
                <button className="mini" onClick={() => setJdEditing(true)}>
                  {jdText ? '编辑' : '录入 JD'}
                </button>
              )}
            </div>
          </div>

          {jdEditing ? (
            <>
              <textarea
                rows={10}
                value={jdText}
                onChange={(e) => {
                  setJdText(e.target.value);
                  setJdSaved(false);
                }}
                placeholder="粘贴岗位描述（JD）……"
              />
              {!jdSaved && jdText.trim() && <p className="muted small" style={{ marginTop: 4 }}>有未保存的改动</p>}
            </>
          ) : jdText ? (
            <div className="jd-view">{jdText}</div>
          ) : (
            <p className="muted small">暂无 JD，点击右上角「录入 JD」粘贴岗位描述。</p>
          )}
        </section>

        <section className="detail-section">
          <h3 className="sub">投递话术</h3>
          <p className="muted small">
            基于该岗位 JD 与你的简历生成打招呼话术（IM 场景）与求职信（邮件/官网投递），只引用真实经历。
          </p>
          {pitchError && <div className="alert">{pitchError}</div>}
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button
              className="mini primary"
              disabled={pitchM.isPending}
              onClick={() => pitchM.mutate()}
            >
              {pitchM.isPending ? '生成中…' : pitch ? '重新生成' : '生成投递话术'}
            </button>
          </div>

          {pitch ? (
            <div className="pitch-box">
              {pitch.degraded && (
                <p className="muted small">当前为模板话术（未配置 AI 模型）。配置 AI 后可生成更精准的针对性话术。</p>
              )}
              <div className="pitch-field">
                <div className="pitch-field-head">
                  <span className="pitch-label">打招呼话术</span>
                  <button className="mini" onClick={() => copy(pitch.greeting || '', 'greeting')}>
                    {copied === 'greeting' ? '已复制 ✓' : '复制'}
                  </button>
                </div>
                <p className="pitch-text">{pitch.greeting}</p>
              </div>
              <div className="pitch-field">
                <div className="pitch-field-head">
                  <span className="pitch-label">求职信</span>
                  <button className="mini" onClick={() => copy(pitch.coverLetter || '', 'coverLetter')}>
                    {copied === 'coverLetter' ? '已复制 ✓' : '复制'}
                  </button>
                </div>
                <pre className="pitch-text">{pitch.coverLetter}</pre>
              </div>
              <div className="muted small">
                {pitch.generatedAt ? `生成于 ${fmtTime(pitch.generatedAt)}` : ''}
                {pitch.model ? ` · ${pitch.model}` : ''}
              </div>
            </div>
          ) : (
            <p className="muted small">尚未生成话术，点击上方按钮开始。</p>
          )}
        </section>
      </div>

      {/* 简历匹配 + 派生 */}
      <section className="detail-section">
        <h3 className="sub">简历匹配度</h3>
        <p className="muted small">
          用本岗位 JD 对关联简历做关键词覆盖分析（规则引擎，无需 AI）。绿色=已覆盖，黄色=弱覆盖，灰色=缺失。
        </p>
        {matchError && <div className="alert">{matchError}</div>}
        <div className="btn-row" style={{ marginTop: 8 }}>
          <button className="mini" disabled={matchM.isPending} onClick={() => matchM.mutate()}>
            {matchM.isPending ? '分析中…' : '分析匹配度'}
          </button>
          <button
            className="mini primary"
            disabled={deriveM.isPending || !jdText.trim()}
            onClick={() => deriveM.mutate()}
          >
            {deriveM.isPending ? '生成中…' : '一键派生定制简历'}
          </button>
        </div>

        {match && (
          <div className="match-box">
            <div className="match-score">
              匹配度 <strong>{Math.round(match.stats.score)}%</strong>
              <span className="muted small">
                （覆盖 {match.stats.covered} · 弱覆盖 {match.stats.weak} · 缺失 {match.stats.missing} / 共 {match.stats.total}）
              </span>
            </div>
            <MatchGroup title="已覆盖" tone="covered" terms={match.groups.covered} />
            <MatchGroup title="弱覆盖" tone="weak" terms={match.groups.weak} />
            <MatchGroup title="缺失" tone="missing" terms={match.groups.missing} />
          </div>
        )}

        {derivedId && (
          <p className="muted small">
            已生成派生简历：
            <Link to={`/editor/${derivedId}`}>打开定制简历 →</Link>
          </p>
        )}
      </section>

      {/* 面试复盘 + 时间线 两栏 */}
      <div className="detail-cols">
        <section className="detail-section">
          <h3 className="sub">面试复盘</h3>
          <InterviewNotes app={app} />
        </section>

        <section className="detail-section">
          <h3 className="sub">求职时间线</h3>
          {events.length ? (
            <ol className="timeline">
              {events.map((ev) => (
                <li key={ev.id}>
                  <span className="timeline-dot" />
                  <div>
                    <div className="title">
                      {ev.fromStatus
                        ? `${STATUS_LABEL[ev.fromStatus as ApplicationItem['status']] || ev.fromStatus} → ${
                            STATUS_LABEL[ev.toStatus as ApplicationItem['status']] || ev.toStatus
                          }`
                        : `开始 → ${STATUS_LABEL[ev.toStatus as ApplicationItem['status']] || ev.toStatus}`}
                    </div>
                    <div className="muted small">{fmtTime(ev.createdAt)}</div>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted small">暂无状态记录。</p>
          )}
        </section>
      </div>

      {app.payload?.note && (
        <section className="detail-section">
          <h3 className="sub">备注</h3>
          <p className="muted small">{app.payload.note}</p>
        </section>
      )}

      <ConfirmModal
        open={deleteAppOpen}
        title="删除岗位"
        message={`确认删除「${app.position}」？此操作不可撤销。`}
        confirmLabel="删除"
        busy={deleteM.isPending}
        onConfirm={() => {
          deleteM.mutate();
          setDeleteAppOpen(false);
        }}
        onCancel={() => setDeleteAppOpen(false)}
      />
    </div>
  );
}

function InterviewNotes({ app }: { app: ApplicationItem }) {
  const qc = useQueryClient();
  const [noteError, setNoteError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ round: '', transcript: '' });
  const [deleteNoteId, setDeleteNoteId] = useState<string | null>(null);

  const { data: notes = [] } = useQuery({
    queryKey: ['interview-notes', app.id],
    queryFn: () => api<InterviewNoteItem[]>(`/interview-notes?applicationId=${encodeURIComponent(app.id)}`),
  });

  const createM = useMutation({
    mutationFn: () =>
      post<InterviewNoteItem>('/interview-notes', {
        applicationId: app.id,
        company: app.payload?.companyName || undefined,
        position: app.position,
        round: form.round || null,
        payload: { transcript: form.transcript },
      }),
    onSuccess: () => {
      setShowForm(false);
      setForm({ round: '', transcript: '' });
      setNoteError('');
      qc.invalidateQueries({ queryKey: ['interview-notes', app.id] });
    },
    onError: (e) => setNoteError((e as Error).message),
  });

  const reviewM = useMutation({
    mutationFn: (noteId: string) => post<ReviewInterviewResult>('/agent/review-interview', { noteId }),
    onSuccess: () => {
      setNoteError('');
      qc.invalidateQueries({ queryKey: ['interview-notes', app.id] });
    },
    onError: (e) => setNoteError((e as Error).message),
  });

  const deleteM = useMutation({
    mutationFn: (noteId: string) => del(`/interview-notes/${noteId}`),
    onSuccess: () => {
      setNoteError('');
      qc.invalidateQueries({ queryKey: ['interview-notes', app.id] });
    },
    onError: (e) => setNoteError((e as Error).message),
  });

  return (
    <div className="interview-box">
      {noteError && <div className="alert">{noteError}</div>}

      {notes.length === 0 && !showForm && (
        <p className="muted small">还没有面试记录。面试后回来记一轮，AI 帮你复盘亮点与改进点。</p>
      )}

      {notes.map((n) => {
        const review = n.payload?.aiReview as
          | { summary?: string; strengths?: string[]; weaknesses?: string[]; suggestions?: string[]; verdict?: string; degraded?: boolean; generatedAt?: number; model?: string | null }
          | undefined;
        const transcript = (n.payload?.transcript as string) || '';
        return (
          <div key={n.id} className="interview-note">
            <div className="interview-note-head">
              <span className="title">
                {n.round ? `${n.round}` : '面试记录'}
                {n.interviewAt ? ` · ${fmtTime(n.interviewAt)}` : ''}
              </span>
              <span className="btn-row">
                <button
                  className="mini primary"
                  disabled={reviewM.isPending || !transcript.trim()}
                  onClick={() => reviewM.mutate(n.id)}
                >
                  {reviewM.isPending ? '复盘生成中…' : review ? '重新复盘' : 'AI 复盘'}
                </button>
                <button
                  className="mini danger"
                  onClick={() => setDeleteNoteId(n.id)}
                >
                  删除
                </button>
              </span>
            </div>

            {transcript && <p className="interview-transcript">{transcript}</p>}

            {review && (
              <div className="review-box">
                {review.degraded && (
                  <p className="muted small">当前为模板复盘（未配置 AI 模型）。</p>
                )}
                <p className="review-summary">{review.summary}</p>
                {review.strengths && review.strengths.length > 0 && (
                  <div className="review-group">
                    <span className="review-label">亮点</span>
                    <ul>{review.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
                  </div>
                )}
                {review.weaknesses && review.weaknesses.length > 0 && (
                  <div className="review-group">
                    <span className="review-label">待改进</span>
                    <ul>{review.weaknesses.map((s, i) => <li key={i}>{s}</li>)}</ul>
                  </div>
                )}
                {review.suggestions && review.suggestions.length > 0 && (
                  <div className="review-group">
                    <span className="review-label">建议</span>
                    <ul>{review.suggestions.map((s, i) => <li key={i}>{s}</li>)}</ul>
                  </div>
                )}
                {review.verdict && <p className="review-verdict">{review.verdict}</p>}
                <div className="muted small">
                  {review.generatedAt ? `生成于 ${fmtTime(review.generatedAt)}` : ''}
                  {review.model ? ` · ${review.model}` : ''}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {showForm ? (
        <div className="interview-form">
          <input
            value={form.round}
            onChange={(e) => setForm({ ...form, round: e.target.value })}
            placeholder="轮次（如：一面 / 二面 / HR 面）"
          />
          <textarea
            value={form.transcript}
            onChange={(e) => setForm({ ...form, transcript: e.target.value })}
            placeholder="记录：问了什么问题、自己怎么答的、哪里卡壳、主观感受…"
            rows={5}
          />
          <div className="btn-row">
            <button className="mini primary" disabled={createM.isPending || !form.transcript.trim()} onClick={() => createM.mutate()}>
              {createM.isPending ? '保存中…' : '保存记录'}
            </button>
            <button className="mini" onClick={() => setShowForm(false)}>取消</button>
          </div>
        </div>
      ) : (
        <div className="btn-row" style={{ marginTop: 8 }}>
          <button className="mini" onClick={() => setShowForm(true)}>+ 记一轮面试</button>
        </div>
      )}

      <ConfirmModal
        open={deleteNoteId !== null}
        title="删除面试记录"
        message="确认删除这条面试记录？此操作不可撤销。"
        confirmLabel="删除"
        busy={deleteM.isPending}
        onConfirm={() => {
          if (deleteNoteId) deleteM.mutate(deleteNoteId);
          setDeleteNoteId(null);
        }}
        onCancel={() => setDeleteNoteId(null)}
      />
    </div>
  );
}
