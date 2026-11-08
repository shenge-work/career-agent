import { useState, useMemo, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import {
  api,
  del,
  fmtTime,
  post,
  type ApplicationItem,
  type CompanyItem,
} from '../api';

const STATUS_LABEL: Record<ApplicationItem['status'], string> = {
  interested: '有意向',
  applied: '已投递',
  interviewing: '面试中',
  offered: '已录用',
  rejected: '已拒绝',
  withdrawn: '已撤回',
};

const STATUS_TONE: Record<ApplicationItem['status'], string> = {
  interested: 'tone-gray',
  applied: 'tone-blue',
  interviewing: 'tone-amber',
  offered: 'tone-green',
  rejected: 'tone-red',
  withdrawn: 'tone-gray',
};

const PAGE_SIZE = 12;

/** 岗位列表页：卡片网格布局 + 分页。 */
export default function Applications() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState({ position: '', companyId: '' });
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const { data: apps = [], isLoading } = useQuery({
    queryKey: ['applications'],
    queryFn: () => api<ApplicationItem[]>('/applications'),
  });
  const { data: companies = [] } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<CompanyItem[]>('/companies'),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['applications'] });
  const onFail = (e: unknown) => setError((e as Error).message);

  const createM = useMutation({
    mutationFn: () =>
      post<ApplicationItem>('/applications', {
        position: form.position,
        companyId: form.companyId || undefined,
      }),
    onSuccess: (row) => {
      setForm({ position: '', companyId: '' });
      navigate(`/applications/${row.id}`);
    },
    onError: onFail,
  });

  const deleteM = useMutation({
    mutationFn: (id: string) => del(`/applications/${id}`),
    onSuccess: () => invalidate(),
    onError: onFail,
  });

  function create(e: FormEvent) {
    e.preventDefault();
    if (form.position.trim()) createM.mutate();
  }

  // 筛选 + 分页
  const filtered = useMemo(() => {
    if (statusFilter === 'all') return apps;
    return apps.filter((a) => a.status === statusFilter);
  }, [apps, statusFilter]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageData = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // 状态统计
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: apps.length };
    for (const s of Object.keys(STATUS_LABEL)) {
      counts[s] = apps.filter((a) => a.status === s).length;
    }
    return counts;
  }, [apps]);

  return (
    <>
      <div className="page-head">
        <h1>岗位</h1>
        <p className="muted small">
          一次求职 = 一个岗位：串起 JD、公司、定制简历与投递状态。点击卡片进入详情页。
        </p>
      </div>
      {error && <div className="alert">{error}</div>}

      {/* 新建岗位 */}
      <div className="list-create-bar">
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
      </div>

      {/* 状态筛选标签 */}
      <div className="filter-tabs">
        <button
          className={`filter-tab ${statusFilter === 'all' ? 'active' : ''}`}
          onClick={() => { setStatusFilter('all'); setPage(1); }}
        >
          全部 ({statusCounts.all})
        </button>
        {Object.entries(STATUS_LABEL).map(([key, label]) => (
          <button
            key={key}
            className={`filter-tab ${statusFilter === key ? 'active' : ''}`}
            onClick={() => { setStatusFilter(key); setPage(1); }}
          >
            {label} ({statusCounts[key] || 0})
          </button>
        ))}
      </div>

      {/* 卡片网格 */}
      {isLoading ? (
        <p className="muted">加载中…</p>
      ) : pageData.length === 0 ? (
        <div className="empty">没有岗位。</div>
      ) : (
        <div className="job-grid">
          {pageData.map((a) => {
            const company = a.companyId ? companies.find((c) => c.id === a.companyId) : null;
            const salary = (a.payload?.salary as string) || '';
            return (
              <Link
                key={a.id}
                to={`/applications/${a.id}`}
                className="job-card"
              >
                <div className={`job-card-status status-${a.status}`}>
                  {STATUS_LABEL[a.status]}
                </div>
                <div className="job-card-title">{a.position}</div>
                <div className="job-card-company">{company?.name || '—'}</div>
                <div className="job-card-meta">
                  {salary && <span className="job-card-salary">{salary}</span>}
                  <span className="job-card-time">{fmtTime(a.updatedAt)}</span>
                </div>
                <button
                  className="job-card-delete"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (window.confirm(`确认删除「${a.position}」？`)) deleteM.mutate(a.id);
                  }}
                >
                  ×
                </button>
              </Link>
            );
          })}
        </div>
      )}

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="pagination">
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
  );
}
