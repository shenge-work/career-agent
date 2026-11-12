import { Injectable } from '@nestjs/common';
import { TenantDb } from '../tenant/tenant-db';
import {
  buildChatPayload,
  deriveProviderSlug,
  normalizeConfig,
  publicConfig,
  publicConfigs,
  validateBaseUrl,
  type AiProviderConfig,
  type AiRuntimeConfig,
  type AiRuntimeConfigWithActive,
  type ConfigPatch,
} from './ai-config';
import { AiHttpClient, type AiCompleteResult } from './ai-http';
import { AiProxyError, type AiError, type AiErrorCode } from './ai-errors';
import { modelTierForAction } from '../../shared/ai';

// 兼容旧链路（practice / agent 里仍 `import { AiProxyError } from './ai.service'`）。
export { AiProxyError, AiError } from './ai-errors';
export type { AiErrorCode } from './ai-errors';

export interface ChatOpened {
  upstream: Response;
  model: string;
  cfg: AiRuntimeConfig;
}

/** 能力探活单项（P1-3）：对 fast/strong 各做一次连通 + 一次 json_object 探测。 */
export interface AiCapability {
  model: string;
  reachable: boolean;
  supportsJsonObject?: boolean;
  supportsStream?: boolean;
  latencyMs: number;
  error?: AiError;
}

export interface AiTestResult {
  ok: boolean;
  model: string;
  latencyMs: number;
  sample?: string;
  capabilities: { fast: AiCapability; strong: AiCapability };
}

/**
 * 从 OpenAI-compatible 非流式响应里提取 content 文本。
 * 兼容 `choices[0].message.content`（标准）与裸字符串两种情况；
 * 个别兼容层直接回 `{"content": "..."}` 也一并兜底。
 */
function extractContent(raw: string): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const j = JSON.parse(s);
    const content = j?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (typeof j?.content === 'string') return j.content;
    if (typeof j?.text === 'string') return j.text;
  } catch {
    /* 非 JSON，原样返回 */
  }
  return s;
}

/** 从上游响应体里提取 usage（仅元数据：token 数，绝不落正文）。 */
function extractUsage(raw: string): { promptTokens?: number; completionTokens?: number } {
  try {
    const j = JSON.parse(raw);
    const u = j?.usage;
    const p = Number(u?.prompt_tokens);
    const c = Number(u?.completion_tokens);
    return {
      promptTokens: Number.isFinite(p) ? p : undefined,
      completionTokens: Number.isFinite(c) ? c : undefined,
    };
  } catch {
    return {};
  }
}

/** 从 /models 响应体解析模型 id 列表（兼容 data[] / models[] / 裸数组）。 */
function parseModelIds(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const obj = parsed as any;
  const arr: any[] = Array.isArray(obj)
    ? obj
    : Array.isArray(obj?.data)
      ? obj.data
      : Array.isArray(obj?.models)
        ? obj.models
        : [];
  const ids: string[] = arr
    .map((m: any) => (typeof m === 'string' ? m : m?.id || m?.name || m?.model || ''))
    .map((s: any) => String(s || '').trim())
    .filter((s: string): s is string => !!s);
  const uniq = Array.from(new Set<string>(ids));
  return uniq.sort((a, b) => a.localeCompare(b));
}

function errCode(e: unknown): AiErrorCode | null {
  if (e instanceof AiProxyError) return e.code;
  if (e && typeof e === 'object' && 'code' in (e as any)) return String((e as any).code) as AiErrorCode;
  return null;
}

function toAiError(e: unknown): AiError {
  if (e instanceof AiProxyError) {
    return { code: e.code, message: e.message, status: e.status, retryable: e.retryable, retryAfterMs: e.retryAfterMs };
  }
  return { code: 'UPSTREAM_ERROR', message: (e as any)?.message || String(e), retryable: false };
}

@Injectable()
export class AiService {
  private readonly http = new AiHttpClient();

  constructor(private readonly tenant: TenantDb) {}

