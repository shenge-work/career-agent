import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
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

/** 状态 → 语义色，用于时间线小圆点与卡片标签。 */
const STATUS_TONE: Record<ApplicationItem['status'], string> = {
  interested: 'tone-gray',
  applied: 'tone-blue',
  interviewing: 'tone-amber',
  offered: 'tone-green',
  rejected: 'tone-red',
  withdrawn: 'tone-gray',
};

export default function Applications() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState({ position: '', companyId: '' });
  const [error, setError] = useState('');

  const { data: apps = [], isLoading } = useQuery({
    queryKey: ['applications'],
    queryFn: () => api<ApplicationItem[]>('/applications'),
  });
  const { data: companies = [] } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<CompanyItem[]>('/companies'),
  });
  const { data: resumes = [] } = useQuery({
    queryKey: ['resumes'],
    queryFn: () => api<ResumeItem[]>('/resumes'),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['applications'] });
    qc.invalidateQueries({ queryKey: ['application-events'] });
  };
  const onFail = (e: unknown) => setError((e as Error).message);

  const createM = useMutation({
    mutationFn: () =>
      post<ApplicationItem>('/applications', {
        position: form.position,
        companyId: form.companyId || undefined,
      }),
    onSuccess: (row) => {
      setForm({ position: '', companyId: '' });
      setSelectedId(row.id);
      invalidate();
    },
    onError: onFail,
  });

  const statusM = useMutation({
    mutationFn: (p: { id: string; status: ApplicationItem['status'] }) =>
      put<ApplicationItem>(`/applications/${p.id}`, { status: p.status }),
    onSuccess: () => invalidate(),
    onError: onFail,
  });

  const deleteM = useMutation({
    mutationFn: (id: string) => del(`/applications/${id}`),
    onSuccess: () => {
      setSelectedId(null);
      invalidate();
    },
    onError: onFail,
  });

  function create(e: FormEvent) {
    e.preventDefault();
    if (form.position.trim()) createM.mutate();
  }

  const selected = apps.find((a) => a.id === selectedId) || apps[0] || null;
  const selectedCompany = selected?.companyId
    ? companies.find((c) => c.id === selected.companyId)
    : null;
  const selectedResume = selected?.resumeId
    ? resumes.find((r) => r.id === selected.resumeId)
    : null;

  return (
    <>
      <div className="page-head">
        <h1>岗位</h1>
        <p className="muted small">
          一次求职 = 一个岗位：串起 JD、公司、定制简历与投递状态。从这里发起并跟进每一个机会。
        </p>
      </div>
      {error && <div className="alert">{error}</div>}

      <div className="split">
        <section className="panel">
          <form className="form-grid" onSubmit={create}>
            <input
              value={form.position}
              onChange={(e) => setForm({ ...form, position: e.target.value })}
              placeholder="岗位名（如：高级前端工程师）"
            />
            <select
              value={form.companyId}
              onChange={(e) => setForm({ ...form, companyId: e.target.value })}
            >
              <option value="">— 关联公司（可选）—</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button type="submit" disabled={createM.isPending || !form.position.trim()}>
              新建岗位
            </button>
          </form>

          {isLoading ? (
            <p className="muted">加载中…</p>
          ) : apps.length === 0 ? (
            <div className="empty">还没有岗位。从「新建岗位」开始一次求职。</div>
          ) : (
            <ul className="list">
              {apps.map((a) => (
                <li key={a.id} className={selected?.id === a.id ? 'selected' : ''}>
                  <span className={`dot ${STATUS_TONE[a.status]}`} />
                  <div className="li-main">
                    <div className="title">{a.position}</div>
                    <div className="muted small">
                      {STATUS_LABEL[a.status]}
                      {selectedCompany ? ` · ${selectedCompany.name}` : ''}
                      {a.followUpAfterDays != null ? ` · ${a.followUpAfterDays} 天后跟进` : ''}
                    </div>
                    <div className="btn-row">
                      <button className="mini" onClick={() => setSelectedId(a.id)}>
                        详情
                      </button>
                      <button
                        className="mini danger"
                        onClick={() => {
                          if (window.confirm(`确认删除岗位「${a.position}」？`)) deleteM.mutate(a.id);
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="panel detail">
          {!selected ? (
            <div className="empty">选择左侧岗位查看详情</div>
          ) : (
            <ApplicationDetail
              app={selected}
              company={selectedCompany}
              resume={selectedResume}
              onStatus={(status) => statusM.mutate({ id: selected.id, status })}
              pending={statusM.isPending}
            />
          )}
        </aside>
      </div>
    </>
  );
}

function ApplicationDetail({
  app,
  company,
  resume,
  onStatus,
  pending,
}: {
  app: ApplicationItem;
  company: CompanyItem | null;
  resume: ResumeItem | null;
  onStatus: (s: ApplicationItem['status']) => void;
  pending: boolean;
}) {
  const qc = useQueryClient();
  const [pitchError, setPitchError] = useState('');
  const [copied, setCopied] = useState<'greeting' | 'coverLetter' | null>(null);

  const { data: events = [] } = useQuery({
    queryKey: ['application-events', app.id],
    queryFn: () => api<ApplicationEvent[]>(`/applications/${app.id}/events`),
  });

  const pitchM = useMutation({
    mutationFn: () => post<GenPitchResult>('/agent/gen-pitch', { applicationId: app.id }),
    onSuccess: () => {
      setPitchError('');
      setCopied(null);
      qc.invalidateQueries({ queryKey: ['applications'] });
    },
    onError: (e) => setPitchError((e as Error).message),
  });

  const pitch = app.payload?.pitch as {
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

  return (
    <>
      <h2>{app.position}</h2>
      <div className="kv">
        <span>状态</span>
        <span>
          <span className={`status-badge ${STATUS_TONE[app.status]}`}>
            {STATUS_LABEL[app.status]}
          </span>
        </span>
        <span>公司</span>
        <span>
          {company ? (
            <Link to="/companies">{company.name}</Link>
          ) : (
            '—'
          )}
        </span>
        <span>简历</span>
        <span>
          {resume ? (
            <Link to={`/editor/${resume.id}`}>{resume.title}</Link>
          ) : (
            '—'
          )}
        </span>
        <span>投递时间</span>
        <span>{app.appliedAt ? fmtTime(app.appliedAt) : '—'}</span>
        <span>跟进</span>
        <span>{app.followUpAfterDays != null ? `${app.followUpAfterDays} 天后` : '—'}</span>
        <span>更新</span>
        <span>{fmtTime(app.updatedAt)}</span>
      </div>

      <h3 className="sub">投递话术</h3>
      <p className="muted small">
        基于该岗位 JD 与你的简历生成打招呼话术（IM 场景）与求职信（邮件/官网投递）。
        只引用简历中真实存在的经历。
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

      <h3 className="sub">面试复盘</h3>
      <InterviewNotes app={app} />

      <h3 className="sub">推进状态</h3>
      <div className="status-actions">
        {STATUSES.map((s) => (
          <button
            key={s}
            className={`mini ${app.status === s ? 'primary' : ''}`}
            disabled={pending || app.status === s}
            onClick={() => onStatus(s)}
          >
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>

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

      {app.payload?.note && (
        <>
          <h3 className="sub">备注</h3>
          <p className="muted small">{app.payload.note}</p>
        </>
      )}
    </>
  );
}

/**
 * 面试复盘（N12 S2）：挂在岗位聚合根下。
 *   · 列出该岗位的面试记录（/api/interview-notes?applicationId=）
 *   · 新增一条记录（company/position 自动从岗位带入）
 *   · 对记录做 AI 复盘（/api/agent/review-interview），结果写回 payload.aiReview
 */
function InterviewNotes({ app }: { app: ApplicationItem }) {
  const qc = useQueryClient();
  const [noteError, setNoteError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ round: '', transcript: '' });

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
                  onClick={() => {
                    if (window.confirm('确认删除这条面试记录？')) deleteM.mutate(n.id);
                  }}
                >
                  删除
                </button>
              </span>
            </div>

            {transcript && (
              <p className="interview-transcript">{transcript}</p>
            )}

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
    </div>
  );
}
