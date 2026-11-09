import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import ConfirmModal from '../components/ConfirmModal';
import {
  api,
  del,
  fmtTime,
  post,
  type TrackerItem,
} from '../api';

/** 投递管理列表页：纯列表，点击进入独立详情页。 */
export default function TrackerPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState({ company: '', position: '', platform: 'BOSS直聘' });
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const PAGE_SIZE = 12;

  const { data: records = [], isLoading } = useQuery({
    queryKey: ['tracker'],
    queryFn: () => api<TrackerItem[]>('/tracker'),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['tracker'] });
  const onFail = (e: unknown) => setError((e as Error).message);

  const createM = useMutation({
    mutationFn: () =>
      post<TrackerItem>('/tracker', {
        payload: { company: form.company, position: form.position, platform: form.platform, chat: [] },
      }),
    onSuccess: (row) => {
      setForm({ company: '', position: '', platform: 'BOSS直聘' });
      navigate(`/tracker/${row.id}`);
      invalidate();
    },
    onError: onFail,
  });

  const deleteM = useMutation({
    mutationFn: (id: string) => del(`/tracker/${id}`),
    onSuccess: () => invalidate(),
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
        <p className="muted small">
          投递记录与聊天沟通的统一管理入口。点击进入详情页查看完整聊天记录、投递体检和面试复盘。
        </p>
      </div>
      {error && <div className="alert">{error}</div>}

      {/* 新建投递记录 */}
      <div className="list-create-bar">
        <form className="form-grid" onSubmit={create}>
          <input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} placeholder="公司名称" />
          <input value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} placeholder="岗位" />
          <input value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })} placeholder="平台" />
          <button type="submit" disabled={createM.isPending || !form.company.trim()}>
            新建记录
          </button>
        </form>
      </div>

      {/* 投递记录列表 */}
      {isLoading ? (
        <p className="muted">加载中…</p>
      ) : records.length === 0 ? (
        <div className="empty">还没有投递记录。</div>
      ) : (
        <div className="app-groups">
          <section className="app-group">
            <div className="app-group-title">
              <span className="dot tone-blue" />
              全部记录
              <span className="muted small">（{records.length}）</span>
            </div>
            <div className="app-list">
              {records.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((r) => (
                <div key={r.id} className="app-card">
                  <Link to={`/tracker/${r.id}`} className="app-card-link">
                    <div className="app-card-main">
                      <div className="app-card-title">{r.payload?.company || '未命名公司'}</div>
                      <div className="app-card-meta">
                        <span className="app-card-company">{r.payload?.position || '—'}</span>
                        <span className="app-card-company">{r.payload?.platform || '—'}</span>
                        <span className="app-card-company">聊天 {Array.isArray(r.payload?.chat) ? r.payload.chat.length : 0} 条</span>
                        <span className="app-card-time muted small">
                          {fmtTime(r.updatedAt)}
                        </span>
                      </div>
                    </div>
                  </Link>
                  <div className="app-card-side">
                    <button
                      className="mini danger"
                      aria-label={`删除投递记录 ${r.payload?.company || ''}`}
                      onClick={() => setDeleteTargetId(r.id)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* 分页 */}
            <div className="pagination">
              <button
                className="page-btn"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                ← 上一页
              </button>
              <span className="page-info">
                第 {page} / {Math.ceil(records.length / PAGE_SIZE)} 页
              </span>
              <button
                className="page-btn"
                disabled={page >= Math.ceil(records.length / PAGE_SIZE)}
                onClick={() => setPage((p) => p + 1)}
              >
                下一页 →
              </button>
            </div>
          </section>
        </div>
      )}

      <ConfirmModal
        open={deleteTargetId !== null}
        title="删除投递记录"
        message="确认删除这条投递记录？此操作不可撤销。"
        confirmLabel="删除"
        busy={deleteM.isPending}
        onConfirm={() => {
          if (deleteTargetId) deleteM.mutate(deleteTargetId);
          setDeleteTargetId(null);
        }}
        onCancel={() => setDeleteTargetId(null)}
      />
    </>
  );
}
