import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  del,
  fmtTime,
  post,
  type JdParseResult,
  type ResumeItem,
  type VersionItem,
} from '../api';

function sectionsOf(p: Record<string, any> | null | undefined): any[] {
  if (!p) return [];
  const data = p.data && typeof p.data === 'object' ? p.data : p;
  return Array.isArray(data.sections) ? data.sections : [];
}

/** 简历缩略图：缩小版 iframe 加载真实 A4 预览，空简历显示占位纸张。 */
function Thumb({ resume }: { resume: ResumeItem }) {
  const empty = sectionsOf(resume.payload).length === 0;
  if (empty) {
    return (
      <div className="resume-thumb is-empty" aria-label="空白简历">
        <span className="muted small">空白</span>
      </div>
    );
  }
  return (
    <div className="resume-thumb" aria-label={`${resume.title} 缩略图`}>
      <iframe
        className="resume-thumb-frame"
        title={resume.title}
        loading="lazy"
        src={`/api/resumes/${encodeURIComponent(resume.id)}/preview?v=${resume.savedAt ?? 0}`}
        tabIndex={-1}
      />
    </div>
  );
}

/** 列表项上的「更多」菜单：收纳低频操作（详情 / 设为主 / 删除），减少按钮噪音。 */
function RowMenu({
  resume,
  onMaster,
  onRemove,
  masterPending,
}: {
  resume: ResumeItem;
  onMaster: (id: string) => void;
  onRemove: (r: ResumeItem) => void;
  masterPending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="menu-wrap" ref={ref}>
      <button
        className="icon-btn"
        aria-label="更多操作"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ⋯
      </button>
      {open && (
        <div className="menu-pop" role="menu" onClick={(e) => e.stopPropagation()}>
          {!resume.isMaster && (
            <button
              className="menu-item"
              disabled={masterPending}
              onClick={() => {
                setOpen(false);
                onMaster(resume.id);
              }}
            >
              设为主简历
            </button>
          )}
          <button
            className="menu-item danger"
            onClick={() => {
              setOpen(false);
              onRemove(resume);
            }}
          >
            删除
          </button>
        </div>
      )}
    </div>
  );
}

