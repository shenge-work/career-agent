import { useState, type FormEvent, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useNavigate } from 'react-router-dom';
import ConfirmModal from '../components/ConfirmModal';
import {
  api,
  del,
  fmtTime,
  post,
  type CollectResult,
  type CollectStatus,
  type CompanyItem,
  type ResumeItem,
  type TrackerItem,
} from '../api';

/** 投递管理详情页：独立页面，宽度更宽。 */
export default function TrackerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [port, setPort] = useState('');
  const [collectHint, setCollectHint] = useState('');
  const [checkResumeId, setCheckResumeId] = useState('');
  const [checkJd, setCheckJd] = useState('');
  const [checkResult, setCheckResult] = useState<any>(null);
  const [transcript, setTranscript] = useState('');
  const [interviewHint, setInterviewHint] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { data: records = [], isLoading } = useQuery({
    queryKey: ['tracker'],
    queryFn: () => api<TrackerItem[]>('/tracker'),
  });
  const record = records.find((r) => r.id === id);

  const { data: companies = [] } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<CompanyItem[]>('/companies'),
  });
  const { data: collectStatus } = useQuery({
    queryKey: ['collect-status'],
    queryFn: () => api<CollectStatus>('/collect/status'),
  });
  const { data: resumes = [] } = useQuery({
    queryKey: ['resumes'],
    queryFn: () => api<ResumeItem[]>('/resumes'),
  });

  const linked = record?.companyId ? companies.find((c) => c.id === record.companyId) : null;
  const chat: any[] = Array.isArray(record?.payload?.chat) ? record.payload.chat : [];

  // 回填逐字稿
  useEffect(() => {
    setTranscript(record?.payload?.interview?.transcript || '');
    setInterviewHint('');
  }, [record?.id]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['tracker'] });
  const onFail = (e: unknown) => setError((e as Error).message);

  const checkM = useMutation({
    mutationFn: () => post<any>(`/resumes/${checkResumeId}/jd-analyze`, { jdText: checkJd }),
    onSuccess: (r) => setCheckResult(r),
    onError: onFail,
  });

  const saveTranscriptM = useMutation({
    mutationFn: (r: TrackerItem) => {
      const payload = { ...(r.payload || {}), interview: { transcript } };
      return api(`/tracker/${r.id}`, { method: 'PUT', body: JSON.stringify({ payload }) });
    },
    onSuccess: () => invalidate(),
    onError: onFail,
  });

  const analyzeInterviewM = useMutation({
    mutationFn: () => post<any>(`/tracker/${record?.id}/interview-analyze`, { transcript }),
    onSuccess: (r) => setInterviewHint(r.hint || (r.configured ? '已提交分析' : '未配置')),
    onError: onFail,
  });

  const collectM = useMutation({
    mutationFn: (trackerId: string) =>
      post<CollectResult>('/collect/chat', {
        trackerId,
        ...(port.trim() ? { port: Number(port) } : {}),
      }),
    onSuccess: (r) => {
      setCollectHint(r.hint);
      if (r.added > 0) invalidate();
    },
    onError: onFail,
  });

  const deleteM = useMutation({
    mutationFn: (rid: string) => del(`/tracker/${rid}`),
    onSuccess: () => navigate('/tracker'),
    onError: onFail,
  });

  if (isLoading) return <p className="muted">加载中…</p>;
  if (!record) return <p className="muted">未找到投递记录。</p>;

  return (
    <div className="detail-page">
      {/* 顶部导航 */}
      <div className="detail-nav">
        <Link to="/tracker" className="detail-back">
          ← 返回投递管理
        </Link>
        <div className="detail-nav-actions">
          <button
            className="mini danger"
            onClick={() => setDeleteOpen(true)}
          >
            删除记录
          </button>
        </div>
      </div>

      {/* 头部信息 */}
      <div className="detail-header">
        <h1 className="detail-title">{record.payload?.company || '未命名公司'}</h1>
        <div className="detail-meta-row">
          <span className="meta-chip">{record.payload?.position || '—'}</span>
          <span className="meta-chip">{record.payload?.platform || '—'}</span>
          <span className="meta-chip">{record.payload?.status || '未标注'}</span>
          <span className="meta-chip">聊天 {chat.length} 条</span>
        </div>
        <div className="detail-meta-grid">
          <div>
            <span className="muted small">公司</span>
            <div>{record.payload?.company || '—'}</div>
          </div>
          <div>
            <span className="muted small">岗位</span>
            <div>{record.payload?.position || '—'}</div>
          </div>
          <div>
            <span className="muted small">平台</span>
            <div>{record.payload?.platform || '—'}</div>
          </div>
          <div>
            <span className="muted small">更新时间</span>
            <div>{fmtTime(record.updatedAt)}</div>
          </div>
        </div>
      </div>

      {error && <div className="alert">{error}</div>}

      {/* 关联公司背景 */}
      <section className="detail-section">
        <h3 className="sub">关联公司背景</h3>
        {linked ? (
          <div className="brief">
            <strong>{linked.name}</strong>
            <p className="muted small">
              {linked.payload?.industry || '—'} · {linked.payload?.scale || '—'} · {linked.payload?.location || '—'}
            </p>
            <p className="muted small clamp-3">{linked.payload?.note || '无备注'}</p>
          </div>
        ) : (
          <p className="muted small">未关联公司档案（company_id 为空）。</p>
        )}
      </section>

      {/* 两栏：投递体检 + BOSS聊天采集 */}
      <div className="detail-cols">
        <section className="detail-section">
          <h3 className="sub">投递体检（简历 → JD 匹配）</h3>
          <p className="muted small">
            选一份简历 + 目标岗位 JD，分析已覆盖 / 弱覆盖 / 缺失的关键词，判断投递竞争力。
          </p>
          <label>
            简历
            <select
              value={checkResumeId}
              onChange={(e) => setCheckResumeId(e.target.value)}
              style={{ marginTop: 6 }}
            >
              <option value="">— 选择简历 —</option>
              {resumes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}{r.isMaster ? '（主）' : ''}
                </option>
              ))}
            </select>
          </label>
          <textarea
            rows={3}
            value={checkJd}
            onChange={(e) => setCheckJd(e.target.value)}
            placeholder="粘贴目标岗位 JD 原文…"
            style={{ marginTop: 8 }}
          />
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button
              className="mini primary"
              disabled={checkM.isPending || !checkResumeId || !checkJd.trim()}
              onClick={() => {
                setCheckResult(null);
                checkM.mutate();
              }}
            >
              {checkM.isPending ? '分析中…' : '体检'}
            </button>
          </div>
          {checkResult && (
            <div className="jd-report" style={{ marginTop: 12 }}>
              <div className="jd-stats">
                <span><b>{checkResult.stats.score}</b> 分</span>
                <span><b>{checkResult.stats.covered}</b> 已覆盖</span>
                <span><b>{checkResult.stats.weak}</b> 弱覆盖</span>
                <span><b>{checkResult.stats.missing}</b> 缺失</span>
              </div>
              {checkResult.groups.missing.length > 0 && (
                <div className="jd-group">
                  <div className="jd-group-title">缺失（{checkResult.groups.missing.length}）</div>
                  <div className="jd-chips">
                    {checkResult.groups.missing.map((m: any) => (
                      <span key={m.term} className="jd-chip missing">{m.term}</span>
                    ))}
                  </div>
                </div>
              )}
              {checkResult.groups.weak.length > 0 && (
                <div className="jd-group">
                  <div className="jd-group-title">弱覆盖（{checkResult.groups.weak.length}）</div>
                  <div className="jd-chips">
                    {checkResult.groups.weak.map((m: any) => (
                      <span key={m.term} className="jd-chip weak">{m.term}</span>
                    ))}
                  </div>
                </div>
              )}
              {checkResult.groups.covered.length > 0 && (
                <div className="jd-group">
                  <div className="jd-group-title">已覆盖（{checkResult.groups.covered.length}）</div>
                  <div className="jd-chips">
                    {checkResult.groups.covered.map((m: any) => (
                      <span key={m.term} className="jd-chip covered">{m.term}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        <section className="detail-section">
          <h3 className="sub">BOSS 聊天采集</h3>
          <p className="muted small">
            从本机 Chrome 的远程调试端口抽取当前对话，服务端去重后直接写入本条记录。
          </p>
          <label>
            调试端口
            <input
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder={`默认 ${collectStatus?.defaultPort ?? 9222}`}
              inputMode="numeric"
              style={{ marginTop: 6 }}
            />
          </label>
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button
              className="mini"
              onClick={() => {
                setCollectHint('');
                collectM.mutate(record.id);
              }}
              disabled={collectM.isPending || collectStatus?.scriptAvailable === false}
            >
              {collectM.isPending ? '采集中…' : '从 BOSS 采集聊天'}
            </button>
          </div>
          {collectHint && <div className="hint" style={{ margin: '8px 0 0' }}>{collectHint}</div>}
          {!collectHint && collectStatus && (
            <p className="muted small" style={{ margin: '8px 0 0' }}>{collectStatus.hint}</p>
          )}
        </section>
      </div>

      {/* 沟通记录 */}
      <section className="detail-section">
        <h3 className="sub">沟通记录（{chat.length}）</h3>
        {chat.length ? (
          <div className="chat">
            {chat.map((m: any, i: number) =>
              m.role === 'sys' ? (
                <div key={i} className="chat-sys muted small">{m.text}</div>
              ) : (
                <div key={i} className={'chat-row ' + (m.role === 'me' ? 'mine' : '')}>
                  <div className="chat-meta muted small">
                    {m.name || (m.role === 'me' ? '我' : '对方')} · {m.ts ? fmtTime(m.ts) : '—'}
                  </div>
                  <div className="bubble">{m.text}</div>
                </div>
              )
            )}
          </div>
        ) : (
          <p className="muted small">暂无聊天记录。</p>
        )}
      </section>

      {/* 面试逐字稿 */}
      <section className="detail-section">
        <h3 className="sub">面试逐字稿</h3>
        <p className="muted small">
          录入面试对话逐字稿，保存后可用 AI 做结构化复盘（需先在「账号与设置」配置 AI 模型）。
        </p>
        <textarea
          rows={6}
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          placeholder="粘贴面试逐字稿…"
          style={{ marginTop: 8 }}
        />
        <div className="btn-row" style={{ marginTop: 8 }}>
          <button
            className="mini"
            disabled={saveTranscriptM.isPending}
            onClick={() => saveTranscriptM.mutate(record)}
          >
            {saveTranscriptM.isPending ? '保存中…' : '保存逐字稿'}
          </button>
          <button
            className="mini primary"
            disabled={analyzeInterviewM.isPending || !transcript.trim()}
            onClick={() => {
              setInterviewHint('');
              analyzeInterviewM.mutate();
            }}
          >
            {analyzeInterviewM.isPending ? '分析中…' : 'AI 复盘'}
          </button>
        </div>
        {interviewHint && <div className="hint" style={{ margin: '8px 0 0' }}>{interviewHint}</div>}
      </section>

      <ConfirmModal
        open={deleteOpen}
        title="删除投递记录"
        message="确认删除这条投递记录？此操作不可撤销。"
        confirmLabel="删除"
        busy={deleteM.isPending}
        onConfirm={() => {
          deleteM.mutate(record.id);
          setDeleteOpen(false);
        }}
        onCancel={() => setDeleteOpen(false)}
      />
    </div>
  );
}
