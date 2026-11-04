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
      { to: '/companies', label: '公司档案', icon: '▦' },
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

  return (
    <div className="shell">
      {/* 最左图标栏（Lessie icon rail）：只放 logo + 高频全局动作，不与侧栏菜单重复 */}
      <nav className="icon-rail" aria-label="全局操作">
        <NavLink to="/" title="回到首页" className={({ isActive }) => 'rail-icon-btn' + (isActive ? ' active' : '')}>
          <span className="rail-logo" aria-hidden>
            ◈
          </span>
        </NavLink>
        <div className="rail-spacer" />
        <button className="rail-icon-btn" title="退出登录" onClick={logout}>
          ⎋
        </button>
      </nav>

      {/* 主侧栏（Lessie sidebar） */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-name">CareerAgent</span>
          <span className="spacer" />
          <button className="sidebar-tool" title="搜索" aria-label="搜索">
            ⌕
          </button>
        </div>
        <div className="sidebar-menu">
          {/* 新建简历：顶级动作（类比 Lessie「新建对话」） */}
          <button
            className="sidebar-new"
            title="新建简历 ⌘K"
            onClick={() => navigate('/resumes')}
          >
            <span className="sidebar-icon" aria-hidden>
              ⊕
            </span>
            新建简历
            <span className="sidebar-kbd" aria-hidden>
              ⌘K
            </span>
          </button>

          {/* 父子分组菜单 */}
          {GROUPS.map((g) => {
            const isCollapsed = collapsed[g.title];
            return (
              <div className="sidebar-group" key={g.title}>
                <button
                  className="sidebar-group-head"
                  onClick={() => toggleGroup(g.title)}
                  aria-expanded={!isCollapsed}
                >
                  <span>{g.title}</span>
                  <span className={'chev' + (isCollapsed ? ' collapsed' : '')} aria-hidden>
                    ⌄
                  </span>
                </button>
                {!isCollapsed && (
                  <div className="sidebar-group-body">
                    {g.items.map((n) => (
                      <NavLink
                        key={n.to}
                        to={n.to}
                        className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}
                      >
                        <span className="sidebar-icon" aria-hidden>
                          {n.icon}
                        </span>
                        {n.label}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* 底部：账号与设置 + 说明 */}
        <div className="sidebar-foot">
          <NavLink
            to="/account"
            className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}
          >
            <span className="sidebar-icon" aria-hidden>
              ⚙
            </span>
            账号与设置
          </NavLink>
          <div className="muted small">本地内测 · 数据按账号隔离</div>
        </div>
      </aside>

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
