import { useEffect } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, HttpError, type Me, type SettingsResponse } from './api';
import { applyTheme, themeFromSettings } from './theme';
import Layout from './Layout';
import Login from './pages/Login';
import Home from './pages/Home';
import Library from './pages/Library';
import Applications from './pages/Applications';
import ApplicationDetailPage from './pages/ApplicationDetailPage';
import Portfolio from './pages/Portfolio';
import Companies from './pages/Companies';
import CompanyDetailPage from './pages/CompanyDetailPage';
import Referrals from './pages/Referrals';
import TrackerPage from './pages/Tracker';
import TrackerDetailPage from './pages/TrackerDetailPage';
import Account from './pages/Account';
import AiPlayground from './pages/AiPlayground';
import Attachments from './pages/Attachments';
import Conflicts from './pages/Conflicts';
import Sync from './pages/Sync';
import Kb from './pages/Kb';
import Editor from './pages/Editor';

export default function App() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['me'],
    queryFn: () => api<Me>('/auth/me'),
  });

  // 登录后读服务端 settings，以服务端主题覆盖 localStorage 缓存（跨设备同步）。
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<SettingsResponse>('/settings'),
    enabled: !!data,
  });
  useEffect(() => {
    if (settings) applyTheme(themeFromSettings(settings.payload));
  }, [settings]);

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
          <Route path="/" element={<Home />} />
          <Route path="/applications" element={<Applications />} />
          <Route path="/applications/:id" element={<ApplicationDetailPage />} />
          <Route path="/portfolio" element={<Portfolio />} />
          <Route path="/resumes" element={<Library />} />
          <Route path="/attachments" element={<Attachments />} />
          <Route path="/conflicts" element={<Conflicts />} />
          <Route path="/sync" element={<Sync />} />
          <Route path="/editor/:id" element={<Editor />} />
          <Route path="/companies" element={<Companies />} />
          <Route path="/companies/:id" element={<CompanyDetailPage />} />
          <Route path="/referrals" element={<Referrals />} />
          <Route path="/tracker" element={<TrackerPage />} />
          <Route path="/tracker/:id" element={<TrackerDetailPage />} />
          <Route path="/account" element={<Account user={data.user} />} />
          <Route path="/ai" element={<AiPlayground />} />
          <Route path="/kb" element={<Kb />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </HashRouter>
  );
}
