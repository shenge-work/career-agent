import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB_TOKEN, ROLES, type Role } from '../../shared/constants';
import { SessionsService } from '../auth/sessions.service';
import { hashPassword } from '../auth/password';
import type { Database } from '../db/client';
import { users } from '../db/schema';

@Injectable()
export class UsersService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    @Inject(SessionsService) private readonly sessions: SessionsService
  ) {}

  /** 永不返回 password_hash。 */
  list() {
    return this.db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        status: users.status,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .orderBy(users.createdAt);
  }

  async create(input: { email: string; password: string; role?: Role; displayName?: string | null }) {
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BadRequestException('邮箱格式不正确');
    if (input.password.length < 8) throw new BadRequestException('密码至少 8 位');
    const role = input.role || 'member';
    if (!ROLES.includes(role)) throw new BadRequestException('role 只能是 admin 或 member');

    const existing = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing.length) throw new ConflictException('该邮箱已存在');

    const passwordHash = await hashPassword(input.password);
    const [row] = await this.db
      .insert(users)
      .values({ email, passwordHash, role, displayName: input.displayName || null })
      .returning({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        status: users.status,
      });
    return row;
  }

  async disable(id: string) {
    const rows = await this.db
      .update(users)
      .set({ status: 'disabled' })
      .where(eq(users.id, id))
      .returning({ id: users.id });
    if (!rows.length) throw new NotFoundException('账号不存在');
    await this.sessions.revokeAllForUser(id);
    return { ok: true };
  }
}