  /** 把 DB 行转成运行时配置对象（apiKey 只留在服务端内存）。 */
  private toRuntime(row: {
    provider: string;
    baseUrl: string;
    apiKey: string;
    models: Record<string, string> | null;
    temperature: number;
    timeoutMs: number;
  }): AiRuntimeConfig {
    return {
      provider: row.provider,
      baseUrl: row.baseUrl,
      apiKey: row.apiKey,
      models: (row.models || {}) as Record<string, string>,
      temperature: row.temperature,
      timeoutMs: row.timeoutMs,
      source: 'database',
    };
  }

  /** 只认「当前生效厂商」（is_active=true 且 baseUrl+apiKey 有效）。返回的对象永不出服务端。 */
  async resolveActiveConfig(userId: string): Promise<AiRuntimeConfig | null> {
    const rows = await this.tenant.forUser(userId).getActiveAiConfig();
    const row = rows[0];
    if (!row) return null;
    if (!row.baseUrl || !row.apiKey) return null; // 空行 = 主动停用
    return this.toRuntime(row);
  }

  /** 向后兼容别名：下游 complete/openChat/test/listModels 零改动，自动走当前生效厂商。 */
  async resolveConfig(userId: string): Promise<AiRuntimeConfig | null> {
    return this.resolveActiveConfig(userId);
  }

  /** 用量写失败不能影响主流程（本地库偶发写入竞争时尤其如此）。 */
  private async bump(
    userId: string,
    opts: {
      action?: string | null;
      model?: string | null;
      provider?: string | null;
      status?: 'ok' | 'error';
      errorCode?: AiErrorCode | null;
      latencyMs?: number | null;
      tokens?: { promptTokens?: number; completionTokens?: number } | null;
    }
  ) {
    try {
      await this.tenant.forUser(userId).bumpAiUsage(opts);
      // 0020 · 同时追加一条明细事件，供厂商/模型对账（不阻塞、不因失败影响主流程）。
      await this.tenant.forUser(userId).insertAiUsageEvent(opts);
    } catch {
      /* noop */
    }
  }

  private summarize(
    rows: Array<{
      day: string;
      requests: number;
      errors: number;
      lastAt: Date | null;
      lastModel: string | null;
      latencyMs?: number | null;
      promptTokens?: number | null;
      completionTokens?: number | null;
    }>
  ) {
    const today = new Date().toLocaleDateString('sv-SE');
    const total = rows.reduce(
      (acc, r) => ({
        requests: acc.requests + (r.requests || 0),
        errors: acc.errors + (r.errors || 0),
      }),
      { requests: 0, errors: 0 }
    );
    const latest = [...rows].sort((a, b) => (b.lastAt?.getTime() || 0) - (a.lastAt?.getTime() || 0))[0];
    const latencies = rows.map((r) => r.latencyMs).filter((v): v is number => typeof v === 'number' && v > 0);
    const avgLatencyMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
    return {
      ...total,
      todayRequests: rows.find((r) => r.day === today)?.requests || 0,
      lastAt: latest?.lastAt || null,
      lastModel: latest?.lastModel || null,
      avgLatencyMs,
      totalPromptTokens: rows.reduce((n, r) => n + (r.promptTokens || 0), 0),
      totalCompletionTokens: rows.reduce((n, r) => n + (r.completionTokens || 0), 0),
      days: rows.slice(0, 7).map((r) => ({ day: r.day, requests: r.requests, errors: r.errors })),
    };
  }

  /** 从账号级用量行里，按 provider 聚合出「最近一次调用」的模型与时间。 */
  private latestUsageByProvider(
    rows: Array<{ provider: string | null; lastModel: string | null; lastAt: Date | null }>
  ): Map<string, { lastModel: string | null; lastAt: string | null }> {
    const m = new Map<string, { lastModel: string | null; lastAt: string | null }>();
    for (const r of rows) {
      if (!r.provider) continue;
      const t = r.lastAt?.getTime() ?? 0;
      const cur = m.get(r.provider);
      const curT = cur?.lastAt ? new Date(cur.lastAt).getTime() : -1;
      if (!cur || t > curT) {
        m.set(r.provider, {
          lastModel: r.lastModel,
          lastAt: r.lastAt ? r.lastAt.toISOString() : null,
        });
      }
    }
    return m;
  }

