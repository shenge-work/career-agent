import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  activateConfig,
  api,
  fmtTime,
  post,
  putConfig,
  testAi,
  type AiCapability,
  type AiStatus,
  type AiTestResult,
} from './api';
import { MODEL_USAGE_HINT, MODEL_USAGE_MAP } from '../shared/ai';

/**
 * 预设服务商：选中后自动填 provider + baseURL，降低用户手动抄地址的门槛。
 * baseURL 均为各平台官方 OpenAI 兼容端点；模型 id 仅作占位提示（平台可能调整免费模型）。
 * 仅作录入辅助，不影响后端转发逻辑（后端只用 baseUrl + apiKey + 模型 id）。
 * 任何预设都不绕过服务端 validateBaseUrl 的 SSRF 硬边界。
 */
const PRESETS: Array<{
  key: string;
  label: string;
  provider: string;
  baseUrl: string;
  fastHint: string;
  strongHint: string;
  note: string;
  tags: string[];
}> = [
  { key: 'siliconflow', label: '硅基流动 SiliconFlow', provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', fastHint: 'Qwen/Qwen2.5-7B-Instruct', strongHint: 'deepseek-ai/DeepSeek-V3', note: '注册即送额度；模型 ID 大小写敏感，免费模型以平台模型广场为准。', tags: ['国内', '免卡', '多模型'] },
  { key: 'zhipu', label: '智谱 BigModel', provider: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', fastHint: 'glm-4-flash', strongHint: 'glm-4.7', note: 'glm-4-flash 长期免费（128K 上下文），新用户送 2000 万 Tokens；glm-5.3 等旗舰为付费模型。', tags: ['国内', '长期免费'] },
  { key: 'deepseek', label: 'DeepSeek 官方', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', fastHint: 'deepseek-chat', strongHint: 'deepseek-reasoner', note: '送免费额度，国内直连；reasoner 为推理模型。', tags: ['国内', '推理强'] },
  { key: 'qwen', label: '阿里云百炼（通义千问）', provider: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', fastHint: 'qwen-plus', strongHint: 'qwen-max', note: '需阿里云账号；OpenAI 兼容（compatible-mode），API Key 按地域绑定；新用户送免费额度。', tags: ['国内', '多模型'] },
  { key: 'xfyun', label: '讯飞星火', provider: 'xfyun', baseUrl: 'https://spark-api-open.xf-yun.com/v1', fastHint: 'generalv3', strongHint: 'generalv3.5', note: 'OpenAI 兼容端点；鉴权用控制台的 APIPassword（Bearer）；lite 免费，generalv3=Pro / generalv3.5=Max / 4.0Ultra=旗舰。', tags: ['国内', '中文强'] },
  { key: 'doubao', label: '火山方舟（豆包）', provider: 'doubao', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', fastHint: 'ep-xxxxxxxx（接入点 ID）', strongHint: '', note: '需字节账号；模型填 ep- 开头的接入点 ID，首次开通送 50 万 tokens。', tags: ['国内', '需账号'] },
  { key: 'hunyuan', label: '腾讯混元', provider: 'hunyuan', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', fastHint: 'hunyuan-lite', strongHint: 'hunyuan-standard', note: '需腾讯云账号；首次开通送 100 万 tokens。', tags: ['国内', '需账号'] },
  { key: 'kimi', label: 'Kimi（月之暗面）', provider: 'kimi', baseUrl: 'https://platform.moonshot.cn/v1', fastHint: 'moonshot-v1-8k', strongHint: 'moonshot-v1-32k', note: 'OpenAI 兼容；新用户送代金券（需国内手机）。', tags: ['国内', '中文强'] },
  { key: 'gemini', label: 'Google AI Studio（Gemini）', provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', fastHint: 'gemini-2.5-flash', strongHint: 'gemini-3-flash', note: '免信用卡；国内访问不稳，且免费层可能用 prompt 训练，慎传简历 PII。', tags: ['多模态', '免卡', '海外'] },
  { key: 'groq', label: 'Groq', provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1', fastHint: 'llama-3.3-70b-versatile', strongHint: 'deepseek-r1-distill-llama-70b', note: '免信用卡；免费层约 30 RPM，适合原型。', tags: ['极快', '免卡', '海外'] },
  { key: 'nvidia', label: 'NVIDIA NIM', provider: 'nvidia', baseUrl: 'https://integrate.api.nvidia.com/v1', fastHint: 'deepseek-ai/deepseek-v3', strongHint: '', note: '免信用卡；约 40 RPM，部分模型需手机验证。', tags: ['免卡', '海外'] },
  { key: 'openrouter', label: 'OpenRouter', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', fastHint: 'deepseek/deepseek-chat-v3-0324:free', strongHint: '', note: '免信用卡；免费层约 200 请求/天。', tags: ['聚合', '免卡', '海外'] },
  { key: 'topenrouter', label: 'TopenRouter', provider: 'topenrouter', baseUrl: 'https://tp-api.chinadatapay.com:8000/v1', fastHint: 'deepseek-v4-flash', strongHint: 'deepseek-ai/DeepSeek-V4-Pro', note: '国内直连 OpenAI 兼容网关，统一调用 DeepSeek/GLM/Kimi 等模型；baseUrl 已带 /v1 后缀，请勿再删。', tags: ['国内直连', '聚合'] },
  { key: 'cerebras', label: 'Cerebras', provider: 'cerebras', baseUrl: 'https://api.cerebras.ai/v1', fastHint: 'llama-3.3-70b', strongHint: 'gpt-oss-120b', note: '免信用卡；约 100 万 tokens/天。', tags: ['超快', '免卡', '海外'] },
];

/** 客户端即时校验（仅作输入提示，权威校验永远在服务端 validateBaseUrl）。 */
function isPrivateLiteral(host: string): boolean {
  const h = host.replace(/^::ffff:/, '');
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const c = Number(m[3]);
    if (a === 127 || a === 0) return false;
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (h.includes(':')) return /^(fc|fd|fe[89ab])/i.test(h) || h.startsWith('fe80');
  return false;
}

function clientBaseUrlError(raw: string): string | null {
  const s = String(raw || '').trim();
  if (!s) return 'baseUrl 不能为空';
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return '不是合法 URL';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '只支持 http / https';
  if (u.username || u.password) return '不能包含账号密码';
  if (u.search || u.hash) return '不能带查询参数或片段';
  if (u.pathname.includes('..')) return '路径不能包含 ..';
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1' || /^127\./.test(host);
  if (u.protocol === 'http:' && !loopback) return 'http 上游仅限本机回环地址（远程请用 https）';
  if (isPrivateLiteral(host) && !(u.protocol === 'http:' && loopback)) return '上游不能指向内网 / 保留地址';
  if (host === '0.0.0.0' || host === '::') return '上游地址无效';
  return null;
}

/** 与后端 deriveProviderSlug 一致的客户端实现：供「自定义」表单实时预览派生 slug。 */
function clientProviderSlug(baseUrl: string): string {
  let host = '';
  try {
    host = new URL(String(baseUrl || '')).hostname;
  } catch {
    host = '';
  }
  const s = host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (s ? `custom-${s}` : 'custom').slice(0, 60).replace(/-+$/, '') || 'custom';
}

/** 配置状态 → 语义色（none=灰 / partial=琥珀 / full=绿）。 */
function levelTone(level?: string): string {
  if (level === 'full') return 'tone-green';
  if (level === 'partial') return 'tone-amber';
  return 'tone-gray';
}

function levelLabel(level?: string): string {
  if (level === 'full') return '就绪';
  if (level === 'partial') return '部分配置';
  return '未配置';
}

function CapabilityCard({ tier, cap }: { tier: 'fast' | 'strong'; cap: AiCapability }) {
  const usage = MODEL_USAGE_MAP[tier];
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, flex: '1 1 260px', background: 'var(--surface-2)' }}>
      <div className="btn-row" style={{ marginBottom: 8 }}>
        <strong>{tier === 'fast' ? '常用模型' : '深度模型'}</strong>
        <span className="mono small">{cap.model || '未设置'}</span>
        <span className={`status-badge ${cap.reachable ? 'tone-green' : 'tone-red'}`}>
          {cap.reachable ? '连通' : '不可达'}
        </span>
      </div>
      <div className="kv">
        <span>JSON 输出</span>
        <span>
          {cap.supportsJsonObject === true ? '✓ 支持' : cap.supportsJsonObject === false ? '✗ 不支持（自动降级重试）' : '未验证'}
        </span>
        <span>流式</span>
        <span>{cap.supportsStream === true ? '✓ 支持' : cap.supportsStream === false ? '✗ 不支持' : '未验证'}</span>
        <span>耗时</span>
        <span>{cap.latencyMs}ms</span>
        <span>用途</span>
        <span className="muted small">{MODEL_USAGE_HINT[tier]}（{usage.join('、')}）</span>
      </div>
      {cap.error && <div className="alert">{cap.error.message}</div>}
    </div>
  );
}

/** 模型可搜索下拉：点开输入框弹出候选，输入过滤，点击/回车选中。 */
function ModelPicker({
  value,
  options,
  placeholder,
  onChange,
  onRefresh,
  refreshPending,
}: {
  value: string;
  options: string[];
  placeholder: string;
  onChange: (v: string) => void;
  onRefresh: () => void;
  refreshPending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = options.filter((o) => !q || o.toLowerCase().includes(q));
    // 当前已填但不在候选里的值，排在顶部以便用户看到当前选择。
    if (value && !base.includes(value)) base.unshift(value);
    return base.slice(0, 50);
  }, [options, query, value]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const pick = (v: string) => {
    onChange(v);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="model-picker" ref={wrapRef}>
      <input
        value={open ? query : value}
        placeholder={placeholder}
        onFocus={() => {
          setQuery('');
          setOpen(true);
        }}
        onChange={(e) => (open ? setQuery(e.target.value) : onChange(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'Enter' && open && filtered[0]) {
            e.preventDefault();
            pick(filtered[0]);
          }
        }}
      />
      <button
        type="button"
        className="mini"
        onClick={onRefresh}
        disabled={refreshPending}
        title="从上游 /models 拉取可用模型，之后可下拉选择"
      >
        {refreshPending ? '拉取中…' : '拉取列表'}
      </button>
      {open && (
        <div className="model-picker-menu">
          {filtered.length === 0 ? (
            <div className="model-picker-empty">没有匹配的模型，可直接手动填写 ID</div>
          ) : (
            filtered.map((m) => (
              <button
                type="button"
                key={m}
                className={'model-picker-item' + (m === value ? ' selected' : '')}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(m);
                }}
              >
                <span className="mono">{m}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

interface FormState {
  provider: string;
  baseUrl: string;
  apiKey: string;
  fast: string;
  strong: string;
  temperature: string;
  timeoutMs: string;
}

const EMPTY_FORM: FormState = {
  provider: 'openai-compatible',
  baseUrl: '',
  apiKey: '',
  fast: '',
  strong: '',
  temperature: '0.4',
  timeoutMs: '60000',
};

type FormTarget = { provider: string; presetKey: string; isCustom: boolean } | null;

/** 账号级 AI 配置（多厂商并存）。apiKey 永不从服务端回传，输入框始终留空（留空 = 不修改）。 */
export default function AiSettings() {
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [formTarget, setFormTarget] = useState<FormTarget>(null);
  const [form, setForm] = useState<FormState>({ ...EMPTY_FORM });
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [testResult, setTestResult] = useState<AiTestResult | null>(null);
  const [modelList, setModelList] = useState<string[]>([]);
  const [modelListError, setModelListError] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [dialogNote, setDialogNote] = useState('');
  const [dialogTest, setDialogTest] = useState<AiTestResult | null>(null);
  const [cardTests, setCardTests] = useState<Record<string, AiTestResult>>({});

  const { data: status, isLoading } = useQuery({
    queryKey: ['ai-status'],
    queryFn: () => api<AiStatus>('/ai/status'),
  });

  const configs = status?.configs ?? [];
  const activeProvider = status?.activeProvider ?? (status?.configured ? status.provider : '');
  const presetOf = (provider: string) => PRESETS.find((p) => p.provider === provider);
  const labelOf = (provider: string) => presetOf(provider)?.label ?? provider;

  const invalidate = () => qc.invalidateQueries({ queryKey: ['ai-status'] });
  const onFail = (e: unknown) => {
    setError((e as Error).message);
    setNote('');
  };

  const baseUrlError = useMemo(() => clientBaseUrlError(form.baseUrl), [form.baseUrl]);

  // 下拉候选：过滤明显非对话模型（embedding / rerank / 语音 / 图像），避免误选；过滤后为空则回退全量。
  const chatModels = useMemo(() => {
    const filtered = modelList.filter((m) => !/embed|rerank|bge|clip|whisper|tts|audio|image/i.test(m));
    return filtered.length ? filtered : modelList;
  }, [modelList]);

  const isCustom = formTarget?.isCustom === true;
  const effectiveProvider = isCustom ? clientProviderSlug(form.baseUrl) : (formTarget?.provider ?? form.provider);

  const set = (k: keyof FormState) => (e: ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  /** 打开新增/编辑弹窗表单：预填预设或已保存值。 */
  function openForm(target: { provider: string; presetKey: string; isCustom: boolean }) {
    const p = PRESETS.find((x) => x.provider === target.provider);
    const existing = configs.find((c) => c.provider === target.provider);
    setForm({
      provider: target.provider,
      baseUrl: existing?.baseUrl ?? p?.baseUrl ?? '',
      apiKey: '',
      fast: existing?.models?.fast ?? '',
      strong: existing?.models?.strong ?? '',
      temperature: String(existing?.temperature ?? 0.4),
      timeoutMs: String(existing?.timeoutMs ?? 60000),
    });
    setFormTarget(target);
    setAddOpen(false);
    setShowKey(false);
    setModelList([]);
    setModelListError('');
    setDialogNote('');
    setDialogTest(null);
    setError('');
  }

  /** 从上游拉取模型列表（body 带未保存的 baseUrl/apiKey，留空则用已保存配置）。 */
  const modelsM = useMutation({
    mutationFn: () =>
      post<{ ok: boolean; count: number; models: string[] }>('/ai/models', {
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim(),
      }),
    onSuccess: (r) => {
      setModelListError('');
      setModelList(Array.isArray(r.models) ? r.models : []);
      setDialogNote(`已从上游获取 ${r.count} 个模型：点击模型框即可下拉选择。`);
    },
    onError: (e) => {
      setModelListError((e as Error).message);
      setModelList([]);
    },
  });

  /** 顶部横幅：探活「当前生效厂商」。 */
  const testM = useMutation({
    mutationFn: () => testAi(),
    onSuccess: (r) => {
      setError('');
      setTestResult(r);
      setNote(r.ok ? `连接成功 · ${r.latencyMs}ms · ${r.model || ''}` : `连接失败：${r.error || '未知错误'}`);
      invalidate();
    },
    onError: onFail,
  });

  /** 卡片「测试」：探活指定厂商。 */
  const cardTestM = useMutation({
    mutationFn: (provider: string) => testAi(provider),
    onSuccess: (r, provider) => {
      setError('');
      setCardTests((m) => ({ ...m, [provider]: r }));
      invalidate();
    },
    onError: onFail,
  });

  /** 弹窗内保存后自动探活该厂商。 */
  const dialogTestM = useMutation({
    mutationFn: (provider: string) => testAi(provider),
    onSuccess: (r) => {
      setDialogTest(r);
      setDialogNote(r.ok ? `连接成功 · ${r.latencyMs}ms · ${r.model || ''}` : `连接失败：${r.error || '未知错误'}`);
      invalidate();
    },
    onError: onFail,
  });

  const activateM = useMutation({
    mutationFn: (provider: string) => activateConfig(provider),
    onSuccess: () => {
      setError('');
      setNote('已切换生效厂商');
      invalidate();
    },
    onError: onFail,
  });

  const saveM = useMutation({
    mutationFn: async () => {
      const provider = effectiveProvider;
      const models: Record<string, string> = {};
      if (form.fast.trim()) models.fast = form.fast.trim();
      if (form.strong.trim()) models.strong = form.strong.trim();
      return putConfig(provider, {
        provider,
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim(),
        models,
        temperature: Number(form.temperature),
        timeoutMs: Number(form.timeoutMs),
      });
    },
    onSuccess: (r) => {
      setError('');
      setForm((f) => ({ ...f, apiKey: '' }));
      invalidate();
      const provider = r?.provider || effectiveProvider;
      // 没选模型时自动探活必然失败（「未指定模型」），改为引导用户先拉取/选择模型。
      if (!form.fast.trim() && !form.strong.trim()) {
        setDialogNote('配置已保存，但还没有选择模型：点「拉取列表」从下拉选择，或直接填写模型 ID。');
        return;
      }
      setDialogNote('配置已保存，正在自动探活…');
      dialogTestM.mutate(provider);
    },
    onError: onFail,
  });

  const probeOk = testResult?.ok === true;

  return (
    <section className="panel ai-settings">
      <h2>AI 模型配置</h2>
      <p className="muted small">
        OpenAI 兼容接口（DeepSeek / SiliconFlow / Ollama 等）。一个账号可配置多个服务商，各自独立的
        baseUrl / apiKey / 模型；其中一个是「当前生效」厂商。apiKey 只保存在服务端数据库，所有查询接口都不回传 Key 明文。
      </p>

      {isLoading ? (
        <p className="muted small">正在读取配置…</p>
      ) : (
        <>
          {/* 区块①：当前生效厂商状态横幅 */}
          <div className="ai-banner">
            <div className="ai-banner-main">
              <span className={`status-badge ${levelTone(status?.configuredLevel)}`}>
                {levelLabel(status?.configuredLevel)}
              </span>
              <span className="ai-banner-provider">{activeProvider ? labelOf(activeProvider) : '尚未设置生效厂商'}</span>
              {status?.configured && (
                <span className="ai-banner-model mono" title="当前生效模型">
                  {status.model || '未选模型'}
                </span>
              )}
              {probeOk && testResult && (
                <span className="status-badge tone-green">✓ 连接正常 · {testResult.latencyMs}ms</span>
              )}
              {testResult && !probeOk && testResult.capabilities && (
                <span className="status-badge tone-red">✗ 连接失败</span>
              )}
            </div>
            <div className="ai-banner-side">
              <span className="muted small">
                Key {status?.hasApiKey ? '已保存' : '未设置'}
              </span>
              {activeProvider ? (
                <button className="mini" onClick={() => testM.mutate()} disabled={testM.isPending}>
                  {testM.isPending ? '测试中…' : '测试生效厂商'}
                </button>
              ) : (
                <button className="mini primary" onClick={() => setAddOpen(true)}>去设置</button>
              )}
            </div>
          </div>

          {!activeProvider && (
            <div className="hint" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ flex: 1 }}>尚未设置生效厂商：添加并保存一个服务商，或把已有厂商设为默认。</span>
              <button className="mini primary" onClick={() => setAddOpen(true)}>＋ 添加服务商</button>
            </div>
          )}

          {error && <div className="alert">{error}</div>}
          {note && <div className="hint">{note}</div>}

          {testResult?.capabilities && (
            <div className="ai-capabilities">
              <div className="btn-row" style={{ gap: 10, alignItems: 'stretch', flexWrap: 'wrap' }}>
                <CapabilityCard tier="fast" cap={testResult.capabilities.fast} />
                <CapabilityCard tier="strong" cap={testResult.capabilities.strong} />
              </div>
            </div>
          )}

          {/* 区块②：已配置厂商卡片网格 */}
          <div className="ai-section-head">
            <h3 className="sub" style={{ margin: 0 }}>已配置服务商</h3>
            <button className="mini add" onClick={() => setAddOpen(true)}>＋ 添加服务商</button>
          </div>

          {configs.length === 0 ? (
            <p className="muted small">还没有配置任何服务商，点「添加服务商」开始。</p>
          ) : (
            <div className="ai-provider-list">
              {configs.map((cfg) => {
                const ct = cardTests[cfg.provider];
                const isFull = !!(cfg.models.fast && cfg.models.strong);
                const canActivate = cfg.hasApiKey && (cfg.models.fast || cfg.models.strong);
                return (
                  <div
                    className={'ai-provider-item' + (cfg.isActive ? ' is-active' : '')}
                    key={cfg.provider}
                    onClick={() => {
                      // 点击非生效卡片即切换生效；生效卡片不响应。
                      if (!cfg.isActive && canActivate) activateM.mutate(cfg.provider);
                    }}
                    title={cfg.isActive ? '当前生效厂商' : canActivate ? '点击切换为生效厂商' : '需先保存 apiKey 并选择模型才能设为生效'}
                  >
                    <div className="ai-provider-item-head">
                      <span className="ai-provider-item-name">{labelOf(cfg.provider)}</span>
                      <span className="mono small faint">{cfg.provider}</span>
                      <span className={`status-badge ${isFull ? 'tone-green' : 'tone-amber'}`}>
                        {isFull ? '已配置' : '部分配置'}
                      </span>
                      {cfg.isActive && <span className="status-badge tone-indigo">当前生效</span>}
                    </div>
                    <div className="kv">
                      <span>上游地址</span>
                      <span className="mono" title={cfg.baseUrl}>{cfg.baseUrl || '—'}</span>
                      <span>常用模型</span>
                      <span className="mono">{cfg.models.fast || '—'}</span>
                      <span>深度模型</span>
                      <span className="mono">{cfg.models.strong || '—'}</span>
                      <span>Key</span>
                      <span>{cfg.hasApiKey ? '已保存' : '未设置'}</span>
                      <span>最近模型</span>
                      <span>{cfg.lastModel || '—'}</span>
                      <span>最近调用</span>
                      <span>{cfg.lastAt ? fmtTime(cfg.lastAt) : '—'}</span>
                    </div>
                    {ct && (
                      <div className={ct.ok ? 'hint' : 'hint ai-test-fail'}>
                        {ct.ok ? `✓ 连接正常 · ${ct.latencyMs}ms · ${ct.model || ''}` : `✗ 连接失败：${(ct as any).error || '未知错误'}`}
                      </div>
                    )}
                    <div className="btn-row">
                      <button
                        className="mini"
                        onClick={(e) => {
                          e.stopPropagation();
                          cardTestM.mutate(cfg.provider);
                        }}
                        disabled={cardTestM.isPending}
                      >
                        {cardTestM.isPending ? '测试中…' : '测试'}
                      </button>
                      <button
                        className="mini"
                        onClick={(e) => {
                          e.stopPropagation();
                          openForm({ provider: cfg.provider, presetKey: presetOf(cfg.provider)?.key ?? '', isCustom: false });
                        }}
                      >
                        编辑
                      </button>
                      {!cfg.isActive && (
                        <button
                          className="mini primary"
                          onClick={(e) => {
                            e.stopPropagation();
                            activateM.mutate(cfg.provider);
                          }}
                          disabled={activateM.isPending || !canActivate}
                          title={canActivate ? '设为当前生效厂商' : '需先保存 apiKey 并选择模型才能设为生效'}
                        >
                          设为生效
                        </button>
                      )}
                      {cfg.isActive && <span className="muted small" style={{ alignSelf: 'center' }}>当前生效 · 点击其他厂商可切换</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* 区块③：安全约束 */}
          <h3 className="sub">安全约束</h3>
          <p className="muted small">
            上游地址只允许 https；http 仅限本机回环（本地 Ollama）。内网 / 云元数据等字面 IP 一律拒绝，
            避免把本机服务变成跳板。域名解析到内网（DNS rebinding）不在本工具内防护，正式部署请在出口网关限制。
          </p>

          {/* 添加服务商选择弹窗 */}
          {addOpen && (
            <div className="ai-modal-backdrop" onClick={() => setAddOpen(false)}>
              <div className="ai-modal" onClick={(e) => e.stopPropagation()}>
                <div className="ai-modal-head">
                  <span className="ai-step-title">选择服务商</span>
                  <button className="mini" onClick={() => setAddOpen(false)}>关闭</button>
                </div>
                <div className="ai-provider-grid">
                  <button
                    type="button"
                    className="ai-provider-card"
                    onClick={() => openForm({ provider: '', presetKey: '', isCustom: true })}
                  >
                    <span className="ai-provider-name">自定义</span>
                    <span className="ai-provider-tags"><span className="ai-tag">手动填写</span></span>
                  </button>
                  {PRESETS.map((p) => {
                    const configured = configs.some((c) => c.provider === p.provider);
                    return (
                      <button
                        type="button"
                        key={p.key}
                        className={'ai-provider-card' + (configured ? ' configured' : '')}
                        onClick={() => !configured && openForm({ provider: p.provider, presetKey: p.key, isCustom: false })}
                        disabled={configured}
                        title={configured ? '已配置，可在卡片上编辑' : p.note}
                      >
                        <span className="ai-provider-name">{p.label}</span>
                        <span className="ai-provider-tags">
                          {configured && <span className="ai-tag">已配置</span>}
                          {p.tags.map((t) => (
                            <span className="ai-tag" key={t}>{t}</span>
                          ))}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* 新增/编辑表单弹窗 */}
          {formTarget && (
            <div className="ai-modal-backdrop" onClick={() => setFormTarget(null)}>
              <div className="ai-modal" onClick={(e) => e.stopPropagation()}>
                <div className="ai-modal-head">
                  <span className="ai-step-title">
                    {formTarget.isCustom
                      ? '自定义服务商'
                      : formTarget.provider
                        ? `编辑 ${labelOf(formTarget.provider)}`
                        : '新增服务商'}
                  </span>
                  <button className="mini" onClick={() => setFormTarget(null)}>关闭</button>
                </div>

                <div className="form-grid two">
                  <label>
                    服务标识 provider
                    <input value={effectiveProvider} readOnly disabled title="预设锁定 / 自定义由 baseUrl 派生" />
                  </label>
                  <label>
                    上游地址 baseURL
                    <input
                      value={form.baseUrl}
                      onChange={set('baseUrl')}
                      placeholder="https://api.deepseek.com"
                      style={baseUrlError ? { borderColor: 'var(--danger)' } : undefined}
                    />
                    {baseUrlError && <span className="muted small" style={{ color: 'var(--danger)' }}>{baseUrlError}</span>}
                  </label>
                  <label>
                    apiKey（留空沿用旧值）
                    <span className="ai-key-wrap">
                      <input
                        type={showKey ? 'text' : 'password'}
                        value={form.apiKey}
                        onChange={set('apiKey')}
                        placeholder="sk-…"
                        autoComplete="new-password"
                      />
                      <button
                        type="button"
                        className="mini ai-key-toggle"
                        onClick={() => setShowKey((v) => !v)}
                        title={showKey ? '隐藏 Key' : '显示 Key'}
                      >
                        {showKey ? '隐藏' : '显示'}
                      </button>
                    </span>
                  </label>
                  <label>
                    常用模型（JD 解析 · 投递话术）<span className="mono faint">models.fast</span>
                    <ModelPicker
                      value={form.fast}
                      options={chatModels}
                      placeholder={presetOf(formTarget.provider)?.fastHint || 'deepseek-chat'}
                      onChange={(v) => setForm((f) => ({ ...f, fast: v }))}
                      onRefresh={() => modelsM.mutate()}
                      refreshPending={modelsM.isPending}
                    />
                  </label>
                  <label>
                    深度模型（面试复盘 · 面经问答）<span className="mono faint">models.strong</span>
                    <ModelPicker
                      value={form.strong}
                      options={chatModels}
                      placeholder={presetOf(formTarget.provider)?.strongHint || 'deepseek-reasoner'}
                      onChange={(v) => setForm((f) => ({ ...f, strong: v }))}
                      onRefresh={() => modelsM.mutate()}
                      refreshPending={modelsM.isPending}
                    />
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

                {modelListError && <div className="alert">{modelListError}</div>}
                {dialogNote && <div className="hint">{dialogNote}</div>}
                {dialogTest?.capabilities && (
                  <div className="ai-capabilities">
                    <div className="btn-row" style={{ gap: 10, alignItems: 'stretch', flexWrap: 'wrap' }}>
                      <CapabilityCard tier="fast" cap={dialogTest.capabilities.fast} />
                      <CapabilityCard tier="strong" cap={dialogTest.capabilities.strong} />
                    </div>
                  </div>
                )}

                <div className="ai-actions">
                  <button
                    className="mini primary"
                    onClick={() => saveM.mutate()}
                    disabled={saveM.isPending || !form.baseUrl.trim() || !!baseUrlError}
                  >
                    {saveM.isPending ? '保存中…' : '保存'}
                  </button>
                  <button className="mini" onClick={() => setFormTarget(null)}>取消</button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
