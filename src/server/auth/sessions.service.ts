import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { DB_TOKEN, SESSION_TTL_HOURS, type CurrentUser } from '../../shared/constants';
import type { Database } from '../db/client';
import { sessions, users } from '../db/schema';

export interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

@Injectable()
export class SessionsService {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  async create(userId: string, tokenHash: string, meta: SessionMeta = {}): Promise<void> {
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000);
    await this.db.insert(sessions).values({
      userId,
      tokenHash,
      expiresAt,
      userAgent: meta.userAgent || null,
      ip: meta.ip || null,
    });
  }

  /** 一次性校验 token 有效性 + 账号仍启用，并把用户身份带出来（不含任何角色信息）。 */
  async resolveUser(tokenHash: string): Promise<CurrentUser | null> {
    const rows = await this.db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date()),
          eq(users.status, 'active')
        )
      )
      .limit(1);
    if (!rows.length) return null;
    const r = rows[0];
    return {
      id: r.id,
      email: r.email,
      displayName: r.displayName,
    };
  }

  async revoke(tokenHash: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(eq(sessions.tokenHash, tokenHash));
  }

  /** 改密码/重置凭据时，把该用户所有在线会话一次性踢掉。 */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  }

  async touchLogin(userId: string): Promise<void> {
    await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  }
}