  /** GET /api/ai/configs：多厂商脱敏列表 + 当前生效厂商标识。 */
  async listConfigs(userId: string): Promise<{ configs: AiProviderConfig[]; activeProvider: string }> {
    const rows = await this.tenant.forUser(userId).getAiConfigs();
    const usageRows = await this.tenant.forUser(userId).listAiUsage();
    const activeProvider = rows.find((r) => r.isActive)?.provider || '';
    const runtimes: AiRuntimeConfigWithActive[] = rows.map((r) => ({
      ...this.toRuntime(r),
      isActive: !!r.isActive,
    }));
    const base = publicConfigs(runtimes, activeProvider);
    const latest = this.latestUsageByProvider(usageRows);
    return {
      activeProvider: base.activeProvider,
      configs: base.configs.map((c) => {
        const l = latest.get(c.provider);
        return { ...c, lastModel: l?.lastModel ?? null, lastAt: l?.lastAt ?? null };
      }),
    };
  }

  /** GET /api/ai/status：脱敏配置（旧字段指向生效厂商）+ 多厂商列表 + 本账号用量。 */
  async status(userId: string) {
    const cfg = await this.resolveActiveConfig(userId);
    const rows = await this.tenant.forUser(userId).listAiUsage();
    const { configs, activeProvider } = await this.listConfigs(userId);
    const configuredLevel = !cfg ? 'none' : cfg.models.fast && cfg.models.strong ? 'full' : 'partial';
    return {
      ...publicConfig(cfg),
      configuredLevel,
      activeProvider,
      configs,
      nodeVersion: process.version,
      usage: this.summarize(rows),
      hint: cfg ? '' : '尚未配置模型：填写 baseUrl、apiKey 与 models.fast 后即可使用。',
    };
  }

