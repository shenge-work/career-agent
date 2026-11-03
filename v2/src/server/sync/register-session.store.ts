import crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';

/**
 * 飞书「个人应用」扫码注册（Device Flow）的会话存储。
 *
 * v1 把会话放 serve.js 进程内存（registerSessions Map），v2 沿用内存方案：
 * 二维码几分钟内扫完，重启服务丢会话可接受（v1 同款语义）。
 * 与 v1 的关键差异：会话绑定 userId —— poll 时校验「会话属于当前账号」，
 * A 发起的注册二维码不能写进 B 的凭证库。
 */
export interface RegisterSession {
  userId: string;
  deviceCode: string;
  domain: string;
  larkDomain: string;
  domainSwitched: boolean;
  /** 轮询间隔（秒），slow_down 时 +5 */
  interval: number;
  /** 有效期（秒） */
  expiresIn: number;
  createdAt: number;
  lastPollAt: number;
  lastResult: { status: string; appId?: string; appSecret?: string; error?: string; error_description?: string } | null;
}

const TERMINAL = new Set(['success', 'failed', 'expired']);

@Injectable()
export class RegisterSessionStore {
  private readonly sessions = new Map<string, RegisterSession>();

  create(userId: string, init: Omit<RegisterSession, 'userId' | 'createdAt' | 'lastPollAt' | 'lastResult' | 'domainSwitched'>): string {
    const token = crypto.randomBytes(16).toString('hex');
    this.sessions.set(token, {
      ...init,
      userId,
      domainSwitched: false,
      createdAt: Date.now(),
      lastPollAt: 0,
      lastResult: { status: 'waiting' },
    });
    return token;
  }

  /** 只把属于当前用户的会话给出去；别人的 token 一律当作不存在（不泄露存在性）。 */
  find(token: string, userId: string): RegisterSession | null {
    const s = this.sessions.get(token);
    if (!s || s.userId !== userId) return null;
    // 超出 expires_in + 60s 缓冲即视为过期（v1 同款判定）
    if (Date.now() - s.createdAt > (s.expiresIn + 60) * 1000) {
      this.sessions.delete(token);
      return null;
    }
    return s;
  }

  isTerminal(s: RegisterSession): boolean {
    return !!(s.lastResult && TERMINAL.has(s.lastResult.status));
  }

  /** 语义上的过期（会话仍在 Map 里，但二维码有效期已过）。 */
  isExpired(s: RegisterSession): boolean {
    return Date.now() - s.createdAt > (s.expiresIn + 60) * 1000;
  }

  delete(token: string) {
    this.sessions.delete(token);
  }
}
