import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  del,
  post,
  put,
  type PortfolioDeployResult,
  type PortfolioItem,
  type PortfolioTemplateMeta,
} from '../api';

/** 作品集内容可编辑字段（结构化，独立维护，不复用简历）。 */
interface ContentForm {
  name: string;
  title: string;
  headline: string;
  bio: string;
  location: string;
  email: string;
  skills: string;
  projects: string;
}

const TEMPLATE_NAME: Record<string, string> = {
  minimal: '极简',
  magazine: '杂志',
  'dark-tech': '深色科技',
};

function parseContent(p: PortfolioItem): ContentForm {
  const c = (p.payload || {}) as Record<string, any>;
  const projects = Array.isArray(c.projects) ? c.projects : [];
  return {
    name: String(c.name ?? ''),
    title: String(c.title ?? ''),
    headline: String(c.headline ?? ''),
    bio: String(c.bio ?? ''),
    location: String(c.location ?? ''),
    email: String(c.email ?? ''),
    skills: Array.isArray(c.skills) ? c.skills.join(', ') : '',
    projects: projects
      .map((p: any) => `${p.name}｜${p.desc}`)
      .join('\n'),
  };
}

/** 把表单还原成作品集 payload 结构。 */
function buildPayload(form: ContentForm): Record<string, any> {
  const skills = form.skills
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const projects = form.projects
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, desc = ''] = line.split('｜');
      return { name: name.trim(), desc: desc.trim() };
    });
  return {
    name: form.name.trim(),
    title: form.title.trim(),
    headline: form.headline.trim(),
    bio: form.bio.trim(),
    location: form.location.trim(),
    email: form.email.trim(),
    skills,
    projects,
  };
}