  /**
   * GET /api/ai/usage：账号级用量对账（0020）。
   * range = 7d / 30d / all，映射到明细表的时间下界；返回全局汇总 + 按厂商/模型聚合 + 按日趋势。
   * 数据源是 append-only 的 ai_usage_events 明细，保证 token 精确累加、可逐厂商/模型对账。
   */
  async usageStats(userId: string, range: string = '30d') {
    const since = range === 'all' ? null : range === '7d' ? new Date(Date.now() - 7 * 86400_000) : new Date(Date.now() - 30 * 86400_000);
    const rows = await this.tenant.forUser(userId).listAiUsageEvents(since);

    let requests = 0;
    let errors = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalLatencyMs = 0;
    let latencyCount = 0;

    const byProvider = new Map<string, { requests: number; errors: number; promptTokens: number; completionTokens: number; latencyMs: number; latencyCount: number; lastAt: string | null }>();
    const byModel = new Map<string, { provider: string | null; requests: number; errors: number; promptTokens: number; completionTokens: number; latencyMs: number; latencyCount: number; lastAt: string | null }>();
    const byDay = new Map<string, { requests: number; errors: number; promptTokens: number; completionTokens: number }>();

    for (const r of rows) {
      const err = r.status === 'error' ? 1 : 0;
      const pt = r.promptTokens ?? 0;
      const ct = r.completionTokens ?? 0;
      const at = r.createdAt ? r.createdAt.toISOString() : null;

      requests += 1;
      errors += err;
      totalPromptTokens += pt;
      totalCompletionTokens += ct;
      if (typeof r.latencyMs === 'number' && r.latencyMs > 0) {
        totalLatencyMs += r.latencyMs;
        latencyCount += 1;
      }

      // 厂商维度
      const pkey = r.provider || '(未记录)';
      const pb = byProvider.get(pkey) ?? { requests: 0, errors: 0, promptTokens: 0, completionTokens: 0, latencyMs: 0, latencyCount: 0, lastAt: null };
      pb.requests += 1;
      pb.errors += err;
      pb.promptTokens += pt;
      pb.completionTokens += ct;
      if (typeof r.latencyMs === 'number' && r.latencyMs > 0) { pb.latencyMs += r.latencyMs; pb.latencyCount += 1; }
      if (!pb.lastAt && at) pb.lastAt = at;
      byProvider.set(pkey, pb);

      // 模型维度
      const mkey = r.model || '(未记录)';
      const mb = byModel.get(mkey) ?? { provider: r.provider ?? null, requests: 0, errors: 0, promptTokens: 0, completionTokens: 0, latencyMs: 0, latencyCount: 0, lastAt: null };
      mb.requests += 1;
      mb.errors += err;
      mb.promptTokens += pt;
      mb.completionTokens += ct;
      if (typeof r.latencyMs === 'number' && r.latencyMs > 0) { mb.latencyMs += r.latencyMs; mb.latencyCount += 1; }
      if (!mb.lastAt && at) mb.lastAt = at;
      byModel.set(mkey, mb);

      // 日维度
      const dkey = r.createdAt ? r.createdAt.toISOString().slice(0, 10) : '(未知)';
      const db = byDay.get(dkey) ?? { requests: 0, errors: 0, promptTokens: 0, completionTokens: 0 };
      db.requests += 1;
      db.errors += err;
      db.promptTokens += pt;
      db.completionTokens += ct;
      byDay.set(dkey, db);
    }

    const fmt = (m: Map<string, any>) =>
      [...m.entries()]
        .map(([key, v]) => ({
          key,
          requests: v.requests,
          errors: v.errors,
          promptTokens: v.promptTokens,
          completionTokens: v.completionTokens,
          avgLatencyMs: v.latencyCount ? Math.round(v.latencyMs / v.latencyCount) : null,
          lastAt: v.lastAt,
          ...(v.provider !== undefined ? { provider: v.provider } : {}),
        }))
        .sort((a, b) => b.requests - a.requests);

    return {
      range,
      since: since ? since.toISOString() : null,
      totals: {
        requests,
        errors,
        errorRate: requests ? Number(((errors / requests) * 100).toFixed(1)) : 0,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        totalTokens: totalPromptTokens + totalCompletionTokens,
        avgLatencyMs: latencyCount ? Math.round(totalLatencyMs / latencyCount) : null,
      },
      providers: fmt(byProvider),
      models: fmt(byModel),
      days: [...byDay.entries()].map(([day, v]) => ({ day, ...v })).sort((a, b) => (a.day < b.day ? -1 : 1)),
    };
  }

  /**
   * PUT /api/ai/config 与 PUT /api/ai/config/:provider：全量校验后 upsert 到指定厂商。
   * provider 来源优先级：URL 参数 > patch.provider > deriveProviderSlug(baseUrl)。
   * apiKey 留空沿用旧值（优先同厂商旧值，其次当前生效厂商旧值）。首行配置自动设为生效。
   */
  async saveConfig(userId: string, provider: string | undefined, patch: ConfigPatch) {
    const fromUrl = String(provider ?? '').trim();
    const fromPatch = String(patch.provider ?? '').trim();
    const targetProvider = fromUrl || fromPatch || deriveProviderSlug(patch.baseUrl);

    const rows = await this.tenant.forUser(userId).getAiConfigs();
    const existingRow = rows.find((r) => r.provider === targetProvider) || null;
    const activeRow = rows.find((r) => r.isActive) || null;
    const existing = existingRow
      ? this.toRuntime(existingRow)
      : activeRow
        ? this.toRuntime(activeRow)
        : null;

    const norm = normalizeConfig({ ...patch, provider: targetProvider }, existing);
    if (norm.ok === false) throw new AiProxyError(400, norm.error, 'INVALID_CONFIG');

    const isActive = existingRow ? !!existingRow.isActive : !activeRow;
    await this.tenant.forUser(userId).upsertAiConfig({ ...norm.value, isActive });
    // 保留旧 PUT /api/ai/config 的响应契约（configured/model/source/hasApiKey），并新增 isActive。
    return { ...publicConfig({ ...norm.value, source: 'database' }), isActive };
  }

