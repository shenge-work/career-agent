import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  del,
  fmtTime,
  post,
  type ResumeItem,
  type VersionItem,
} from '../api';

function sectionsOf(p: Record<string, any> | null | undefined): any[] {
  if (!p) return [];
  const data = p.data && typeof p.data === 'object' ? p.data : p;
  return Array.isArray(data.sections) ? data.sections : [];
}

export default function Library() {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const { data: resumes = [], isLoading } = useQuery({
    queryKey: ['resumes'],
    queryFn: () => api<ResumeItem[]>('/resumes'),
  });
  const selected = resumes.find((r) => r.id === selectedId) || null;

  const invalidate = () => qc.invalidateQueries({ queryKey: ['resumes'] });
  const onFail = (e: unknown) => setError((e as Error).message);

  const createM = useMutation({
    mutationFn: (t: string) =>
      post<ResumeItem>('/resumes', { title: t, payload: { data: { sections: [] } } }),
    onSuccess: () => {
      setTitle('');
      setError('');
      invalidate();
    },
    onError: onFail,
  });

  const masterM = useMutation({
    mutationFn: (id: string) => post<ResumeItem>(`/resumes/${id}/master`),
    onSuccess: invalidate,
    onError: onFail,
  });

  const deleteM = useMutation({
    mutationFn: (id: string) => del(`/resumes/${id}`),
    onSuccess: () => {
      setSelectedId(null);
      setError('');
      invalidate();
    },
    onError: onFail,
  });

  const { data: versions = [], isLoading: versionsLoading } = useQuery({
    queryKey: ['versions', selectedId],
    queryFn: () => api<VersionItem[]>(`/resumes/${selectedId}/versions`),
    enabled: !!selectedId,
  });

  const addVersionM = useMutation({
    mutationFn: () =>
      post<VersionItem>(`/resumes/${selectedId}/versions`, {
        kind: 'manual',
        label: '手动快照',
        snapshot: selected?.payload ?? {},
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['versions', selectedId] }),
    onError: onFail,
  });

  function create(e: FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (t) createM.mutate(t);
  }

  function remove(r: ResumeItem) {
    if (window.confirm(`确认删除「${r.title}」？该简历的版本历史也会一并删除。`)) {
      deleteM.mutate(r.id);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>简历库</h1>
        <p className="muted small">
          迁移自 v1 的简历原样保留载荷（data / fonts / spacing / v / savedAt）。点击查看详情与版本历史。
        </p>
      </div>

      {error && <div className="alert">{error}</div>}

      <div className="split">
        <section className="panel">
          <form className="row" onSubmit={create}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="新建简历标题，例如「Agent 岗位简历」"
            />
            <button type="submit" disabled={createM.isPending || !title.trim()}>
              {createM.isPending ? '创建中…' : '新建'}
            </button>
          </form>

          {isLoading ? (
            <p className="muted">加载中…</p>
          ) : resumes.length === 0 ? (
            <div className="empty">还没有简历，先新建一份。</div>
          ) : (
            <ul className="list">
              {resumes.map((r) => (
                <li key={r.id} className={selectedId === r.id ? 'selected' : ''}>
                  <span className="dot" />
                  <div className="li-main">
                    <div className="title">
                      {r.title}
                      {r.isMaster && <span className="tag">主</span>}
                      {r.kind === 'derived' && <span className="tag">定制</span>}
                      {r.kind === 'blank' && <span className="tag">空白</span>}
                    </div>
                    <div className="muted small">
                      {r.kind} · {fmtTime(r.savedAt)}
                      {r.tags?.length ? ` · ${r.tags.join(' / ')}` : ''}
                    </div>
                    <div className="btn-row">
                      <Link className="mini primary" to={`/editor/${r.id}`}>
                        编辑 / 预览 / 导出
                      </Link>
                      <button className="mini" onClick={() => setSelectedId(r.id)}>
                        详情
                      </button>
                      {!r.isMaster && (
                        <button
                          className="mini"
                          disabled={masterM.isPending}
                          onClick={() => masterM.mutate(r.id)}
                        >
                          设为主
                        </button>
                      )}
                      <button className="mini danger" onClick={() => remove(r)}>
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
            <div className="empty">选择左侧简历查看详情</div>
          ) : (
            <>
              <h2>{selected.title}</h2>
              <div className="kv">
                <span>ID</span><span className="mono">{selected.id}</span>
                <span>类型</span><span>{selected.kind}</span>
                <span>主简历</span><span>{selected.isMaster ? '是' : '否'}</span>
                <span>标签</span><span>{selected.tags?.join(' / ') || '—'}</span>
                <span>保存时间</span><span>{fmtTime(selected.savedAt)}</span>
                <span>派生自</span><span className="mono">{selected.parentId || '—'}</span>
              </div>

              <h3 className="sub">内容概览</h3>
              {(() => {
                const p = selected.payload || {};
                const data = p.data && typeof p.data === 'object' ? p.data : p;
                const secs = sectionsOf(p);
                return (
                  <>
                    <p className="muted small">
                      姓名：{data.name || '—'}　头衔：{data.subtitle || '—'}　
                      字号：{p.fonts?.base?.val ?? '—'}　
                      载荷字段：{Object.keys(p).join(' / ') || '空'}
                    </p>
                    {secs.length ? (
                      <ul className="mini-list">
                        {secs.map((s: any, i: number) => (
                          <li key={i}>
                            {s.title || `板块 ${i + 1}`}
                            <span className="muted small"> · {Array.isArray(s.items) ? s.items.length : 0} 条</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted small">无板块内容（空白简历或尚未编辑）</p>
                    )}
                    {selected.jdText && (
                      <>
                        <h3 className="sub">岗位 JD</h3>
                        <p className="clamp muted small">{selected.jdText}</p>
                      </>
                    )}
                  </>
                );
              })()}

              <h3 className="sub">
                版本历史 <span className="muted small">（{versions.length}）</span>
              </h3>
              <button
                className="mini"
                disabled={addVersionM.isPending}
                onClick={() => addVersionM.mutate()}
              >
                {addVersionM.isPending ? '保存中…' : '保存当前快照'}
              </button>
              {versionsLoading ? (
                <p className="muted small">加载中…</p>
              ) : versions.length ? (
                <ul className="mini-list">
                  {versions.map((v) => (
                    <li key={v.id}>
                      {v.label || v.kind}
                      <span className="muted small"> · {fmtTime(v.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">暂无版本，点上方按钮存一份快照。</p>
              )}

              <p className="muted small note">
                点左侧「编辑 / 预览 / 导出」可进入双栏编辑器：左侧是 v1 真实渲染管线输出的 A4 预览，右侧可改内容并导出 PDF。
              </p>
            </>
          )}
        </aside>
      </div>
    </>
  );
}
