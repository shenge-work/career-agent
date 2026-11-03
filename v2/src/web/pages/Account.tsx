import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, post, put, fmtTime, type SettingsResponse, type UserRow } from '../api';
import type { CurrentUser } from '../../shared/constants';
import AiSettings from '../AiSettings';

export default function Account({ user }: { user: CurrentUser }) {
  const qc = useQueryClient();
  const isAdmin = user.role === 'admin';
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
        <p className="muted small">内测账号由管理员统一创建；设置按账号隔离，保存为合并更新。</p>
      </div>
      {error && <div className="alert">{error}</div>}
      {note && <div className="hint">{note}</div>}

      <div className="split">
        <section className="panel">
          <h2>账号列表</h2>
          {!isAdmin ? (
            <p className="muted small">仅管理员可查看与创建账号。</p>
          ) : (
            <>
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
            </>
          )}
        </section>

        <aside className="panel detail">
          <h2>个人设置</h2>
          <p className="muted small">当前账号的 settings（jsonb），PUT 为合并更新。</p>
          <textarea
            className="json-editor mono"
            value={json}
            onChange={(e) => setJson(e.target.value)}
            spellCheck={false}
            rows={14}
          />
          <div className="btn-row">
            <button className="mini" onClick={saveSettings} disabled={settingsM.isPending}>
              {settingsM.isPending ? '保存中…' : '保存设置'}
            </button>
          </div>
          <h3 className="sub">当前身份</h3>
          <div className="kv">
            <span>邮箱</span><span>{user.email}</span>
            <span>角色</span><span>{user.role}</span>
            <span>ID</span><span className="mono">{user.id}</span>
          </div>
          <p className="muted small note">
            提示：内测演示账号请及时改密；正式启用前可直接删除 pgdata/ 重建数据库。
          </p>
        </aside>
      </div>

      <div style={{ marginTop: 18 }}>
        <AiSettings />
      </div>
    </>
  );
}