  /** POST /api/ai/config/:provider/activate：切换生效厂商（需先保存有效 baseUrl + apiKey）。 */
  async setActive(userId: string, provider: string) {
    const rows = await this.tenant.forUser(userId).getAiConfigs();
    const target = rows.find((r) => r.provider === provider);
    if (!target || !target.baseUrl || !target.apiKey) {
      throw new AiProxyError(400, '该服务商尚未保存有效配置（需 baseUrl 与 apiKey）', 'INVALID_CONFIG');
    }
    await this.tenant.forUser(userId).setActiveProvider(provider);
    return { ok: true, activeProvider: provider };
  }

  /** DELETE /api/ai/config/:provider：删除该厂商行；删生效厂商后不自动提拔（回空态）。 */
  async deleteConfig(userId: string, provider: string) {
    await this.tenant.forUser(userId).deleteAiConfig(provider);
    return { ok: true, provider };
  }

  /**
   * POST /api/ai/models：拉取上游模型列表，供前端下拉选择（避免手抄模型 id 出错）。
   * baseUrl / apiKey 可来自请求体（用户尚未保存的临时值），留空则用已保存配置。
   * 安全：baseUrl 恒走 validateBaseUrl（SSRF 硬边界）；apiKey 只在本次请求内存里使用，
   * 不落库、不写日志、不回传。
   */
  async listModels(userId: string, input: { baseUrl?: unknown; apiKey?: unknown } = {}) {
    const saved = await this.resolveConfig(userId);
    const baseRaw = String(input.baseUrl ?? '').trim() || saved?.baseUrl || '';
    const keyRaw = String(input.apiKey ?? '').trim() || saved?.apiKey || '';

    if (!baseRaw) throw new AiProxyError(400, '请先填写上游地址 baseUrl', 'INVALID_CONFIG');
    const check = validateBaseUrl(baseRaw);
    if (check.ok === false) throw new AiProxyError(400, check.reason || '上游地址非法', 'INVALID_BASE_URL');
    if (!keyRaw) {
      throw new AiProxyError(
        400,
        '请先填写 apiKey（留空表示沿用已保存的 Key，但当前没有已保存的 Key）',
        'INVALID_CONFIG'
      );
    }

    const cfg: AiRuntimeConfig = {
      provider: saved?.provider || 'openai-compatible',
      baseUrl: baseRaw.replace(/\/+$/, ''),
      apiKey: keyRaw,
      models: {},
      temperature: saved?.temperature ?? 0.4,
      timeoutMs: saved?.timeoutMs ?? 60000,
      source: 'database',
    };

    try {
      const res = await this.http.listModels(cfg, { connectTimeoutMs: cfg.timeoutMs });
      const models = parseModelIds(res.text);
      if (!models.length) {
        throw new AiProxyError(502, '上游未返回可识别的模型列表', 'UPSTREAM_ERROR');
      }
      return { ok: true, count: models.length, models };
    } catch (e) {
      // 部分服务商不提供 /models：把 404 换成更可操作的提示，引导用户手动填写模型 ID。
      if (e instanceof AiProxyError && e.code === 'MODEL_NOT_FOUND') {
        throw new AiProxyError(400, '该服务商未提供 /models 列表接口，请手动填写模型 ID', 'MODEL_NOT_FOUND');
      }
      throw e;
    }
  }

  /** DELETE /api/ai/config：清空账号配置（删除当前生效厂商行，回空态；不自动提拔其他厂商）。 */
  async clearConfig(userId: string) {
    const active = (await this.tenant.forUser(userId).getActiveAiConfig())[0];
    if (active) {
      await this.tenant.forUser(userId).deleteAiConfig(active.provider);
    }
    return { ok: true, configured: false };
  }

