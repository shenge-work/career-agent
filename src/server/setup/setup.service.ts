import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB_TOKEN } from '../../shared/constants';
import { hashPassword } from '../auth/password';
import type { Database } from '../db/client';
import { users } from '../db/schema';

/**
 * 首次运行初始化 + 本地自助建号的图形化入口。
 *
 * 与 CLI `npm run seed:user`、登录页「创建新账号」等价，三者创建出的账号一律平等：
 * 不写入任何角色、不建立任何隶属或管理关系。
 *
 * `needsSetup()` 仅用于桌面端判断「库里还没有账号 → 打开首启向导」；
 * `bootstrap()` 不再限制「只能建一次」，因为取消管理员后必须允许持续创建
 * 互相独立的账号。请求仍受 main.ts 的回环 Host/Origin 守卫保护。
 */
@Injectable()
export class SetupService {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  async needsSetup(): Promise<boolean> {
    const rows = await this.db.select({ id: users.id }).from(users).limit(1);
    return rows.length === 0;
  }

  async bootstrap(input: { email: string; password: string; displayName?: string | null }) {
    const email = String(input?.email || '').trim().toLowerCase();
    const password = String(input?.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new BadRequestException('邮箱格式不正确');
    }
    if (password.length < 8) throw new BadRequestException('密码至少 8 位');

    const existing = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing.length) throw new ConflictException('该邮箱已存在，请直接登录');

    const passwordHash = await hashPassword(password);
    const [row] = await this.db
      .insert(users)
      .values({
        email,
        passwordHash,
        displayName: input?.displayName ? String(input.displayName).slice(0, 100) : null,
      })
      .returning({ id: users.id, email: users.email });
    return { user: row };
  }
}
