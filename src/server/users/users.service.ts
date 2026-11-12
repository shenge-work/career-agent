import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB_TOKEN } from '../../shared/constants';
import { hashPassword } from '../auth/password';
import type { Database } from '../db/client';
import { users } from '../db/schema';

/**
 * 账号服务：只负责「创建一个独立账号」。
 *
 * 去角色化后不再有 list()（跨账号视图）与 disable()（停用他人账号）——
 * 这两者是旧「成员管理」模型的核心能力，已随管理员概念一并移除。
 * users.role 物理列保留以兼容存量数据，但本服务从不读写它。
 */
@Injectable()
export class UsersService {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  async create(input: { email: string; password: string; displayName?: string | null }) {
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BadRequestException('邮箱格式不正确');
    if (input.password.length < 8) throw new BadRequestException('密码至少 8 位');

    const existing = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing.length) throw new ConflictException('该邮箱已存在');

    const passwordHash = await hashPassword(input.password);
    const [row] = await this.db
      .insert(users)
      .values({
        email,
        passwordHash,
        displayName: input.displayName || null,
        status: 'active',
      })
      .returning({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
      });
    return row;
  }
}