export default function Portfolio() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState({ title: '', templateId: 'minimal' });
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 10;

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['portfolios'],
    queryFn: () => api<PortfolioItem[]>('/portfolios'),
  });
  const { data: templates = [] } = useQuery({
    queryKey: ['portfolio-templates'],
    queryFn: () => api<PortfolioTemplateMeta[]>('/portfolios/templates'),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['portfolios'] });
  const onFail = (e: unknown) => setError((e as Error).message);

  const createM = useMutation({
    mutationFn: () =>
      post<PortfolioItem>('/portfolios', { title: form.title, templateId: form.templateId }),
    onSuccess: (row) => {
      setForm({ title: '', templateId: 'minimal' });
      setSelectedId(row.id);
      invalidate();
    },
    onError: onFail,
  });

  const deleteM = useMutation({
    mutationFn: (id: string) => del(`/portfolios/${id}`),
    onSuccess: () => {
      setSelectedId(null);
      invalidate();
    },
    onError: onFail,
  });

  function create(e: FormEvent) {
    e.preventDefault();
    if (form.title.trim()) createM.mutate();
  }

  const selected = items.find((p) => p.id === selectedId) || items[0] || null;

  return (
    <>
      <div className="page-head">
        <h1>作品集</h1>
        <p className="muted small">
          个人作品集官网：选模板、改内容、一键生成静态站，并可一键发布到 GitHub Pages（支持任意仓库）。
        </p>
      </div>
      {error && <div className="alert">{error}</div>}

      <div className="split">
        <section className="panel">
          <form className="form-grid" onSubmit={create}>
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="作品集标题（如：我的作品集）"
            />
            <select
              value={form.templateId}
              onChange={(e) => setForm({ ...form, templateId: e.target.value })}
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} — {t.description}
                </option>
              ))}
            </select>
            <button type="submit" disabled={createM.isPending || !form.title.trim()}>
              新建作品集
            </button>
          </form>

          {isLoading ? (
            <p className="muted">加载中…</p>
          ) : items.length === 0 ? (
            <div className="empty">还没有作品集。从「新建作品集」开始。</div>
          ) : (
            <>
              <ul className="list">
                {items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((p) => (
                  <li key={p.id} className={selected?.id === p.id ? 'selected' : ''}>
                    <span className="dot tone-indigo" />
                    <div className="li-main">
                      <div className="title">{p.title}</div>
                      <div className="muted small">
                        {TEMPLATE_NAME[p.templateId] || p.templateId}
                        {p.deploy?.lastUrl ? ' · 已发布' : ''}
                      </div>
                      <div className="btn-row">
                        <button className="mini" onClick={() => setSelectedId(p.id)}>
                          详情
                        </button>
                        <button
                          className="mini danger"
                          onClick={() => {
                            if (window.confirm(`确认删除作品集「${p.title}」？`)) deleteM.mutate(p.id);
                          }}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>

              {/* 分页 */}
              {items.length > PAGE_SIZE && (
                <div className="pagination" style={{ marginTop: 16 }}>
                  <button
                    className="page-btn"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    ← 上一页
                  </button>
                  <span className="page-info">
                    第 {page} / {Math.ceil(items.length / PAGE_SIZE)} 页
                  </span>
                  <button
                    className="page-btn"
                    disabled={page >= Math.ceil(items.length / PAGE_SIZE)}
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
            <div className="empty">选择左侧作品集查看详情</div>
          ) : (
            <PortfolioDetail key={selected.id} p={selected} templates={templates} onFail={onFail} onSaved={invalidate} />
          )}
        </aside>
      </div>
    </>
  );
}

function PortfolioDetail({
  p,
  templates,
  onFail,
  onSaved,
}: {
  p: PortfolioItem;
  templates: PortfolioTemplateMeta[];
  onFail: (e: unknown) => void;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const [content, setContent] = useState<ContentForm>(() => parseContent(p));
  const [templateId, setTemplateId] = useState(p.templateId);
  const [showPreview, setShowPreview] = useState(false);
  const [repo, setRepo] = useState(String((p.deploy as any)?.repo ?? ''));
  const [branch, setBranch] = useState(String((p.deploy as any)?.branch ?? 'main'));
  const [deployMsg, setDeployMsg] = useState('');

  const { data: rendered } = useQuery({
    queryKey: ['portfolio-render', p.id],
    queryFn: () => api<{ html: string }>(`/portfolios/${p.id}/render`),
    enabled: showPreview,
  });

  const saveM = useMutation({
    mutationFn: (body: { title?: string; templateId?: string; payload: Record<string, any> }) =>
      put<PortfolioItem>(`/portfolios/${p.id}`, body),
    onSuccess: () => {
      onSaved();
      setShowPreview(false);
      qc.invalidateQueries({ queryKey: ['portfolio-render', p.id] });
    },
    onError: onFail,
  });

  const templateM = useMutation({
    mutationFn: (id: string) => put<PortfolioItem>(`/portfolios/${p.id}`, { templateId: id }),
    onSuccess: () => {
      onSaved();
      setShowPreview(false);
    },
    onError: onFail,
  });

  const deployM = useMutation({
    mutationFn: (body: { repo: string; branch: string }) =>
      post<PortfolioDeployResult>(`/portfolios/${p.id}/deploy`, body),
    onSuccess: (r) => {
      setDeployMsg(`发布成功 → ${r.url}`);
      onSaved();
    },
    onError: (e) => setDeployMsg(`发布失败：${(e as Error).message}`),
  });

  const set = (k: keyof ContentForm, v: string) => setContent((c) => ({ ...c, [k]: v }));

  const payload = useMemo(() => buildPayload(content), [content]);

  return (
    <>
      <h2>{p.title}</h2>

      <h3 className="sub">换模板</h3>
      <div className="status-actions">
        {templates.map((t) => (
          <button
            key={t.id}
            className={`mini ${templateId === t.id ? 'primary' : ''}`}
            disabled={templateM.isPending || templateId === t.id}
            onClick={() => {
              setTemplateId(t.id);
              templateM.mutate(t.id);
            }}
          >
            {t.name}
          </button>
        ))}
      </div>

      <h3 className="sub">内容</h3>
      <div className="form-grid">
        <label>
          姓名
          <input value={content.name} onChange={(e) => set('name', e.target.value)} placeholder="张三" />
        </label>
        <label>
          岗位头衔
          <input value={content.title} onChange={(e) => set('title', e.target.value)} placeholder="高级前端工程师" />
        </label>
        <label>
          一句话标语（headline）
          <input value={content.headline} onChange={(e) => set('headline', e.target.value)} placeholder="让每一行代码都恰到好处" />
        </label>
        <label>
          所在城市
          <input value={content.location} onChange={(e) => set('location', e.target.value)} placeholder="上海" />
        </label>
        <label>
          邮箱
          <input value={content.email} onChange={(e) => set('email', e.target.value)} placeholder="me@example.com" />
        </label>
        <label>
          技能（逗号分隔）
          <input value={content.skills} onChange={(e) => set('skills', e.target.value)} placeholder="React, TypeScript, Node.js" />
        </label>
        <label>
          个人简介
          <textarea value={content.bio} onChange={(e) => set('bio', e.target.value)} rows={3} placeholder="一段自我介绍" />
        </label>
        <label>
          项目（每行一个：名称｜描述）
          <textarea
            value={content.projects}
            onChange={(e) => set('projects', e.target.value)}
            rows={5}
            placeholder={'项目A｜一个用 React 做的 xxxx\n项目B｜xxxx'}
          />
        </label>
      </div>

      <div className="btn-row">
        <button className="primary" disabled={saveM.isPending} onClick={() => saveM.mutate({ payload })}>
          保存内容
        </button>
        <button disabled={!payload.name} onClick={() => setShowPreview((v) => !v)}>
          {showPreview ? '收起预览' : '预览'}
        </button>
      </div>

      <h3 className="sub">发布到 GitHub Pages</h3>
      <div className="form-grid">
        <label>
          目标仓库（owner/repo 或完整 git 地址）
          <input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="shenge-work/shenge-work.github.io"
          />
        </label>
        <label>
          分支
          <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
        </label>
      </div>
      <div className="btn-row">
        <button
          className="primary"
          disabled={deployM.isPending || !repo.trim() || !payload.name}
          onClick={() => setDeployMsg('') || deployM.mutate({ repo: repo.trim(), branch: branch.trim() || 'main' })}
        >
          {deployM.isPending ? '发布中…' : '一键发布'}
        </button>
      </div>
      {deployMsg && <p className="muted small">{deployMsg}</p>}
      {(p.deploy as any)?.lastUrl && (
        <p className="muted small">
          最近发布：<a href={(p.deploy as any).lastUrl} target="_blank" rel="noopener">{(p.deploy as any).lastUrl}</a>
        </p>
      )}

      {showPreview && (
        <div className="portfolio-preview">
          {rendered ? (
            <iframe title="作品集预览" srcDoc={rendered.html} sandbox="allow-same-origin" />
          ) : (
            <p className="muted small">正在生成预览…</p>
          )}
        </div>
      )}
    </>
  );
}
