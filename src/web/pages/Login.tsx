import { useState, type FormEvent } from 'react';
import { api } from '../api';

/**
 * 登录 / 自助创建账号。
 *
 * 账号一律平等：没有管理员、没有成员管理、没有审批。能访问本机服务即可创建
 * 一个全新的独立账号，它与创建者之间没有隶属或管理关系，数据完全隔离。
 * 创建成功后自动登录到新账号。
 */
export default function Login({ onSuccess }: { onSuccess: () => void }) {
  const [mode, setMode] = useState<'login' | 'create'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dev = (import.meta as any).env?.DEV === true;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'create') {
        await api('/users', {
          method: 'POST',
          body: JSON.stringify({ email, password, displayName: displayName.trim() || null }),
        });
      }
      await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function devSubmit() {
    setError('');
    setBusy(true);
    try {
      await api('/auth/dev-login', { method: 'POST' });
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function switchMode() {
    setMode((m) => (m === 'login' ? 'create' : 'login'));
    setError('');
  }

  return (
    <div className="login-shell">
      {/* 左列 · 登录表单 */}
      <div className="login-left">
        <div className="login-inner">
          <div className="brand">
            <span className="brand-mark" aria-hidden>
              ◈
            </span>
            CareerAgent
          </div>
          <h1 className="login-title">您的求职 Agent 工作台</h1>
          <p className="login-sub">从 JD 到 Offer，一个岗位的完整旅程</p>

          <form className="login-form" onSubmit={submit}>
            <label className="login-label">
              电子邮件
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
              />
            </label>
            <label className="login-label">
              密码
              <input
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="至少 8 位"
                minLength={8}
                required
              />
            </label>
            {mode === 'create' && (
              <label className="login-label">
                显示名（可选）
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="便于在多个账号间区分"
                />
              </label>
            )}

            {error && <div className="alert">{error}</div>}

            <button type="submit" className="login-submit" disabled={busy}>
              {busy
                ? mode === 'create'
                  ? '创建并登录…'
                  : '登录中…'
                : mode === 'create'
                  ? '创建账号并登录'
                  : '登录'}
            </button>

            {mode === 'create' && (
              <p className="muted small" style={{ marginTop: -4 }}>
                新账号拥有完全独立的数据空间与云端同步空间，与其他账号互不干扰。
              </p>
            )}

            <button type="button" className="login-submit login-dev" onClick={switchMode} disabled={busy}>
              {mode === 'login' ? '创建新账号' : '返回登录'}
            </button>

            {dev && mode === 'login' && (
              <button type="button" className="login-submit login-dev" onClick={devSubmit} disabled={busy}>
                开发模式 · 一键登录（免密码）
              </button>
            )}
          </form>

          <p className="login-terms">
            点击「登录」，即表示您同意 <a href="#">服务条款</a> 与 <a href="#">隐私政策</a>
          </p>
        </div>
      </div>

      {/* 右列 · 产品演示卡 */}
      <div className="login-right">
        <div className="demo-card">
          <div className="demo-cap">一份简历，全程陪伴</div>
          <div className="demo-chat">
            <div className="demo-bubble mine">
              帮我定制一份面向高级前端岗位的简历
            </div>
            <div className="demo-bubble ai">
              已根据 JD 匹配生成定制简历，并沉淀了目标公司档案。
            </div>
          </div>
          <div className="demo-table">
            <div className="demo-row demo-row-head">
              <span>岗位</span>
              <span>匹配度</span>
              <span>投递</span>
            </div>
            <div className="demo-row">
              <span>高级前端工程师</span>
              <span className="demo-green">92%</span>
              <span>已投递</span>
            </div>
            <div className="demo-row">
              <span>资深全栈工程师</span>
              <span className="demo-green">87%</span>
              <span>已投递</span>
            </div>
            <div className="demo-row">
              <span>前端技术负责人</span>
              <span className="demo-green">81%</span>
              <span>已投递</span>
            </div>
          </div>
          <div className="demo-pill">300+ 简历版本</div>
        </div>
      </div>
    </div>
  );
}