  /** 对单个模型做「连通 + json_object」能力探活，返回 AiCapability。 */
  private async probeModel(
    userId: string,
    cfg: AiRuntimeConfig,
    modelId: string
  ): Promise<{ cap: AiCapability; sample?: string }> {
    const t0 = Date.now();
    let sample: string | undefined;
    try {
      const ping = await this.completeWith(userId, cfg, {
        messages: [{ role: 'user', content: 'ping（用一个字回答）' }],
        max_tokens: 8,
        model: modelId,
        action: 'test',
      });
      sample = ping.text.slice(0, 120);
    } catch (e) {
      return { cap: { model: modelId, reachable: false, latencyMs: Date.now() - t0, error: toAiError(e) }, sample: undefined };
    }
    const latencyMs = Date.now() - t0;

    // json_object 能力：发一次带 response_format 的最小请求；若被 400 且报 response_format 即判不支持。
    let supportsJsonObject: boolean | undefined;
    try {
      await this.completeWith(userId, cfg, {
        messages: [{ role: 'user', content: '返回 JSON：{"ok":true}' }],
        max_tokens: 16,
        model: modelId,
        action: 'test',
        responseFormat: 'json_object',
      });
      supportsJsonObject = true;
    } catch (e) {
      const err = toAiError(e);
      supportsJsonObject = err.code === 'BAD_REQUEST' && /response_format/i.test(err.message) ? false : undefined;
    }
    return {
      cap: { model: modelId, reachable: true, supportsJsonObject, supportsStream: undefined, latencyMs },
      sample,
    };
  }

  /** POST /api/ai/test：能力探活（保持旧字段 ok/latencyMs/model/sample 的 200 契约）。传 provider 时探活指定厂商。 */
  async test(userId: string, provider?: string): Promise<{ ok: boolean; error?: string } | AiTestResult> {
    let cfg: AiRuntimeConfig | null;
    if (provider) {
      const rows = await this.tenant.forUser(userId).getAiConfigs();
      const row = rows.find((r) => r.provider === provider);
      cfg = row && row.baseUrl && row.apiKey ? this.toRuntime(row) : null;
      if (!cfg) return { ok: false, error: `服务商 ${provider} 尚未保存有效配置（需 baseUrl 与 apiKey）` };
    } else {
      cfg = await this.resolveActiveConfig(userId);
    }
    if (!cfg) return { ok: false, error: 'AI 未配置：请填写 baseUrl、apiKey 与 models.fast' };

    const fastModel = cfg.models.fast || cfg.models.strong || '';
    const strongModel = cfg.models.strong || '';

    const fastProbe = fastModel
      ? await this.probeModel(userId, cfg, fastModel)
      : { cap: this.emptyCapability(fastModel), sample: undefined };
    const strongProbe = strongModel
      ? await this.probeModel(userId, cfg, strongModel)
      : { cap: this.emptyCapability(strongModel), sample: undefined };

    return {
      ok: fastProbe.cap.reachable,
      model: fastProbe.cap.model,
      latencyMs: fastProbe.cap.latencyMs,
      sample: fastProbe.sample,
      capabilities: { fast: fastProbe.cap, strong: strongProbe.cap },
    };
  }

  private emptyCapability(model: string): AiCapability {
    return {
      model,
      reachable: false,
      latencyMs: 0,
      error: { code: 'INVALID_CONFIG', message: '未配置该档位的模型', retryable: false },
    };
  }

