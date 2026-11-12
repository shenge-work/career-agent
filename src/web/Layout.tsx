import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type AiStatus } from './api';
import type { CurrentUser } from '../shared/constants';

// 父子分组菜单：父级分组标题（可折叠）+ 子菜单项
const GROUPS: { title: string; items: { to: string; label: string; icon: string }[] }[] = [
  {
    title: '工作区',
    items: [
      { to: '/', label: '总览', icon: '⌂' },
      { to: '/applications', label: '岗位', icon: '◈' },
      { to: '/portfolio', label: '作品集', icon: '▧' },
      { to: '/resumes', label: '简历库', icon: '▤' },
      { to: '/snippets', label: '经历素材', icon: '✦' },
      { to: '/attachments', label: '附件库', icon: '▣' },
      { to: '/conflicts', label: '冲突恢复', icon: '⟲' },
      { to: '/sync', label: '云同步', icon: '⇅' },
      { to: '/companies', label: '公司档案', icon: '▦' },
      { to: '/referrals', label: '内推管理', icon: '⇗' },
      { to: '/tracker', label: '投递管理', icon: '⇄' },
    ],
  },
  {
    title: '智能工具',
    items: [
      { to: '/ai', label: 'AI 试用台', icon: '✦' },
      { to: '/interview', label: 'AI 面试练习', icon: '▣' },
      { to: '/kb', label: '面经库', icon: '◈' },
    ],
  },
];

function initials(email: string) {
  const head = (email || '').trim().charAt(0).toUpperCase();
  return head || '?';
}

