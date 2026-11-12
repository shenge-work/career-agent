import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, post, put, fmtTime, type SettingsResponse, type UserRow } from '../api';
import type { CurrentUser } from '../../shared/constants';
import { THEMES, switchTheme, themeFromSettings } from '../theme';
import AiSettings from '../AiSettings';
import UsagePanel from './Usage';

type Section = 'account' | 'preferences' | 'members' | 'ai' | 'usage';

const SECTIONS: { key: Section; label: string; icon: string }[] = [
  { key: 'account', label: '账户', icon: '👤' },
  { key: 'preferences', label: '偏好设置', icon: '⚙' },
  { key: 'members', label: '成员管理', icon: '👥' },
  { key: 'ai', label: 'AI 模型', icon: '✦' },
  { key: 'usage', label: '用量统计', icon: '▥' },
];

export default function Account({ user }: { user: CurrentUser }) {
  const qc = useQueryClient();
  const isAdmin = user.role === 'admin';
  const [section, setSection] = useState<Section>('account');
  const [form, setForm] = useState({ email: '', password: '', role: 'member' });
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => api<UserRow[]>('/users'),
    enabled: isAdmin,
  });
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<SettingsResponse>('/settings'),
  });

  const [json, setJson] = useState('{}');
  useEffect(() => {
    if (settings) setJson(JSON.stringify(settings.payload ?? {}, null, 2));
  }, [settings]);

  const onFail = (e: unknown) => setError((e as Error).message);

  const createM = useMutation({
    mutationFn: () => post<UserRow>('/users', form),
    onSuccess: () => {
      setForm({ email: '', password: '', role: 'member' });
      setError('');
      setNote('账号已创建');
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: onFail,
  });

  const disableM = useMutation({
    mutationFn: (id: string) => post(`/users/${id}/disable`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
    onError: onFail,
  });

  const settingsM = useMutation({
    mutationFn: (patch: Record<string, unknown>) => put<SettingsResponse>('/settings', patch),
    onSuccess: () => {
      setError('');
      setNote('设置已保存');
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: onFail,
  });

  function create(e: FormEvent) {
    e.preventDefault();
    if (form.email.trim() && form.password) createM.mutate();
  }

  function saveSettings() {
    try {
      const patch = JSON.parse(json);
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error();
      settingsM.mutate(patch);
    } catch {
      setError('设置内容不是合法的 JSON 对象');
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>账号与设置</h1>
        <p className="muted small">管理你的账户身份、偏好与应用配置。</p>
      </div>
      {error && <div className="alert">{error}</div>}
      {note && <div className="hint">{note}</div>}

      <div className="settings-layout">
        {/* 左侧二级导航 */}
        <nav className="settings-nav" aria-label="设置导航">
          {SECTIONS.filter((s) => s.key !== 'members' || isAdmin).map((s) => (
            <button
              key={s.key}
              className={'settings-nav-item' + (section === s.key ? ' active' : '')}
              onClick={() => setSection(s.key)}
            >
              <span className="settings-nav-icon" aria-hidden>
                {s.icon}
              </span>
              {s.label}
            </button>
          ))}
        </nav>

        {/* 右侧内容区 */}
        <div className="settings-content">
          {section === 'account' && (
            <section className="panel">
              <h2>账户信息</h2>
              <div className="account-profile">
                <span className="avatar lg">{user.email.trim().charAt(0).toUpperCase()}</span>
                <div className="account-id">
                  <div className="account-name">{user.email}</div>
                  <div className="account-plan">{user.role === 'admin' ? '管理员' : '成员'}</div>
                </div>
              </div>
              <div className="kv">
                <span>邮箱</span>
                <span>{user.email}</span>
                <span>角色</span>
                <span>{user.role === 'admin' ? '管理员' : '成员'}</span>
                <span>账号 ID</span>
                <span className="mono">{user.id}</span>
              </div>
            </section>
          )}

          {section === 'preferences' && (
            <>
              <section className="panel">
                <h2>界面主题</h2>
                <p className="muted small">选择应用界面的配色主题，选择后立即生效并保存到你的账号。</p>
                <div className="theme-grid">
                  {THEMES.map((t) => {
                    const active = themeFromSettings(settings?.payload) === t.id;
                    return (
                      <button
                        key={t.id}
                        className={'theme-card' + (active ? ' active' : '')}
                        onClick={() => {
                          switchTheme(t.id);
                          settingsM.mutate({ theme: t.id });
                        }}
                      >
                        <span className={'theme-swatch' + (t.light ? ' light' : '')} aria-hidden>
                          <span className="theme-swatch-bar" />
                          <span className="theme-swatch-bar" />
                        </span>
                        <span className="theme-card-name">{t.name}</span>
                        <span className="theme-card-desc">{t.desc}</span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="panel">
                <h2>偏好设置</h2>
                <p className="muted small">当前账号的 settings（jsonb），保存为合并更新。</p>
                <textarea
                  className="json-editor mono"
                  value={json}
                  onChange={(e) => setJson(e.target.value)}
                  spellCheck={false}
                  rows={12}
                />
                <div className="btn-row">
                  <button className="mini" onClick={saveSettings} disabled={settingsM.isPending}>
                    {settingsM.isPending ? '保存中…' : '保存设置'}
                  </button>
                </div>
              </section>
            </>
          )}

          {section === 'members' && isAdmin && (
            <section className="panel">
              <h2>成员管理</h2>
              <p className="muted small">内测账号由管理员统一创建。</p>
              <form className="form-grid" onSubmit={create}>
                <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="邮箱" />
                <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="密码（至少 8 位）" />
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  <option value="member">成员</option>
                  <option value="admin">管理员</option>
                </select>
                <button type="submit" disabled={createM.isPending || !form.email.trim() || !form.password}>
                  创建账号
                </button>
              </form>
              <ul className="list">
                {users.map((u) => (
                  <li key={u.id}>
                    <span className="dot" />
                    <div className="li-main">
                      <div className="title">
                        {u.email}
                        <span className="tag">{u.role === 'admin' ? '管理员' : '成员'}</span>
                        {u.status === 'disabled' && <span className="tag">已停用</span>}
                      </div>
                      <div className="muted small">
                        {u.displayName || '—'} · 创建 {fmtTime(u.createdAt)} · 最近登录 {fmtTime(u.lastLoginAt)}
                      </div>
                      {u.id !== user.id && u.status === 'active' && (
                        <div className="btn-row">
                          <button className="mini danger" onClick={() => disableM.mutate(u.id)}>停用</button>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {section === 'ai' && <AiSettings />}

          {section === 'usage' && <UsagePanel />}
        </div>
      </div>
    </>
  );
}
