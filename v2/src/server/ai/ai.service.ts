import { Injectable } from '@nestjs/common';
import { TenantDb } from '../tenant/tenant-db';
import {
  buildChatPayload,
  normalizeConfig,
  publicConfig,
  readLegacyConfig,
  upstreamUrl,
  type AiRuntimeConfig,
  type ConfigPatch,
} from './ai-config';

/** 上游失败需要把 HTTP 状态与错误码带给 controller，不在这里拼 Nest 响应。 */
export class AiProxyError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string | null = null
  ) {
    super(message);
  }
}

export interface ChatOpened {
  upstream: Response;
  model: string;
  cfg: AiRuntimeConfig;
}

@Injectable()
export class AiService {
  constructor(private readonly tenant: TenantDb) {}

  /** DB 配置优先；没有才只读回退 v1 ai.config.json。返回的对象永不出服务端。 */
  async resolveConfig(userId: string): Promise<AiRuntimeConfig | null> {
    const rows = await this.tenant.forUser(userId).getAiConfig();
    const row = rows[0];
    if (row) {
      if (!row.baseUrl || !row.apiKey) return null; // 显式清空 = 主动停用，不回退
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
    return readLegacyConfig(process.env.AI_CONFIG_FILE);
  }

  private async bump(userId: string, opts: { error?: boolean; model?: string | null }) {
    // 用量写失败不能影响主流程（本地库偶发写入竞争时尤其如此）
    try {
      await this.tenant.forUser(userId).bumpAiUsage(opts);
    } catch {
      /* noop */
    }
  }

  private summarize(rows: Array<{ day: string; requests: number; errors: number; lastAt: Date | null; lastModel: string | null }>) {
    const today = new Date().toLocaleDateString('sv-SE');
    const total = rows.reduce(
      (acc, r) => ({
        requests: acc.requests + (r.requests || 0),
        errors: acc.errors + (r.errors || 0),
      }),
      { requests: 0, errors: 0 }
    );
    const latest = [...rows].sort((a, b) => (b.lastAt?.getTime() || 0) - (a.lastAt?.getTime() || 0))[0];
    return {
      ...total,
      todayRequests: rows.find((r) => r.day === today)?.requests || 0,
      lastAt: latest?.lastAt || null,
      lastModel: latest?.lastModel || null,
      days: rows.slice(0, 7).map((r) => ({ day: r.day, requests: r.requests, errors: r.errors })),
    };
  }

  /** GET /api/ai/status：脱敏配置 + 本账号用量。 */
  async status(userId: string) {
    const cfg = await this.resolveConfig(userId);
    const rows = await this.tenant.forUser(userId).listAiUsage();
    return {
      ...publicConfig(cfg),
      nodeVersion: process.version,
      usage: this.summarize(rows),
      hint: cfg
        ? cfg.source === 'legacy-file'
          ? '当前使用 v1 的 ai.config.json（只读回退）；在下方保存配置后即切换为账号独立配置。'
          : ''
        : '尚未配置模型：填写 baseUrl、apiKey 与 models.fast 后即可使用。',
    };
  }

  /** PUT /api/ai/config：全量校验后 upsert；apiKey 留空沿用旧值。 */
  async saveConfig(userId: string, patch: ConfigPatch) {
    const current = await this.resolveConfig(userId);
    const norm = normalizeConfig(patch, current);
    if (norm.ok === false) throw new AiProxyError(400, norm.error);
    await this.tenant.forUser(userId).upsertAiConfig(norm.value);
    return publicConfig({ ...norm.value, source: 'database' });
  }

  /** DELETE /api/ai/config：清空账号配置（回到 v1 文件回退或停用）。 */
  async clearConfig(userId: string) {
    // 用空 baseUrl/apiKey 覆盖，保留行表示「显式停用」，避免又被旧文件悄悄接管。
    await this.tenant.forUser(userId).upsertAiConfig({
      provider: 'openai-compatible',
      baseUrl: '',
      apiKey: '',
      models: {},
      temperature: 0.4,
      timeoutMs: 60000,
    });
    return { ok: true, configured: false };
  }

  private async callUpstream(cfg: AiRuntimeConfig, payload: Record<string, unknown>): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
      return await fetch(upstreamUrl(cfg), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + cfg.apiKey,
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        throw new AiProxyError(504, `上游超时（${cfg.timeoutMs / 1000}s）`, 'TIMEOUT');
      }
      throw new AiProxyError(502, '上游请求失败：' + (e?.message || String(e)), e?.code || null);
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST /api/ai/test：非流式探活，返回与 v1 同构的结果。 */
  async test(userId: string) {
    const cfg = await this.resolveConfig(userId);
    if (!cfg) return { ok: false, error: 'AI 未配置：请填写 baseUrl、apiKey 与 models.fast' };
    const built = buildChatPayload(
      cfg,
      { messages: [{ role: 'user', content: 'ping（用一个字回答）' }], max_tokens: 8 },
      false
    );
    if (built.ok === false) return { ok: false, error: built.error };
    const t0 = Date.now();
    let upstream: Response;
    try {
      upstream = await this.callUpstream(cfg, built.payload);
    } catch (e) {
      await this.bump(userId, { error: true, model: built.model });
      return { ok: false, error: (e as Error).message, latencyMs: Date.now() - t0 };
    }
    const text = await upstream.text();
    const latencyMs = Date.now() - t0;
    if (!upstream.ok) {
      await this.bump(userId, { error: true, model: built.model });
      return { ok: false, status: upstream.status, error: text.slice(0, 300), latencyMs, model: built.model };
    }
    await this.bump(userId, { model: built.model });
    return { ok: true, latencyMs, model: built.model, sample: text.slice(0, 120) };
  }

  /**
   * POST /api/ai/chat：拿到上游 SSE Response 交给 controller 透传。
   * 这里不做 hijack，保持「服务层可单测、控制器管 HTTP」的分工。
   */
  async openChat(userId: string, body: any): Promise<ChatOpened> {
    const cfg = await this.resolveConfig(userId);
    if (!cfg) throw new AiProxyError(400, 'AI 未配置：请先在账号与设置里保存 baseUrl、apiKey 与 models.fast');
    const built = buildChatPayload(cfg, body || {}, true);
    if (built.ok === false) throw new AiProxyError(400, built.error);

    let upstream: Response;
    try {
      upstream = await this.callUpstream(cfg, built.payload);
    } catch (e) {
      await this.bump(userId, { error: true, model: built.model });
      throw e;
    }
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      await this.bump(userId, { error: true, model: built.model });
      throw new AiProxyError(
        upstream.status || 502,
        text.slice(0, 500) || '上游返回错误',
        String(upstream.status)
      );
    }
    await this.bump(userId, { model: built.model });
    return { upstream, model: built.model, cfg };
  }
}
