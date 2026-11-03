import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB_TOKEN, type CurrentUser, type Role } from '../../shared/constants';
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
    const key = `${email.toLowerCase()}|${meta.ip || ''}`;
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
      role: row.role as Role,
    };
    return { user, token };
  }

  async logout(tokenHash: string): Promise<void> {
    await this.sessions.revoke(tokenHash);
  }
}
