import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, del, post, put, fmtTime, type KbAskResult, type KbItem } from '../api';

/**
 * 面经知识库（N12 S2）——「RAG 知识沉淀」的落点。
 *   · 左：条目列表 + 检索；右：查看/编辑 + AI 问答（kb-ask）。
 *   · 检索走本地关键词/全文（/api/kb/search），AI 问答走 /api/agent/kb-ask。
 */
export default function Kb() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  // 编辑表单
  const [form, setForm] = useState({ title: '', category: '', tags: '', content: '' });
  const [editing, setEditing] = useState(false);

  // 问答
  const [question, setQuestion] = useState('');
  const [askResult, setAskResult] = useState<KbAskResult | null>(null);

  const onFail = (e: unknown) => setError((e as Error).message);

  const { data: items = [] } = useQuery({
    queryKey: ['kb'],
    queryFn: () => api<KbItem[]>('/kb'),
  });

  const selected = items.find((i) => i.id === selectedId) ?? null;

  const createM = useMutation({
    mutationFn: () =>
      post<KbItem>('/kb', {
        title: form.title,
        category: form.category || null,
        tags: form.tags.split(/[,，、\s]+/).filter(Boolean),
        content: form.content,
      }),
    onSuccess: (r) => {
      setForm({ title: '', category: '', tags: '', content: '' });
      setEditing(false);
      setError('');
      setNote('已新增面经条目');
      setSelectedId(r.id);
      qc.invalidateQueries({ queryKey: ['kb'] });
    },
    onError: onFail,
  });

  const updateM = useMutation({
    mutationFn: () =>
      put<KbItem>(`/kb/${selectedId}`, {
        title: form.title,
        category: form.category || null,
        tags: form.tags.split(/[,，、\s]+/).filter(Boolean),
        content: form.content,
      }),
    onSuccess: () => {
      setEditing(false);
      setError('');
      setNote('已保存');
      qc.invalidateQueries({ queryKey: ['kb'] });
    },
    onError: onFail,
  });

  const deleteM = useMutation({
    mutationFn: (id: string) => del(`/kb/${id}`),
    onSuccess: () => {
      setSelectedId(null);
      setError('');
      setNote('已删除');
      qc.invalidateQueries({ queryKey: ['kb'] });
    },
    onError: onFail,
  });

  const askM = useMutation({
    mutationFn: (q: string) => post<KbAskResult>('/agent/kb-ask', { question: q }),
    onSuccess: (r) => {
      setAskResult(r);
      setError('');
    },
    onError: onFail,
  });

  function startEdit(item: KbItem) {
    setSelectedId(item.id);
    setForm({
      title: item.title,
      category: item.category || '',
      tags: (item.tags || []).join(', '),
      content: item.content,
    });
    setEditing(true);
    setAskResult(null);
  }

  function startNew() {
    setSelectedId(null);
    setForm({ title: '', category: '', tags: '', content: '' });
    setEditing(true);
    setAskResult(null);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!form.title.trim() || !form.content.trim()) {
      setError('标题与内容均不能为空');
      return;
    }
    if (editing && selectedId) updateM.mutate();
    else createM.mutate();
  }

  function ask(e: FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    askM.mutate(question);
  }

  const filtered = query.trim()
    ? items.filter(
        (i) =>
          i.title.toLowerCase().includes(query.toLowerCase()) ||
          (i.category || '').toLowerCase().includes(query.toLowerCase()) ||
          i.content.toLowerCase().includes(query.toLowerCase())
      )
    : items;

  return (
    <>
      <div className="page-head">
        <h1>面经库</h1>
        <p className="muted small">沉淀面试经验与技巧，供 AI 问答检索引用（本地关键词 + 全文）。</p>
      </div>
      {error && <div className="alert">{error}</div>}
      {note && <div className="hint">{note}</div>}

      <div className="kb-layout">
        {/* 左侧：检索 + 列表 */}
        <div className="kb-list">
          <div className="kb-toolbar">
            <input
              className="kb-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="检索面经…"
            />
            <button className="mini primary" onClick={startNew}>
              新增条目
            </button>
          </div>
          <ul className="list">
            {filtered.map((i) => (
              <li key={i.id} className={selectedId === i.id ? 'selected' : ''} onClick={() => startEdit(i)}>
                <span className="dot" />
                <div className="li-main">
                  <div className="title">
                    {i.title}
                    {i.category && <span className="tag">{i.category}</span>}
                  </div>
                  <div className="muted small">{i.content.slice(0, 60)}…</div>
                </div>
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="muted small">暂无面经条目，点击「新增条目」开始沉淀。</li>
            )}
          </ul>
        </div>

        {/* 右侧：查看/编辑 + 问答 */}
        <div className="kb-main">
          {editing ? (
            <section className="panel">
              <h2>{selectedId ? '编辑条目' : '新增条目'}</h2>
              <form className="form-grid" onSubmit={submit}>
                <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="标题" />
                <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="分类（如 技术面 / 行为面 / 公司面经）" />
                <input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="标签（逗号分隔）" />
                <textarea
                  value={form.content}
                  onChange={(e) => setForm({ ...form, content: e.target.value })}
                  placeholder="面经内容…"
                  rows={10}
                />
                <div className="btn-row">
                  <button className="mini primary" type="submit" disabled={createM.isPending || updateM.isPending}>
                    {createM.isPending || updateM.isPending ? '保存中…' : '保存'}
                  </button>
                  <button className="mini" type="button" onClick={() => { setEditing(false); setAskResult(null); }}>
                    取消
                  </button>
                  {selectedId && (
                    <button className="mini danger" type="button" onClick={() => deleteM.mutate(selectedId)}>
                      删除
                    </button>
                  )}
                </div>
              </form>
            </section>
          ) : selected ? (
            <>
              <section className="panel">
                <div className="btn-row" style={{ justifyContent: 'space-between' }}>
                  <h2>{selected.title}</h2>
                  <button className="mini" onClick={() => startEdit(selected)}>编辑</button>
                </div>
                <div className="kv">
                  <span>分类</span>
                  <span>{selected.category || '—'}</span>
                  <span>更新</span>
                  <span>{fmtTime(selected.updatedAt)}</span>
                </div>
                {selected.tags && selected.tags.length > 0 && (
                  <div className="jd-chips" style={{ marginTop: 8 }}>
                    {selected.tags.map((t) => (
                      <span key={t} className="jd-chip covered">{t}</span>
                    ))}
                  </div>
                )}
                <p className="kb-content">{selected.content}</p>
              </section>
            </>
          ) : (
            <div className="empty">从左侧选择一条面经，或新增一条开始沉淀。</div>
          )}

          {/* 问答区 */}
          <section className="panel">
            <h2>问问面经库</h2>
            <p className="muted small">AI 会优先引用你的面经库回答（未配置 AI 时直接返回命中的原文）。</p>
            <form className="kb-ask" onSubmit={ask}>
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="如：一面被问到「为什么从上家离职」该怎么答？"
              />
              <button className="mini primary" type="submit" disabled={askM.isPending || !question.trim()}>
                {askM.isPending ? '检索中…' : '提问'}
              </button>
            </form>
            {askResult && (
              <div className="kb-answer">
                <div className="kb-answer-meta">
                  {askResult.grounded ? (
                    <span className="status-badge green">已命中知识库 {askResult.hitCount} 条</span>
                  ) : (
                    <span className="status-badge amber">知识库无相关内容</span>
                  )}
                  {askResult.degraded && <span className="muted small">（未配置 AI，返回原文）</span>}
                </div>
                <p className="kb-answer-text">{askResult.answer}</p>
                {askResult.sources.length > 0 && (
                  <div className="muted small">引用：{askResult.sources.join('、')}</div>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
