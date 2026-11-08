import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { api } from './api';
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
  // 默认展开所有分组
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="shell">
      {/* 窄图标导航栏：只显示图标，悬停显示文字 */}
      <nav className="icon-sidebar" aria-label="导航">
        {/* Logo = 总览入口 */}
        <NavLink to="/" data-tip="总览" className={({ isActive }) => 'icon-side-btn' + (isActive ? ' active' : '')}>
          <span className="rail-logo" aria-hidden>◈</span>
        </NavLink>

        <div className="icon-side-divider" />

        {/* 所有菜单项平铺 */}
        {allItems.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            data-tip={n.label}
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
          className={({ isActive }) => 'icon-side-btn' + (isActive ? ' active' : '')}
        >
          <span aria-hidden>⚙</span>
        </NavLink>
        <button className="icon-side-btn" data-tip="退出登录" onClick={logout}>
          <span aria-hidden>⎋</span>
        </button>
      </nav>

      {/* 内容区 */}
      <main className="content">
        <header className="content-topbar">
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
              <div className="account-pop" role="menu">
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
