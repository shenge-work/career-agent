import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  del,
  fmtTime,
  post,
  type CollectResult,
  type CollectStatus,
  type CompanyItem,
  type TrackerItem,
} from '../api';

export default function TrackerPage() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState({ company: '', position: '', platform: 'BOSS直聘' });
  const [error, setError] = useState('');
  const [port, setPort] = useState('');
  const [collectHint, setCollectHint] = useState('');

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

  const record = records.find((r) => r.id === selectedId) || records[0] || null;
  const linked = record?.companyId ? companies.find((c) => c.id === record.companyId) : null;
  const chat: any[] = Array.isArray(record?.payload?.chat) ? record!.payload.chat : [];

  const invalidate = () => qc.invalidateQueries({ queryKey: ['tracker'] });
  const onFail = (e: unknown) => setError((e as Error).message);

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
            </>
          )}
        </aside>
      </div>
    </>
  );
}