  /**
   * POST /api/ai/chat：拿到上游 SSE Response 交给 controller 透传。
   * 这里不做 hijack，保持「服务层可单测、控制器管 HTTP」的分工。
   */
  async openChat(userId: string, body: any): Promise<ChatOpened> {
    const cfg = await this.resolveConfig(userId);
    if (!cfg) throw new AiProxyError(400, 'AI 未配置：请先在账号与设置里保存 baseUrl、apiKey 与 models.fast', 'INVALID_CONFIG');
    const built = buildChatPayload(cfg, body || {}, true);
    if (built.ok === false) throw new AiProxyError(400, built.error, 'BAD_REQUEST');

    const t0 = Date.now();
    let upstream: Response;
    try {
      upstream = await this.http.openStream(cfg, built.payload, {
        connectTimeoutMs: cfg.timeoutMs,
        idleTimeoutMs: cfg.timeoutMs,
      });
    } catch (e) {
      await this.bump(userId, {
        action: 'chat',
        model: built.model,
        provider: cfg.provider,
        status: 'error',
        errorCode: errCode(e),
        latencyMs: Date.now() - t0,
      });
      throw e;
    }
    await this.bump(userId, {
      action: 'chat',
      model: built.model,
      provider: cfg.provider,
      status: 'ok',
      latencyMs: Date.now() - t0,
    });
    return { upstream, model: built.model, cfg };
  }

  /**
   * 非流式补全（Agent 编排层专用）：发一次请求，把上游返回体完整读出来，
   * 返回纯文本。与 openChat 的区别是不做 SSE 透传，而是缓冲后 return。
   *  - 未配置 AI 时抛 AiProxyError(400, INVALID_CONFIG)，调用方据此走降级路径；
   *  - responseFormat 传 'json_object' 可强制 JSON 输出（parse-jd 用）；
   *  - action 用于选择 fast/strong 档位（见 MODEL_USAGE_MAP）与用量归因。
   */
  async complete(
    userId: string,
    body: {
      messages?: unknown;
      model?: unknown;
      temperature?: unknown;
      max_tokens?: unknown;
      response_format?: unknown;
      responseFormat?: 'json_object' | null;
      action?: unknown;
    }
  ): Promise<{ text: string; model: string; latencyMs: number; usage?: { promptTokens?: number; completionTokens?: number } }> {
    const cfg = await this.resolveActiveConfig(userId);
    if (!cfg) throw new AiProxyError(400, 'AI 未配置：请先在账号与设置里保存 baseUrl、apiKey 与 models.fast', 'INVALID_CONFIG');
    return this.completeWith(userId, cfg, body);
  }

  /** 用指定厂商配置做一次非流式补全（complete 与指定厂商探活共用）。 */
  private async completeWith(
    userId: string,
    cfg: AiRuntimeConfig,
    body: {
      messages?: unknown;
      model?: unknown;
      temperature?: unknown;
      max_tokens?: unknown;
      response_format?: unknown;
      responseFormat?: 'json_object' | null;
      action?: unknown;
    }
  ): Promise<{ text: string; model: string; latencyMs: number; usage?: { promptTokens?: number; completionTokens?: number } }> {
    const action = typeof body.action === 'string' ? body.action : 'complete';
    const tier = modelTierForAction(action);
    const defaultModel =
      tier === 'strong' ? cfg.models.strong || cfg.models.fast : cfg.models.fast || cfg.models.strong;
    const explicitModel = typeof body.model === 'string' ? body.model.trim() : '';
    const bodyWithModel = { ...body, model: explicitModel || defaultModel };

    const built = buildChatPayload(cfg, bodyWithModel, false, { responseFormat: body.responseFormat });
    if (built.ok === false) throw new AiProxyError(400, built.error, 'BAD_REQUEST');

    const t0 = Date.now();
    let result: AiCompleteResult;
    try {
      result = await this.http.complete(cfg, built.payload, { connectTimeoutMs: cfg.timeoutMs });
    } catch (e) {
      await this.bump(userId, {
        action,
        model: built.model,
        provider: cfg.provider,
        status: 'error',
        errorCode: errCode(e),
        latencyMs: Date.now() - t0,
      });
      throw e;
    }
    const latencyMs = Date.now() - t0;
    const usage = extractUsage(result.text);
    await this.bump(userId, {
      action,
      model: built.model,
      provider: cfg.provider,
      status: 'ok',
      latencyMs,
      tokens: usage,
    });
    return { text: extractContent(result.text), model: built.model, latencyMs, usage };
  }
}
