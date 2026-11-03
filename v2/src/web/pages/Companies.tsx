import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  del,
  fmtTime,
  post,
  put,
  type CompanyItem,
  type JdItem,
} from '../api';

export default function Companies() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [rename, setRename] = useState('');
  const [newJdTitle, setNewJdTitle] = useState('');
  const [error, setError] = useState('');

  const { data: companies = [], isLoading } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<CompanyItem[]>('/companies'),
  });
  const company = companies.find((c) => c.id === selectedId) || companies[0] || null;

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

  const renameM = useMutation({
    mutationFn: (name: string) => put<CompanyItem>(`/companies/${company?.id}`, { name }),
    onSuccess: () => {
      setRename('');
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
    mutationFn: (title: string) =>
      post<JdItem>(`/companies/${company?.id}/jds`, { payload: { title } }),
    onSuccess: () => {
      setNewJdTitle('');
      invalidateJds();
    },
    onError: onFail,
  });

  const deleteJdM = useMutation({
    mutationFn: (jdId: string) => del(`/companies/${company?.id}/jds/${jdId}`),
    onSuccess: invalidateJds,
    onError: onFail,
  });

  function create(e: FormEvent) {
    e.preventDefault();
    if (newName.trim()) createM.mutate(newName.trim());
  }
  function addJd(e: FormEvent) {
    e.preventDefault();
    if (newJdTitle.trim() && company) addJdM.mutate(newJdTitle.trim());
  }

  const p = company?.payload || {};
  const research: any[] = Array.isArray(p.research) ? p.research : [];

  return (
    <>
      <div className="page-head">
        <h1>公司档案</h1>
        <p className="muted small">只沉淀公司本身信息与岗位 JD，不展示投递状态。</p>
      </div>
      {error && <div className="alert">{error}</div>}

      <div className="split">
        <section className="panel">
          <form className="row" onSubmit={create}>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="新建公司名称"
            />
            <button type="submit" disabled={createM.isPending || !newName.trim()}>
              新建
            </button>
          </form>

          {isLoading ? (
            <p className="muted">加载中…</p>
          ) : companies.length === 0 ? (
            <div className="empty">还没有公司档案。</div>
          ) : (
            <ul className="list">
              {companies.map((c) => (
                <li key={c.id} className={company?.id === c.id ? 'selected' : ''}>
                  <span className="dot" />
                  <div className="li-main">
                    <div className="title">{c.name}</div>
                    <div className="muted small">
                      {(c.payload?.industry as string) || '—'} · 调研 {Array.isArray(c.payload?.research) ? c.payload.research.length : 0} 条
                    </div>
                    <div className="btn-row">
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
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="panel detail">
          {!company ? (
            <div className="empty">选择左侧公司查看详情</div>
          ) : (
            <>
              <h2>{company.name}</h2>
              <div className="kv">
                <span>ID</span><span className="mono">{company.id}</span>
                <span>行业</span><span>{p.industry || '—'}</span>
                <span>规模</span><span>{p.scale || '—'}</span>
                <span>地点</span><span>{p.location || '—'}</span>
                <span>官网</span><span>{p.website || '—'}</span>
                <span>更新</span><span>{fmtTime(company.updatedAt)}</span>
              </div>

              <form className="row compact" onSubmit={(e) => { e.preventDefault(); if (rename.trim()) renameM.mutate(rename.trim()); }}>
                <input value={rename} onChange={(e) => setRename(e.target.value)} placeholder="重命名公司" />
                <button className="mini" type="submit" disabled={renameM.isPending || !rename.trim()}>保存</button>
              </form>

              {p.note && (
                <>
                  <h3 className="sub">备注</h3>
                  <p className="muted small clamp-4">{String(p.note)}</p>
                </>
              )}

              <h3 className="sub">调研 <span className="muted small">（{research.length}）</span></h3>
              {research.length ? (
                <ul className="mini-list">
                  {research.map((r: any, i: number) => (
                    <li key={r.id || i}>
                      <strong>{r.dim || '其他'}</strong>
                      <span className="muted small"> · {r.platform || '—'} · {r.date || '—'}</span>
                      <div className="muted small clamp-3">{r.content || ''}</div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">暂无调研条目。</p>
              )}

              <h3 className="sub">岗位 JD <span className="muted small">（{jds.length}）</span></h3>
              <form className="row compact" onSubmit={addJd}>
                <input value={newJdTitle} onChange={(e) => setNewJdTitle(e.target.value)} placeholder="新增岗位名称" />
                <button className="mini" type="submit" disabled={addJdM.isPending || !newJdTitle.trim()}>添加</button>
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
