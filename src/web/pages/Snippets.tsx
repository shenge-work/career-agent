import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, del, fmtTime, post, put, type SnippetItem } from '../api';
import ConfirmModal from '../components/ConfirmModal';

/** STAR 四要素的展示顺序与标签。 */
const STAR_FIELDS: Array<{ key: 'situation' | 'task' | 'action' | 'result'; label: string }> = [
  { key: 'situation', label: '情境 S' },
  { key: 'task', label: '任务 T' },
  { key: 'action', label: '行动 A' },
  { key: 'result', label: '结果 R' },
];

const CATEGORIES = ['项目', '工作', '成果', '技能', '其它'];

interface FormState {
  title: string;
  category: string;
  tags: string;
  situation: string;
  task: string;
  action: string;
  result: string;
}

const EMPTY_FORM: FormState = {
  title: '',
  category: '项目',
  tags: '',
  situation: '',
  task: '',
  action: '',
  result: '',
};

function toForm(s: SnippetItem): FormState {
  return {
    title: s.title,
    category: s.category || '',
    tags: (s.tags || []).join(', '),
    situation: s.situation || '',
    task: s.task || '',
    action: s.action || '',
    result: s.result || '',
  };
}

/**
 * STAR 经历素材库 —— 跨简历复用的经历片段。
 *
 * 求职者反复投递时，把打磨好的经历按「情境 / 任务 / 行动 / 结果」四要素沉淀下来，
 * 之后投新岗位时一键插入对应简历，而不是每次重写。素材本身与简历解耦，只做积累。
 */
