import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Injectable, NotFoundException } from '@nestjs/common';
import { legacyPath, findLegacyRoot } from '../legacy-paths';
import { TenantDb } from '../tenant/tenant-db';

export interface CollectedMessage {
  role: 'me' | 'hr' | 'sys';
  name: string;
  text: string;
  ts: number | null;
  timeText: string;
  source: 'cdp';
}

export interface CollectResult {
  ok: boolean;
  added: number;
  total: number;
  hint: string;
  title?: string;
  url?: string;
  company?: string;
}

interface ScriptOutput {
  ok?: boolean;
  messages?: unknown[];
  hint?: string;
  title?: string;
  url?: string;
  company?: string;
}

const DEFAULT_TIMEOUT_MS = 25000; // boss-collect.js 自身 20s + 4s hardTimer，留 1s 余量
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_MESSAGES = 500;
const MAX_TEXT = 4000;

/** 纯函数：归一化脚本输出的消息，丢弃非法项，绝不把任意字段写进库。 */
export function normalizeMessages(raw: unknown[]): CollectedMessage[] {
  const out: CollectedMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const text = String(m.text ?? '').trim();
    if (!text || text.length > MAX_TEXT) continue;
    const role = m.role === 'me' || m.role === 'sys' ? m.role : 'hr';
    out.push({
      role,
      name: String(m.name ?? '').trim().slice(0, 100),
      text,
      ts: typeof m.ts === 'number' && Number.isFinite(m.ts) ? m.ts : null,
      timeText: String(m.timeText ?? '').trim().slice(0, 100),
      source: 'cdp',
    });
    if (out.length >= MAX_MESSAGES) break;
  }
  return out;
}

function chatKey(m: { role?: unknown; text?: unknown; ts?: unknown; timeText?: unknown }): string {
  return [
    String(m.role ?? ''),
    String(m.text ?? '').trim(),
    String(m.ts ?? m.timeText ?? ''),
  ].join('\u0001');
}

function looseKey(m: { role?: unknown; text?: unknown }): string {
  return String(m.role ?? '') + '\u0001' + String(m.text ?? '').trim();
}

/**
 * 纯函数：把采集消息并入已有聊天，返回新数组与新增条数。
 *
 * 与 v1 的差别：v1 每次采集都整批 push，重复点击就翻倍；这里按
 * 「role + text + 时间戳」精确去重，另外用「role + text」宽松匹配
 * 早期 seed.json 导入的无时间戳消息。宽松集合只从既有消息构建，
 * 因此同一次采集里 HR 连发两句相同文本不会被误合并。
 */
export function mergeChat(
  existing: unknown[],
  incoming: CollectedMessage[]
): { chat: unknown[]; added: number } {
  const base = Array.isArray(existing) ? existing.filter((x) => x && typeof x === 'object') : [];
  const exact = new Set(base.map((m: any) => chatKey(m)));
  const loose = new Set(base.map((m: any) => looseKey(m)));
  const toAdd = incoming.filter((m) => !exact.has(chatKey(m)) && !loose.has(looseKey(m)));
  return { chat: base.concat(toAdd), added: toAdd.length };
}

@Injectable()
export class CollectService {
  constructor(private readonly tenant: TenantDb) {}

  /** 前端用来显示脚本是否可用与默认调试端口，不主动连 CDP。 */
  status() {
    const script = this.scriptPath();
    return {
      scriptAvailable: !!script && fs.existsSync(script),
      defaultPort: Number(process.env.CDP_PORT) || 9222,
      hint: script
        ? '需要先用你的登录档案启动 Chrome 并开启远程调试端口，再打开 BOSS 直聘聊天页。'
        : '未找到 tools/boss-collect.js（可设置 LEGACY_ROOT 指向项目内 legacy 资产目录）。',
    };
  }

