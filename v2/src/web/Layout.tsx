import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from './api';
import type { CurrentUser } from '../shared/constants';

const NAV = [
  { to: '/resumes', label: '简历库' },
  { to: '/companies', label: '公司档案' },
  { to: '/tracker', label: '投递管理' },
  { to: '/ai', label: 'AI 试用台' },
  { to: '/account', label: '账号与设置' },
];

export default function Layout({
  user,
  onLogout,
  children,
}: {
  user: CurrentUser;
  onLogout: () => void;
  children: ReactNode;
}) {
  async function logout() {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      onLogout();
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">Resume Studio</div>
        <span className="chip">{user.role === 'admin' ? '管理员' : '成员'}</span>
        <span className="muted small">{user.email}</span>
        <div className="spacer" />
        <span className="muted small">本地内测 · 数据按账号隔离</span>
        <button className="ghost" onClick={logout}>
          退出登录
        </button>
      </header>

      <div className="workbench">
        <nav className="rail">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) => 'rail-link' + (isActive ? ' active' : '')}
            >
              {n.label}
            </NavLink>
          ))}
          <div className="rail-foot muted small">
            P4b · 渲染 / 双栏编辑 / 双版 PDF
            <br />
            P2b · AI 转发 / 聊天采集
          </div>
        </nav>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
