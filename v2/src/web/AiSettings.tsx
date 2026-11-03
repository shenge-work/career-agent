import { useEffect, useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, del, fmtTime, post, put } from './api';

interface AiStatus {
  configured: boolean;
  hasApiKey: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  models: Record<string, string>;
  temperature: number;
  timeoutMs: number;
  source: string;
  nodeVersion: string;
  hint: string;
  usage: {
    requests: number;
    errors: number;
    todayRequests: number;
    lastAt: string | null;
    lastModel: string | null;
    days: Array<{ day: string; requests: number; errors: number }>;
  };
}

const EMPTY = {
  provider: 'openai-compatible',
  baseUrl: '',
  apiKey: '',
  fast: '',
  strong: '',
  temperature: '0.4',
  timeoutMs: '60000',
};

/** 账号级 AI 配置。apiKey 永不从服务端回传，输入框始终留空（留空 = 不修改）。 */
export default function AiSettings() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ ...EMPTY });
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const { data: status, isLoading } = useQuery({
    queryKey: ['ai-status'],
    queryFn: () => api<AiStatus>('/ai/status'),
  });

  useEffect(() => {
    if (!status) return;
    setForm((f) => ({
      ...f,
      provider: status.provider || 'openai-compatible',
      baseUrl: status.baseUrl || '',
      fast: status.models?.fast || '',
      strong: status.models?.strong || '',
      temperature: String(status.temperature ?? 0.4),
      timeoutMs: String(status.timeoutMs ?? 60000),
      apiKey: '', // 每次读状态都清空，避免把任何残留值当成已保存的 Key
    }));
  }, [status]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['ai-status'] });
  const onFail = (e: unknown) => {
    setError((e as Error).message);
    setNote('');
  };

  const saveM = useMutation({
    mutationFn: () => {
      const models: Record<string, string> = {};
      if (form.fast.trim()) models.fast = form.fast.trim();
      if (form.strong.trim()) models.strong = form.strong.trim();
      return put('/ai/config', {
        provider: form.provider.trim(),
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim(),
        models,
        temperature: Number(form.temperature),
        timeoutMs: Number(form.timeoutMs),
      });
    },
    onSuccess: () => {
      setError('');
      setNote('配置已保存（Key 只存服务端数据库）');
      setForm((f) => ({ ...f, apiKey: '' }));
      invalidate();
    },
    onError: onFail,
  });

  const testM = useMutation({
    mutationFn: () => post<{ ok: boolean; error?: string; latencyMs?: number; model?: string; sample?: string }>('/ai/test'),
    onSuccess: (r) => {
      setError('');
      setNote(
        r.ok
          ? `连接成功 · ${r.latencyMs}ms · ${r.model || ''}${r.sample ? ' · ' + r.sample.slice(0, 60) : ''}`
          : `连接失败：${r.error || '未知错误'}`
      );
      invalidate();
    },
    onError: onFail,
  });

  const clearM = useMutation({
    mutationFn: () => del('/ai/config'),
    onSuccess: () => {
      setError('');
      setNote('已停用本账号的 AI 配置');
      setForm({ ...EMPTY });
      invalidate();
    },
    onError: onFail,
  });

  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <section className="panel ai-settings">
      <h2>AI 模型配置</h2>
      <p className="muted small">
        OpenAI 兼容接口（DeepSeek / Ollama 等）。配置与用量按账号隔离，apiKey 只保存在服务端数据库，
        所有查询接口都不回传 Key 明文；留空 apiKey 表示沿用已保存的值。
      </p>

      {isLoading ? (
        <p className="muted small">正在读取配置…</p>
      ) : (
        <>
          <div className="btn-row" style={{ marginBottom: 14 }}>
            <span className="chip">状态：{status?.configured ? '已配置' : '未配置'}</span>
            <span className="chip">来源：{status?.source || 'none'}</span>
            <span className="chip">Key：{status?.hasApiKey ? '已保存' : '无'}</span>
            <span className="chip">默认模型：{status?.model || '未设置'}</span>
            <span className="chip">Node {status?.nodeVersion}</span>
          </div>

          {status?.hint && <div className="hint">{status.hint}</div>}
          {error && <div className="alert">{error}</div>}
          {note && <div className="hint">{note}</div>}

          <div className="form-grid two">
            <label>
              服务标识 provider
              <input value={form.provider} onChange={set('provider')} placeholder="openai-compatible" />
            </label>
            <label>
              上游地址 baseURL
              <input value={form.baseUrl} onChange={set('baseUrl')} placeholder="https://api.deepseek.com" />
            </label>
            <label>
              apiKey（留空不修改）
              <input type="password" value={form.apiKey} onChange={set('apiKey')} placeholder="sk-…" autoComplete="new-password" />
            </label>
            <label>
              快捷模型 models.fast
              <input value={form.fast} onChange={set('fast')} placeholder="deepseek-chat" />
            </label>
            <label>
              强力模型 models.strong
              <input value={form.strong} onChange={set('strong')} placeholder="deepseek-reasoner" />
            </label>
            <label>
              temperature（0~2）
              <input value={form.temperature} onChange={set('temperature')} inputMode="decimal" />
            </label>
            <label>
              超时 timeoutMs（1000~300000）
              <input value={form.timeoutMs} onChange={set('timeoutMs')} inputMode="numeric" />
            </label>
          </div>

          <div className="btn-row">
            <button className="mini" onClick={() => saveM.mutate()} disabled={saveM.isPending || !form.baseUrl.trim()}>
              {saveM.isPending ? '保存中…' : '保存配置'}
            </button>
            <button className="mini" onClick={() => testM.mutate()} disabled={testM.isPending || !status?.configured}>
              {testM.isPending ? '测试中…' : '测试连接'}
            </button>
            <button className="mini danger" onClick={() => clearM.mutate()} disabled={clearM.isPending || !status?.configured}>
              停用
            </button>
          </div>

          <h3 className="sub">用量（本账号）</h3>
          <div className="kv">
            <span>累计请求</span><span>{status?.usage?.requests ?? 0}</span>
            <span>今日请求</span><span>{status?.usage?.todayRequests ?? 0}</span>
            <span>失败次数</span><span>{status?.usage?.errors ?? 0}</span>
            <span>最近模型</span><span>{status?.usage?.lastModel || '—'}</span>
            <span>最近调用</span><span>{fmtTime(status?.usage?.lastAt)}</span>
          </div>

          <h3 className="sub">安全约束</h3>
          <p className="muted small">
            上游地址只允许 https；http 仅限本机回环（本地 Ollama）。内网 / 云元数据等字面 IP 一律拒绝，
            避免把本机服务变成跳板。域名解析到内网（DNS rebinding）不在本工具内防护，正式部署请在出口网关限制。
          </p>
        </>
      )}
    </section>
  );
}