  private scriptPath(): string | null {
    const override = process.env.BOSS_COLLECT_SCRIPT;
    if (override) return path.resolve(override);
    return legacyPath('tools', 'boss-collect.js');
  }

  private runScript(script: string, args: string[]): Promise<ScriptOutput | null> {
    const timeoutMs = Number(process.env.COLLECT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(process.execPath, [script, ...args], {
          cwd: findLegacyRoot() || process.cwd(),
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        resolve(null);
        return;
      }
      let out = '';
      let err = '';
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: ScriptOutput | null) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* noop */
        }
        finish({ ok: false, messages: [], hint: `采集超时（${timeoutMs}ms）。请确认 Chrome 远程调试端口可用。` });
      }, timeoutMs);
      child.stdout.on('data', (d: Buffer) => {
        if (out.length < MAX_OUTPUT) out += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        if (err.length < 64 * 1024) err += d.toString();
      });
      child.on('error', () => finish({ ok: false, messages: [], hint: '采集脚本启动失败。' }));
      child.on('close', () => {
        const parsed = tryParseJson(out) || tryParseJson(err);
        finish(parsed);
      });
    });
  }

  /**
   * 采集并直接写库：替代 v1 的「种子包」通道（截图 → seed.json → 前端 localStorage 幂等并入）。
   * v2 的投递记录就在数据库里，服务端可以一步完成去重与落盘。
   */
  async collect(
    userId: string,
    body: { trackerId?: unknown; port?: unknown; url?: unknown }
  ): Promise<CollectResult> {
    const trackerId = String(body.trackerId ?? '').trim();
    if (!trackerId || trackerId.length > 200) {
      return { ok: false, added: 0, total: 0, hint: '缺少 trackerId' };
    }
    const rows = await this.tenant.forUser(userId).getTracker(trackerId);
    if (!rows.length) throw new NotFoundException('投递记录不存在');
    const row = rows[0];
    const payload = (row.payload || {}) as Record<string, any>;
    const company = String(payload.company || '').trim().slice(0, 100);

    const port = Number(body.port || process.env.CDP_PORT || 9222);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, added: 0, total: 0, hint: 'CDP 端口必须是 1~65535 的整数' };
    }
    const url = String(body.url ?? '').trim();
    if (url && (url.length > 500 || !/^https?:\/\//i.test(url))) {
      return { ok: false, added: 0, total: 0, hint: 'url 必须是合法的 http(s) 地址' };
    }

    const script = this.scriptPath();
    if (!script) {
      return { ok: false, added: 0, total: 0, hint: this.status().hint };
    }
    const args = ['--port', String(port), '--company', company];
    if (url) args.push('--url', url);
    const output = await this.runScript(script, args);
    if (!output) {
      return { ok: false, added: 0, total: 0, hint: '采集脚本无有效输出。' };
    }
    const messages = normalizeMessages(Array.isArray(output.messages) ? output.messages : []);
    const currentChat = Array.isArray(payload.chat) ? payload.chat : [];
    const { chat, added } = mergeChat(currentChat, messages);
    if (added > 0) {
      await this.tenant
        .forUser(userId)
        .updateTracker(trackerId, { payload: { ...payload, chat } });
    }
    return {
      ok: !!output.ok && added > 0,
      added,
      total: chat.length,
      hint:
        added > 0
          ? `已采集并入库 ${added} 条新消息（重复项已跳过）。`
          : messages.length === 0
            ? String(output.hint || '未采集到聊天记录。')
            : '本次没有新消息（采集到的内容都已存在）。',
      title: String(output.title || ''),
      url: String(output.url || ''),
      company,
    };
  }
}

function tryParseJson(text: string): ScriptOutput | null {
  if (!text.trim()) return null;
  try {
    const obj = JSON.parse(text.trim());
    return obj && typeof obj === 'object' ? (obj as ScriptOutput) : null;
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1)) as ScriptOutput;
    } catch {
      return null;
    }
  }
}
