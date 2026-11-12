import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB_TOKEN, type CurrentUser } from '../../shared/constants';
import type { Database } from '../db/client';
import { users } from '../db/schema';
import { LoginThrottle } from './login-throttle.service';
import { verifyPassword } from './password';
import { SessionsService, type SessionMeta } from './sessions.service';
import { hashToken, newSessionToken } from './tokens';

export interface LoginResult {
  user: CurrentUser;
  token: string;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(LoginThrottle) private readonly throttle: LoginThrottle
  ) {}

  async login(email: string, password: string, meta: SessionMeta = {}): Promise<LoginResult> {
    // 回环下所有请求 ip 均为 127.0.0.1，限流 key 只用 email（见 login-throttle 注释）。
    const key = email.toLowerCase();
    this.throttle.assertAllowed(key);

    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);
    const row = rows[0];

    const ok =
      !!row &&
      row.status === 'active' &&
      (await verifyPassword(row.passwordHash, password));
    if (!ok) {
      this.throttle.recordFailure(key);
      throw new UnauthorizedException('邮箱或密码不正确');
    }

    this.throttle.reset(key);
    const token = newSessionToken();
    await this.sessions.create(row.id, hashToken(token), meta);
    await this.sessions.touchLogin(row.id);

    const user: CurrentUser = {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
    };
    return { user, token };
  }

  async logout(tokenHash: string): Promise<void> {
    await this.sessions.revoke(tokenHash);
  }

  /**
   * 开发阶段免登录：跳过密码校验，直接以库内账号建立会话。
   * 账号一律平等，不再有「优先选 admin」的概念：优先 DEV_USER_EMAIL，否则取首个账号。
   * 仅当 DEV_SKIP_AUTH=true 时可用，生产构建（start）不设置该变量，接口恒返回 401。
   * 仍会写入真实 user_id，因此下游 TenantDb.forUser 照常生效。
   */
  async devLogin(): Promise<LoginResult> {
    if (process.env.DEV_SKIP_AUTH !== 'true') {
      throw new UnauthorizedException('开发免登录未启用');
    }
    const targetEmail = (process.env.DEV_USER_EMAIL || '').trim().toLowerCase();
    let row: (typeof users.$inferSelect) | undefined;
    if (targetEmail) {
      const r = await this.db.select().from(users).where(eq(users.email, targetEmail)).limit(1);
      row = r[0];
    } else {
      row = (await this.db.select().from(users).limit(1))[0];
    }
    if (!row || row.status !== 'active') {
      throw new BadRequestException('开发免登录失败：库内没有可用账号，请先 npm run seed:user');
    }

    const token = newSessionToken();
    await this.sessions.create(row.id, hashToken(token), { userAgent: 'dev-bypass', ip: '' });
    await this.sessions.touchLogin(row.id);

    const user: CurrentUser = {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
    };
    return { user, token };
  }
}
