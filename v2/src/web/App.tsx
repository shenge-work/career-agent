import { useEffect } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, HttpError, type Me } from './api';
import Layout from './Layout';
import Login from './pages/Login';
import Library from './pages/Library';
import Companies from './pages/Companies';
import TrackerPage from './pages/Tracker';
import Account from './pages/Account';
import AiPlayground from './pages/AiPlayground';
import Editor from './pages/Editor';

export default function App() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['me'],
    queryFn: () => api<Me>('/auth/me'),
  });

  // 任意业务接口返回 401 → 清掉当前账号的缓存并回到登录页
  useEffect(() => {
    const onUnauthorized = () => {
      qc.clear();
      qc.invalidateQueries({ queryKey: ['me'] });
    };
    window.addEventListener('rs:unauthorized', onUnauthorized);
    return () => window.removeEventListener('rs:unauthorized', onUnauthorized);
  }, [qc]);

  if (isLoading) return <div className="center muted">正在连接本地服务…</div>;

  if (error instanceof HttpError && error.status === 401) {
    return <Login onSuccess={() => qc.invalidateQueries({ queryKey: ['me'] })} />;
  }
  if (error) {
    return (
      <div className="center">
        <div className="card">
          <h2>连接失败</h2>
          <p className="muted">{(error as Error).message}</p>
          <p className="muted small">请确认 API 已启动：npm run dev （默认前端 5173 / API 3000）</p>
        </div>
      </div>
    );
  }
  if (!data) return null;

  return (
    <HashRouter>
      <Layout user={data.user} onLogout={() => qc.invalidateQueries({ queryKey: ['me'] })}>
        <Routes>
          <Route path="/" element={<Navigate to="/resumes" replace />} />
          <Route path="/resumes" element={<Library />} />
          <Route path="/editor/:id" element={<Editor />} />
          <Route path="/companies" element={<Companies />} />
          <Route path="/tracker" element={<TrackerPage />} />
          <Route path="/account" element={<Account user={data.user} />} />
          <Route path="/ai" element={<AiPlayground />} />
          <Route path="*" element={<Navigate to="/resumes" replace />} />
        </Routes>
      </Layout>
    </HashRouter>
  );
}