export default function Library() {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [jdText, setJdText] = useState('');
  const [jdResult, setJdResult] = useState<any>(null);
  const [jdParsed, setJdParsed] = useState<JdParseResult | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'updated' | 'title'>('updated');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 10;

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
    onSuccess: (row) => {
      setTitle('');
      setError('');
      setSelectedId(row.id);
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
      setConfirmId(null);
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

  /** 恢复历史版本：服务端先把当前内容自动存为新版本（可逆），再写回目标快照。 */
  const restoreM = useMutation({
    mutationFn: (versionId: string) =>
      post<{ resumed: ResumeItem; restoredFrom: VersionItem }>(
        `/resumes/${selectedId}/versions/${versionId}/restore`
      ),
    onSuccess: () => {
      setError('');
      qc.invalidateQueries({ queryKey: ['resumes'] });
      qc.invalidateQueries({ queryKey: ['versions', selectedId] });
    },
    onError: onFail,
  });

  const analyzeM = useMutation({
    mutationFn: (t: string) => post<any>(`/resumes/${selectedId}/jd-analyze`, { jdText: t }),
    onSuccess: (r) => setJdResult(r),
    onError: onFail,
  });

  const parseM = useMutation({
    mutationFn: (t: string) =>
      post<JdParseResult>('/agent/parse-jd', { jdText: t, resumeId: selectedId }),
    onSuccess: (r) => setJdParsed(r),
    onError: onFail,
  });

  const deriveM = useMutation({
    mutationFn: () => post<ResumeItem>(`/resumes/${selectedId}/jd-derive`, { jdText: jdText }),
    onSuccess: (row) => {
      setError('');
      setJdResult(null);
      setJdText('');
      setSelectedId(row.id);
      invalidate();
    },
    onError: onFail,
  });

  function create(e: FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (t) createM.mutate(t);
  }

  function remove(r: ResumeItem) {
    if (r.isMaster) {
      setError('这是主简历，删除前请先把其他简历设为主简历。');
      return;
    }
    setConfirmId(r.id);
  }

  function confirmRemove() {
    if (confirmId) deleteM.mutate(confirmId);
  }

  const sorted = useMemo(() => {
    const arr = [...resumes];
    if (sortBy === 'title') {
      arr.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
    } else {
      arr.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
    }
    return arr;
  }, [resumes, sortBy]);

  // 分页
  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const pageData = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <>
      <div className="page-head">
        <h1>简历库</h1>
        <p className="muted small">
          统一管理你的简历与定制版本；点击缩略图打开双栏编辑器，右侧可做 JD 匹配与版本回溯。
        </p>
      </div>

      {error && <div className="alert">{error}</div>}

      <div className="split library-split">
        <section className="panel">
          <div className="list-toolbar">
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
            <div className="list-toolbar-meta">
              <span className="muted small">共 {resumes.length} 份</span>
              <select
                className="sort-select"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as 'updated' | 'title')}
                aria-label="排序方式"
              >
                <option value="updated">最近编辑优先</option>
                <option value="title">按标题排序</option>
              </select>
            </div>
          </div>

          {isLoading ? (
            <p className="muted">加载中…</p>
          ) : sorted.length === 0 ? (
            <div className="empty">还没有简历，先新建一份。</div>
          ) : (
            <>
            <ul className="list">
              {pageData.map((r) => (
                <li
                  key={r.id}
                  className={'lib-row' + (selectedId === r.id ? ' selected' : '')}
                  onClick={() => setSelectedId(r.id)}
                >
                  <Thumb resume={r} />
                  <div className="li-main">
                    <div className="title">
                      {r.title}
                      {r.isMaster && <span className="tag tag-master">主</span>}
                      {r.kind === 'derived' && <span className="tag">定制</span>}
                      {r.kind === 'blank' && <span className="tag">空白</span>}
                    </div>
                    <div className="muted small">
                      {r.kind} · {fmtTime(r.savedAt)}
                      {r.tags?.length ? ` · ${r.tags.join(' / ')}` : ''}
                    </div>
                    <div className="btn-row">
                      <Link
                        className="mini primary"
                        to={`/editor/${r.id}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        打开编辑
                      </Link>
                      <button
                        className="mini"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedId(r.id);
                        }}
                      >
                        详情
                      </button>
                    </div>
                  </div>
                  <RowMenu
                    resume={r}
                    onMaster={(id) => masterM.mutate(id)}
                    onRemove={remove}
                    masterPending={masterM.isPending}
                  />
                </li>
              ))}
            </ul>

            {/* 分页 */}
            {totalPages > 1 && (
              <div className="pagination" style={{ marginTop: 16 }}>
                <button
                  className="page-btn"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  ← 上一页
                </button>
                <span className="page-info">
                  第 {page} / {totalPages} 页
                </span>
                <button
                  className="page-btn"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  下一页 →
                </button>
              </div>
            )}
            </>
          )}
        </section>

        <aside className="panel detail">
          {!selected ? (
            <div className="empty">选择左侧简历查看详情</div>
          ) : (
            <>
              <div className="detail-head">
                <h2>{selected.title}</h2>
                <Link className="mini primary" to={`/editor/${selected.id}`}>
                  打开编辑器 →
                </Link>
              </div>

              <div className="kv">
                <span>ID</span><span className="mono">{selected.id}</span>
                <span>类型</span><span>{selected.kind}</span>
                <span>主简历</span><span>{selected.isMaster ? '是' : '否'}</span>
                <span>标签</span><span>{selected.tags?.join(' / ') || '—'}</span>
                <span>保存时间</span><span>{fmtTime(selected.savedAt)}</span>
                <span>派生自</span><span className="mono">{selected.parentId || '—'}</span>
              </div>

              <section className="detail-section">
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
                    </>
                  );
                })()}
              </section>

              <section className="detail-section">
                <h3 className="sub">JD 匹配与派生</h3>
                <p className="muted small">
                  粘贴目标岗位 JD，分析这份简历覆盖了哪些要求、哪些缺失；可一键生成针对该 JD 的派生简历。
                </p>
                <textarea
                  rows={4}
                  value={jdText}
                  onChange={(e) => setJdText(e.target.value)}
                  placeholder="粘贴岗位 JD 原文…"
                />
                <div className="btn-row" style={{ marginTop: 8 }}>
                  <button className="mini primary" disabled={analyzeM.isPending || !jdText.trim()} onClick={() => analyzeM.mutate(jdText)}>
                    {analyzeM.isPending ? '分析中…' : '分析匹配度'}
                  </button>
                  <button className="mini" disabled={parseM.isPending || !jdText.trim()} onClick={() => parseM.mutate(jdText)}>
                    {parseM.isPending ? 'AI 解析中…' : 'AI 结构化解析'}
                  </button>
                  {jdResult && (
                    <button className="mini" disabled={deriveM.isPending} onClick={() => deriveM.mutate()}>
                      {deriveM.isPending ? '生成中…' : '生成派生简历'}
                    </button>
                  )}
                </div>

                {jdParsed && (
                  <div className="jd-report">
                    <div className="jd-stats">
                      <span><b>{jdParsed.parsed.position}</b></span>
                      {jdParsed.parsed.company && <span className="muted small">{jdParsed.parsed.company}</span>}
                      <span className="muted small">
                        {jdParsed.aiUsed ? `AI 解析${jdParsed.model ? ' · ' + jdParsed.model : ''}` : '规则降级（未配置 AI）'}
                      </span>
                    </div>
                    {jdParsed.parsed.summary && (
                      <p className="muted small">{jdParsed.parsed.summary}</p>
                    )}
                    {jdParsed.parsed.requirements.length > 0 && (
                      <div className="jd-group">
                        <div className="jd-group-title">任职要求（{jdParsed.parsed.requirements.length}）</div>
                        <div className="jd-chips">
                          {jdParsed.parsed.requirements.map((r) => (
                            <span key={r} className="jd-chip">{r}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    {jdParsed.parsed.preferred.length > 0 && (
                      <div className="jd-group">
                        <div className="jd-group-title">加分项（{jdParsed.parsed.preferred.length}）</div>
                        <div className="jd-chips">
                          {jdParsed.parsed.preferred.map((r) => (
                            <span key={r} className="jd-chip weak">{r}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    {jdParsed.parsed.keywords.length > 0 && (
                      <div className="jd-group">
                        <div className="jd-group-title">核心关键词（{jdParsed.parsed.keywords.length}）</div>
                        <div className="jd-chips">
                          {jdParsed.parsed.keywords.map((r) => (
                            <span key={r} className="jd-chip covered">{r}</span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {jdResult && (
                  <div className="jd-report">
                    <div className="jd-stats">
                      <span><b>{jdResult.stats.score}</b> 分</span>
                      <span><b>{jdResult.stats.covered}</b> 已覆盖</span>
                      <span><b>{jdResult.stats.weak}</b> 弱覆盖</span>
                      <span><b>{jdResult.stats.missing}</b> 缺失</span>
                      <span className="muted small">共 {jdResult.stats.total} 个关键词</span>
                    </div>
                    {jdResult.groups.missing.length > 0 && (
                      <div className="jd-group">
                        <div className="jd-group-title">缺失（{jdResult.groups.missing.length}）</div>
                        <div className="jd-chips">
                          {jdResult.groups.missing.map((m: any) => (
                            <span key={m.term} className="jd-chip missing">{m.term}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    {jdResult.groups.weak.length > 0 && (
                      <div className="jd-group">
                        <div className="jd-group-title">弱覆盖（{jdResult.groups.weak.length}）</div>
                        <div className="jd-chips">
                          {jdResult.groups.weak.map((m: any) => (
                            <span key={m.term} className="jd-chip weak">{m.term}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    {jdResult.groups.covered.length > 0 && (
                      <div className="jd-group">
                        <div className="jd-group-title">已覆盖（{jdResult.groups.covered.length}）</div>
                        <div className="jd-chips">
                          {jdResult.groups.covered.map((m: any) => (
                            <span key={m.term} className="jd-chip covered">{m.term}</span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </section>

              <section className="detail-section">
                <h3 className="sub">
                  版本历史 <span className="muted small">（{versions.length}）</span>
                </h3>
                <p className="muted small">
                  编辑自动留痕，手动快照永不清理；恢复前当前内容会先自动备份，恢复本身可逆。
                </p>
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
                      <li key={v.id} className="version-row">
                        <span>
                          {v.label || v.kind}
                          <span className="muted small"> · {fmtTime(v.createdAt)}</span>
                        </span>
                        <button
                          className="mini"
                          disabled={restoreM.isPending}
                          onClick={() => {
                            if (window.confirm('恢复到这个版本？当前内容会先自动存为新版本，不会丢失。')) {
                              restoreM.mutate(v.id);
                            }
                          }}
                        >
                          恢复
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted small">暂无版本，点上方按钮存一份快照。</p>
                )}
              </section>
            </>
          )}
        </aside>
      </div>

      {confirmId && (
        <div className="modal-backdrop" onClick={() => setConfirmId(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h2>删除简历</h2>
            <p className="muted">
              确认删除「{resumes.find((r) => r.id === confirmId)?.title}」？
              该简历的版本历史也会一并删除，此操作不可撤销。
            </p>
            <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="mini" onClick={() => setConfirmId(null)}>取消</button>
              <button className="mini danger" disabled={deleteM.isPending} onClick={confirmRemove}>
                {deleteM.isPending ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
