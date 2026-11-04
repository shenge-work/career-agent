import { useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

interface AiStatus {
  configured: boolean;
  model: string;
  models: Record<string, string>;
  provider: string;
}

/** P2b · SSE 流式试用台：验证转发链路是否通，不承载业务写作流程。 */
export default function AiPlayground() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [model, setModel] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const { data: status } = useQuery({
    queryKey: ['ai-status'],
    queryFn: () => api<AiStatus>('/ai/status'),
  });

  function append(delta: string) {
    setMessages((prev) => {
      if (!prev.length) return prev;
      const next = [...prev];
      const last = next[next.length - 1];
      next[next.length - 1] = { ...last, content: last.content + delta };
      return next;
    });
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || streaming) return;
    const history: Msg[] = [
      ...messages.filter((m) => m.content),
      { role: 'user', content: text },
    ];
    setMessages([...history, { role: 'assistant', content: '' }]);
    setInput('');
    setError('');
    setStreaming(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history.map((m) => ({ role: m.role, content: m.content })),
          ...(model.trim() ? { model: model.trim() } : {}),
        }),
        signal: ctrl.signal,
      });
      if (res.status === 401) window.dispatchEvent(new CustomEvent('rs:unauthorized'));
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.message || `HTTP ${res.status}`);
      }
      if (!res.body) throw new Error('响应没有可读的流');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      // SSE 按空行分帧；逐块解析 data: 行，只取增量文本，不做整包缓冲
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() || '';
        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            let json: any;
            try {
              json = JSON.parse(data);
            } catch {
              continue; // 上游的非 JSON 心跳行，忽略
            }
            if (json?.error) throw new Error(String(json.error?.message || json.error));
            const delta =
              json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content ?? '';
            if (delta) append(String(delta));
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>AI 试用台</h1>
        <p className="muted small">
          SSE 流式转发（OpenAI 兼容 /chat/completions）。配置在「账号与设置」里，Key 不会进入浏览器。
        </p>
      </div>
      {error && <div className="alert">{error}</div>}

      <div className="split">
        <section className="panel">
          {!status?.configured && (
            <div className="hint">
              尚未配置模型。请先到 <a href="#/account">账号与设置 → AI 模型配置</a> 填写 baseURL、apiKey 与 models.fast。
            </div>
          )}
          <div className="chat ai-log">
            {messages.length === 0 ? (
              <div className="empty">发一条消息，验证流式转发是否通畅。</div>
            ) : (
              messages.map((m, i) => (
                <div key={i} className={'chat-row ' + (m.role === 'user' ? 'mine' : '')}>
                  <div className="chat-meta muted small">{m.role === 'user' ? '我' : status?.model || '模型'}</div>
                  <div className="bubble">
                    {m.content || (streaming && i === messages.length - 1 ? '…' : '（空）')}
                  </div>
                </div>
              ))
            )}
          </div>

          <form className="form-grid" onSubmit={send} style={{ marginTop: 18 }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="输入一句话…"
              rows={3}
              disabled={streaming}
            />
            <div className="btn-row">
              <button type="submit" disabled={streaming || !input.trim() || !status?.configured}>
                {streaming ? '生成中…' : '发送'}
              </button>
              <button
                type="button"
                className="mini"
                onClick={() => abortRef.current?.abort()}
                disabled={!streaming}
              >
                停止
              </button>
              <button
                type="button"
                className="mini danger"
                onClick={() => setMessages([])}
                disabled={streaming || !messages.length}
              >
                清空
              </button>
            </div>
          </form>
        </section>

        <aside className="panel detail">
          <h2>调用参数</h2>
          <p className="muted small">留空即用配置里的 models.fast。</p>
          <label>
            模型 model
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">默认（models.fast）</option>
              {Object.entries(status?.models || {}).map(([k, v]) => (
                <option key={k} value={v}>
                  {k} · {v}
                </option>
              ))}
            </select>
          </label>
          <h3 className="sub">可选模型</h3>
          <ul className="mini-list">
            {Object.entries(status?.models || {}).length ? (
              Object.entries(status?.models || {}).map(([k, v]) => (
                <li key={k}>
                  <strong>{k}</strong> · <span className="mono">{v}</span>
                </li>
              ))
            ) : (
              <li className="muted">尚未配置模型名</li>
            )}
          </ul>
          <h3 className="sub">说明</h3>
          <p className="muted small">
            本页只验证「浏览器 → 本地服务 → 上游」的流式链路，不改写简历内容。
            上游失败、超时或 Key 无效时会在上方给出错误提示，用量计入本账号。
          </p>
        </aside>
      </div>
    </>
  );
}
