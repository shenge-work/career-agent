import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, put, type SettingsResponse } from '../api';
import type { CurrentUser } from '../../shared/constants';
import { THEMES, switchTheme, themeFromSettings } from '../theme';
import AiSettings from '../AiSettings';
import UsagePanel from './Usage';

// 账号一律平等：没有 members（成员管理）；usage 为远程新增的用量统计页。
type Section = 'account' | 'preferences' | 'ai' | 'usage';

const SECTIONS: { key: Section; label: string; icon: string }[] = [
  { key: 'account', label: '账户', icon: '👤' },
  { key: 'preferences', label: '偏好设置', icon: '⚙' },
  { key: 'ai', label: 'AI 模型', icon: '✦' },
  { key: 'usage', label: '用量统计', icon: '▥' },
];

/**
 * 账号与设置：只展示「当前账号自己」的信息与配置。
 * 本产品没有管理员、没有成员管理，设置页刻意不提供任何跨账号视图或管理能力。
 * 需要新增账号请到登录页「创建新账号」，或退出登录后从账号菜单切换。
 */
export default function Account({ user }: { user: CurrentUser }) {
  const qc = useQueryClient();
  const [section, setSection] = useState<Section>('account');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<SettingsResponse>('/settings'),
  });

  const [json, setJson] = useState('{}');
  useEffect(() => {
    if (settings) setJson(JSON.stringify(settings.payload ?? {}, null, 2));
  }, [settings]);

  const settingsM = useMutation({
    mutationFn: (patch: Record<string, unknown>) => put<SettingsResponse>('/settings', patch),
    onSuccess: () => {
      setError('');
      setNote('设置已保存');
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e: unknown) => setError((e as Error).message),
  });

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
        <p className="muted small">管理你的账户身份、偏好与应用配置。每个账号的数据与云端同步空间都完全独立。</p>
      </div>
      {error && <div className="alert">{error}</div>}
      {note && <div className="hint">{note}</div>}

      <div className="settings-layout">
        {/* 左侧二级导航 */}
        <nav className="settings-nav" aria-label="设置导航">
          {SECTIONS.map((s) => (
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
                  <div className="account-name">{user.displayName || user.email}</div>
                  <div className="account-plan">独立账号 · 数据仅本人可见</div>
                </div>
              </div>
              <div className="kv">
                <span>邮箱</span>
                <span>{user.email}</span>
                <span>显示名</span>
                <span>{user.displayName || '—'}</span>
                <span>账号 ID</span>
                <span className="mono">{user.id}</span>
              </div>
              <p className="muted small" style={{ marginTop: 12 }}>
                需要另一个独立的数据空间？退出登录后可在登录页「创建新账号」，
                账号之间互不隶属、数据互不可见、云端同步也各自隔离。
              </p>
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

          {section === 'ai' && <AiSettings />}

          {section === 'usage' && <UsagePanel />}
        </div>
      </div>
    </>
  );
}
