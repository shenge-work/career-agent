import { useState, type FormEvent, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

export default function TrackerPage() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState({ company: '', position: '', platform: 'BOSS直聘' });
  const [error, setError] = useState('');
  const [port, setPort] = useState('');
  const [collectHint, setCollectHint] = useState('');
  const [checkResumeId, setCheckResumeId] = useState('');
  const [checkJd, setCheckJd] = useState('');
  const [checkResult, setCheckResult] = useState<any>(null);
  const [transcript, setTranscript] = useState('');
  const [interviewHint, setInterviewHint] = useState('');

  const { data: records = [], isLoading } = useQuery({
    queryKey: ['tracker'],
    queryFn: () => api<TrackerItem[]>('/tracker'),
  });
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

  const invalidate = () => qc.invalidateQueries({ queryKey: ['tracker'] });
  const onFail = (e: unknown) => setError((e as Error).message);

  const checkM = useMutation({
    mutationFn: () => post<any>(`/resumes/${checkResumeId}/jd-analyze`, { jdText: checkJd }),
    onSuccess: (r) => setCheckResult(r),
    onError: onFail,
  });

  // 面试逐字稿：保存到投递记录 payload.interview；分析走 AI 占位端点
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

  const record = records.find((r) => r.id === selectedId) || records[0] || null;
  const linked = record?.companyId ? companies.find((c) => c.id === record.companyId) : null;
  const chat: any[] = Array.isArray(record?.payload?.chat) ? record.payload.chat : [];

  // 选中记录变化时回填逐字稿
  useEffect(() => {
    setTranscript(record?.payload?.interview?.transcript || '');
    setInterviewHint('');
  }, [record?.id]);

  const createM = useMutation({
    mutationFn: () =>
      post<TrackerItem>('/tracker', {
        payload: { company: form.company, position: form.position, platform: form.platform, chat: [] },
      }),
    onSuccess: (row) => {
      setForm({ company: '', position: '', platform: 'BOSS直聘' });
      setSelectedId(row.id);
      invalidate();
    },
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
    mutationFn: (id: string) => del(`/tracker/${id}`),
    onSuccess: () => {
      setSelectedId(null);
      invalidate();
    },
    onError: onFail,
  });

  function create(e: FormEvent) {
    e.preventDefault();
    if (form.company.trim()) createM.mutate();
  }

  return (
    <>
      <div className="page-head">
        <h1>投递管理</h1>
        <p className="muted small">投递记录已迁入数据库，聊天可从 BOSS 采集直接入库；关联公司背景只读展示。</p>
      </div>
      {error && <div className="alert">{error}</div>}

      <div className="split">
        <section className="panel">
          <form className="form-grid" onSubmit={create}>
            <input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} placeholder="公司名称" />
            <input value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} placeholder="岗位" />
            <input value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })} placeholder="平台" />
            <button type="submit" disabled={createM.isPending || !form.company.trim()}>新建记录</button>
          </form>

          {isLoading ? (
            <p className="muted">加载中…</p>
          ) : records.length === 0 ? (
            <div className="empty">还没有投递记录。</div>
          ) : (
            <ul className="list">
              {records.map((r) => (
                <li key={r.id} className={record?.id === r.id ? 'selected' : ''}>
                  <span className="dot" />
                  <div className="li-main">
                    <div className="title">{r.payload?.company || '未命名公司'}</div>
                    <div className="muted small">
                      {r.payload?.position || '—'} · {r.payload?.platform || '—'} · 聊天 {Array.isArray(r.payload?.chat) ? r.payload.chat.length : 0} 条
                    </div>
                    <div className="btn-row">
                      <button className="mini" onClick={() => setSelectedId(r.id)}>详情</button>
                      <button
                        className="mini danger"
                        onClick={() => {
                          if (window.confirm('确认删除这条投递记录？')) deleteM.mutate(r.id);
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
          {!record ? (
            <div className="empty">选择左侧记录查看详情</div>
          ) : (
            <>
              <h2>{record.payload?.company || '未命名公司'}</h2>
              <div className="kv">
                <span>岗位</span><span>{record.payload?.position || '—'}</span>
                <span>平台</span><span>{record.payload?.platform || '—'}</span>
                <span>状态</span><span>{record.payload?.status || '未标注'}</span>
                <span>更新</span><span>{fmtTime(record.updatedAt)}</span>
              </div>

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

              <h3 className="sub">投递体检（简历 → JD 匹配）</h3>
              <p className="muted small">
                选一份简历 + 目标岗位 JD，分析已覆盖 / 弱覆盖 / 缺失的关键词，判断投递竞争力。
              </p>
              <div className="form-grid two">
                <label>
                  简历
                  <select
                    value={checkResumeId}
                    onChange={(e) => setCheckResumeId(e.target.value)}
                  >
                    <option value="">— 选择简历 —</option>
                    {resumes.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.title}{r.isMaster ? '（主）' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="btn-row" style={{ alignItems: 'flex-end' }}>
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
              </div>
              <textarea
                rows={3}
                value={checkJd}
                onChange={(e) => setCheckJd(e.target.value)}
                placeholder="粘贴目标岗位 JD 原文…"
              />
              {checkResult && (
                <div className="jd-report">
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

              <h3 className="sub">BOSS 聊天采集</h3>
              <div className="collect-box">
                <p className="muted small" style={{ margin: '0 0 8px' }}>
                  从本机 Chrome 的远程调试端口抽取当前对话，服务端去重后直接写入本条记录
                  （替代 v1 的截图 → seed.json 通道）。
                </p>
                <div className="form-grid two">
                  <label>
                    调试端口
                    <input
                      value={port}
                      onChange={(e) => setPort(e.target.value)}
                      placeholder={`默认 ${collectStatus?.defaultPort ?? 9222}`}
                      inputMode="numeric"
                    />
                  </label>
                  <div className="btn-row" style={{ alignItems: 'flex-end' }}>
                    <button
                      className="mini"
                      onClick={() => {
                        setCollectHint('');
                        if (record) collectM.mutate(record.id);
                      }}
                      disabled={collectM.isPending || !record || collectStatus?.scriptAvailable === false}
                    >
                      {collectM.isPending ? '采集中…' : '从 BOSS 采集聊天'}
                    </button>
                  </div>
                </div>
                {collectHint && <div className="hint" style={{ margin: 0 }}>{collectHint}</div>}
                {!collectHint && collectStatus && (
                  <p className="muted small" style={{ margin: 0 }}>{collectStatus.hint}</p>
                )}
              </div>

              <h3 className="sub">沟通记录 <span className="muted small">（{chat.length}）</span></h3>
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

              <h3 className="sub">面试逐字稿</h3>
              <p className="muted small">
                录入面试对话逐字稿，保存后可用 AI 做结构化复盘（需先在「账号与设置」配置 AI 模型）。
              </p>
              <textarea
                rows={6}
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                placeholder="粘贴面试逐字稿…"
              />
              <div className="btn-row" style={{ marginTop: 8 }}>
                <button
                  className="mini"
                  disabled={saveTranscriptM.isPending || !record}
                  onClick={() => record && saveTranscriptM.mutate(record)}
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
            </>
          )}
        </aside>
      </div>
    </>
  );
}