export default function Layout({
  user,
  onLogout,
  children,
}: {
  user: CurrentUser;
  onLogout: () => void;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  // 全局 AI 配置状态（P1-5）：脱敏状态只读，用于顶部徽标与「去设置」引导。
  const { data: aiStatus } = useQuery({
    queryKey: ['ai-status'],
    queryFn: () => api<AiStatus>('/ai/status'),
  });
  // 默认展开所有分组
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [accountOpen, setAccountOpen] = useState(false);
  // 侧栏模式：false = 宽文字侧栏（默认），true = 窄图标栏
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('ca.sidebar.collapsed') === '1';
    } catch {
      return false;
    }
  });
  const accountRef = useRef<HTMLDivElement>(null);

  function toggleRail() {
    setRailCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem('ca.sidebar.collapsed', next ? '1' : '0');
      } catch {
        /* 忽略存储失败 */
      }
      return next;
    });
  }

  // 点击外部关闭账户菜单
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) {
        setAccountOpen(false);
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // Escape 关闭账户菜单（可访问性）
  useEffect(() => {
    if (!accountOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setAccountOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [accountOpen]);

  async function logout() {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      onLogout();
    }
  }

  function toggleGroup(title: string) {
    setCollapsed((prev) => ({ ...prev, [title]: !prev[title] }));
  }

  // 所有菜单项平铺，去掉重复的总览（Logo 已经是总览入口）
  const allItems = GROUPS.flatMap((g) => g.items).filter((n) => n.to !== '/');

  const aiLevel = aiStatus?.configuredLevel || (aiStatus?.configured ? 'full' : 'none');
  const aiBadge =
    aiLevel === 'full'
      ? { label: 'AI 已配置', tone: 'tone-green' }
      : aiLevel === 'partial'
        ? { label: 'AI 部分配置', tone: 'tone-amber' }
        : { label: 'AI 未配置', tone: 'tone-gray' };

  return (
    <div className={'shell' + (railCollapsed ? ' rail-collapsed' : '')}>
      {railCollapsed ? (
        /* 窄图标导航栏：只显示图标，悬停显示文字 */
        <nav className="icon-sidebar" aria-label="导航">
          <button
            className="icon-side-toggle"
            onClick={toggleRail}
            data-tip="展开侧栏"
            aria-label="展开侧栏"
            title="展开侧栏"
          >
            <span aria-hidden>»</span>
          </button>

          {/* Logo = 总览入口 */}
          <NavLink to="/" data-tip="总览" aria-label="总览" className={({ isActive }) => 'icon-side-btn' + (isActive ? ' active' : '')}>
            <span className="rail-logo" aria-hidden>◈</span>
          </NavLink>

          <div className="icon-side-divider" />

          {/* 所有菜单项平铺 */}
          {allItems.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              data-tip={n.label}
              aria-label={n.label}
              className={({ isActive }) => 'icon-side-btn' + (isActive ? ' active' : '')}
            >
              <span aria-hidden>{n.icon}</span>
            </NavLink>
          ))}

          <div className="icon-side-spacer" />

          {/* 底部：设置 + 退出 */}
          <NavLink
            to="/account"
            data-tip="账号与设置"
            aria-label="账号与设置"
            className={({ isActive }) => 'icon-side-btn' + (isActive ? ' active' : '')}
          >
            <span aria-hidden>⚙</span>
          </NavLink>
          <button className="icon-side-btn" data-tip="退出登录" aria-label="退出登录" onClick={logout}>
            <span aria-hidden>⎋</span>
          </button>
        </nav>
      ) : (
        /* 宽文字侧栏：分组标题 + 文字菜单，可折叠为窄图标栏 */
        <nav className="sidebar" aria-label="主导航">
          <div className="sidebar-brand">
            <NavLink to="/" aria-label="总览" className="brand-mark" style={{ textDecoration: 'none' }}>◈</NavLink>
            <span className="brand-name">CareerAgent</span>
            <span className="spacer" />
            <button
              className="rail-toggle"
              onClick={toggleRail}
              aria-label="折叠侧栏"
              title="折叠侧栏"
            >
              <span aria-hidden>«</span>
            </button>
          </div>

          <div className="sidebar-menu">
            {GROUPS.map((group) => {
              const isCollapsed = !!collapsed[group.title];
              return (
                <div key={group.title} className="sidebar-group">
                  <button
                    className="sidebar-group-head"
                    onClick={() => toggleGroup(group.title)}
                    aria-expanded={!isCollapsed}
                  >
                    <span>{group.title}</span>
                    <span className={'chev' + (isCollapsed ? ' collapsed' : '')} aria-hidden>▾</span>
                  </button>
                  {!isCollapsed && (
                    <div className="sidebar-group-body">
                      {group.items.map((n) => (
                        <NavLink
                          key={n.to}
                          to={n.to}
                          className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}
                        >
                          <span className="sidebar-icon" aria-hidden>{n.icon}</span>
                          <span>{n.label}</span>
                        </NavLink>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="sidebar-foot">
            <NavLink
              to="/account"
              className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}
            >
              <span className="sidebar-icon" aria-hidden>⚙</span>
              <span>账号与设置</span>
            </NavLink>
            <button className="sidebar-link" onClick={logout} style={{ width: '100%', background: 'transparent', textAlign: 'left' }}>
              <span className="sidebar-icon" aria-hidden>⎋</span>
              <span>退出登录</span>
            </button>
          </div>
        </nav>
      )}

      {/* 内容区 */}
      <main className="content">
        <header className="content-topbar">
          <div className="topbar-ai">
            <span className={`status-badge ${aiBadge.tone}`} title="AI 模型配置状态">
              {aiBadge.label}
            </span>
            {aiLevel !== 'full' && (
              <NavLink to="/account" className="mini" title="前往「账号与设置 → AI 模型」配置">
                去设置
              </NavLink>
            )}
          </div>
          <div className="spacer" />
          <div className="account-menu" ref={accountRef}>
            <button
              className="account-trigger"
              onClick={() => setAccountOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={accountOpen}
            >
              <span className="avatar">{initials(user.email)}</span>
            </button>
            {accountOpen && (
              <div className="account-pop" role="menu" aria-label="账号菜单">
                <div className="account-head">
                  <span className="avatar lg">{initials(user.email)}</span>
                  <div className="account-id">
                    <div className="account-name">{user.email}</div>
                    <div className="account-plan">{user.role === 'admin' ? '管理员' : '成员'}</div>
                  </div>
                </div>
                <div className="account-sep" />
                <button
                  className="account-item"
                  onClick={() => {
                    setAccountOpen(false);
                    navigate('/account');
                  }}
                >
                  <span className="account-item-icon" aria-hidden>
                    ⚙
                  </span>
                  账号与设置
                </button>
                <button
                  className="account-item"
                  onClick={() => {
                    setAccountOpen(false);
                    logout();
                  }}
                >
                  <span className="account-item-icon" aria-hidden>
                    ⎋
                  </span>
                  退出登录
                </button>
              </div>
            )}
          </div>
        </header>
        <div className="content-body">{children}</div>
      </main>
    </div>
  );
}