export default function Snippets() {
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['snippets'],
    queryFn: () => api<SnippetItem[]>('/snippets'),
  });

  const list = useMemo(
    () =>
      rows
        .filter((s) => (catFilter ? (s.category || '') === catFilter : true))
        .filter((s) => {
          if (!query.trim()) return true;
          const q = query.trim().toLowerCase();
          const hay = [s.title, s.category || '', (s.tags || []).join(' '), s.result || '', s.action || '']
            .join(' ')
            .toLowerCase();
          return hay.includes(q);
        })
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    [rows, catFilter, query]
  );

  const selected = selectedId ? rows.find((s) => s.id === selectedId) : null;

  const invalidate = () => qc.invalidateQueries({ queryKey: ['snippets'] });
  const onFail = (e: unknown) => {
    setError((e as Error).message);
    setNote('');
  };

  const buildBody = () => ({
    title: form.title.trim(),
    category: form.category.trim() || null,
    tags: form.tags
      .split(/[,，、]/)
      .map((t) => t.trim())
      .filter(Boolean),
    situation: form.situation.trim() || null,
    task: form.task.trim() || null,
    action: form.action.trim() || null,
    result: form.result.trim() || null,
  });

  const createM = useMutation({
    mutationFn: () => post<SnippetItem>('/snippets', buildBody()),
    onSuccess: (row) => {
      invalidate();
      setEditing(false);
      setSelectedId(row.id);
      setForm(toForm(row));
      setError('');
      setNote('已新增素材');
    },
    onError: onFail,
  });

  const updateM = useMutation({
    mutationFn: () => put<SnippetItem>(`/snippets/${selectedId}`, buildBody()),
    onSuccess: (row) => {
      invalidate();
      setEditing(false);
      setSelectedId(row.id);
      setForm(toForm(row));
      setError('');
      setNote('已保存');
    },
    onError: onFail,
  });

  const deleteM = useMutation({
    mutationFn: (id: string) => del(`/snippets/${id}`),
    onSuccess: () => {
      invalidate();
      setSelectedId(null);
      setEditing(false);
      setForm(EMPTY_FORM);
      setError('');
      setNote('已删除素材');
    },
    onError: onFail,
  });

  function startNew() {
    setSelectedId(null);
    setEditing(true);
    setForm(EMPTY_FORM);
    setError('');
    setNote('');
  }

  function startEdit(s: SnippetItem) {
    setSelectedId(s.id);
    setEditing(true);
    setForm(toForm(s));
    setError('');
    setNote('');
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) {
      setError('素材标题不能为空');
      return;
    }
    const anyStar = STAR_FIELDS.some((f) => form[f.key].trim());
    if (!anyStar) {
      setError('STAR 四要素至少填写一项');
      return;
    }
    if (editing && selectedId) updateM.mutate();
    else createM.mutate();
  }

  const busy = createM.isPending || updateM.isPending;

  return (
    <>
      <div className="page-head">
        <h1>STAR 经历素材库</h1>
        <p className="muted small">
          把打磨好的经历按「情境 / 任务 / 行动 / 结果」四要素沉淀下来，投新岗位时一键复用，不再每次重写。
        </p>
      </div>

      {error && <div className="alert">{error}</div>}
      {note && <div className="hint">{note}</div>}

      <div className="btn-row ref-stats">
        <span className="chip">素材 {rows.length}</span>
        <span className="chip">含量化结果 {rows.filter((s) => /\d/.test(s.result || '')).length}</span>
        <span className="chip">四要素齐全 {rows.filter((s) => s.situation && s.task && s.action && s.result).length}</span>
      </div>

      <div className="ref-toolbar">
        <input
          className="ref-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索标题 / 标签 / 行动 / 结果"
        />
        <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
          <option value="">全部分类</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button className="mini primary" onClick={startNew}>
          + 新增素材
        </button>
      </div>

      <div className="ref-layout">
        {/* 左：素材列表 */}
        <div className="ref-list">
          {isLoading ? (
            <p className="muted">加载中…</p>
          ) : list.length === 0 ? (
            <div className="empty">
              {rows.length ? '没有命中筛选的素材。' : '还没有素材，点右上角「新增素材」沉淀第一条经历。'}
            </div>
          ) : (
            list.map((s) => (
              <div
                key={s.id}
                className={'ref-card' + (selectedId === s.id ? ' selected' : '')}
                onClick={() => {
                  setSelectedId(s.id);
                  setEditing(false);
                }}
              >
                <div className="ref-card-head">
                  <strong className="ref-card-title">{s.title}</strong>
                  {s.category && <span className="tag">{s.category}</span>}
                </div>
                {s.tags && s.tags.length > 0 && (
                  <div className="ref-card-meta">
                    {s.tags.map((t) => (
                      <span key={t} className="tag">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                {s.result && <div className="ref-card-meta snippet-result">{s.result}</div>}
                <div className="ref-card-foot">
                  <span className="muted small">更新 {fmtTime(s.updatedAt)}</span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* 右：查看 / 编辑 */}
        <div className="ref-main">
          {editing ? (
            <section className="panel">
              <h2>{selectedId ? '编辑素材' : '新增素材'}</h2>
              <form className="ref-form" onSubmit={submit}>
                <div className="ref-form-row">
                  <label>
                    标题
                    <input
                      value={form.title}
                      onChange={(e) => setForm({ ...form, title: e.target.value })}
                      placeholder="一句话概括，如：高并发网关性能优化"
                    />
                  </label>
                  <label>
                    分类
                    <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label>
                  标签（逗号分隔，用于投递时匹配 JD 关键词）
                  <input
                    value={form.tags}
                    onChange={(e) => setForm({ ...form, tags: e.target.value })}
                    placeholder="如：Java, 高并发, 性能优化"
                  />
                </label>
                {STAR_FIELDS.map((f) => (
                  <label key={f.key}>
                    {f.label}
                    <textarea
                      rows={2}
                      value={form[f.key]}
                      onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                      placeholder={
                        f.key === 'situation'
                          ? '背景 / 场景，如：核心网关 QPS 翻倍后 P99 延迟恶化'
                          : f.key === 'task'
                            ? '你要达成的目标，如：在不加机器前提下把 P99 压回 200ms 内'
                            : f.key === 'action'
                              ? '你做了什么，如：重构连接池 + 引入协程化 IO + 分级缓存'
                              : '量化结果，如：P99 从 480ms 降到 180ms，CPU 降 35%'
                      }
                    />
                  </label>
                ))}
                <div className="btn-row">
                  <button className="mini primary" type="submit" disabled={busy}>
                    {busy ? '保存中…' : '保存'}
                  </button>
                  <button className="mini" type="button" onClick={() => setEditing(false)}>
                    取消
                  </button>
                  {selectedId && (
                    <button className="mini danger" type="button" onClick={() => setDeleteOpen(true)}>
                      删除
                    </button>
                  )}
                </div>
              </form>
            </section>
          ) : selected ? (
            <section className="panel">
              <div className="ref-detail-head">
                <h2>{selected.title}</h2>
                {selected.category && <span className="tag">{selected.category}</span>}
              </div>
              {selected.tags && selected.tags.length > 0 && (
                <div className="btn-row" style={{ marginBottom: 12 }}>
                  {selected.tags.map((t) => (
                    <span key={t} className="tag">
                      {t}
                    </span>
                  ))}
                </div>
              )}
              <div className="snippet-star">
                {STAR_FIELDS.map((f) => (
                  <div key={f.key} className="snippet-star-item">
                    <span className="snippet-star-label">{f.label}</span>
                    <p className={selected[f.key] ? '' : 'muted'}>{selected[f.key] || '—'}</p>
                  </div>
                ))}
              </div>
              <div className="muted small" style={{ marginTop: 12 }}>
                更新 {fmtTime(selected.updatedAt)}
              </div>
              <div className="btn-row" style={{ marginTop: 12 }}>
                <button className="mini" onClick={() => startEdit(selected)}>
                  编辑
                </button>
              </div>
            </section>
          ) : list.length ? (
            <div className="empty">从左侧选择一条素材查看详情，或点「新增素材」录入。</div>
          ) : null}
        </div>
      </div>

      <ConfirmModal
        open={deleteOpen}
        title="删除素材"
        message={`确认删除素材「${selected ? selected.title : '这条素材'}」？此操作不可撤销。`}
        confirmLabel="删除"
        busy={deleteM.isPending}
        onConfirm={() => {
          if (selectedId) deleteM.mutate(selectedId);
          setDeleteOpen(false);
        }}
        onCancel={() => setDeleteOpen(false)}
      />
    </>
  );
}
