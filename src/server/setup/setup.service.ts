import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { DB_TOKEN } from '../../shared/constants';
import { hashPassword } from '../auth/password';
import type { Database } from '../db/client';
import { users } from '../db/schema';

/**
 * 首次运行初始化：本地应用第一次启动时库里没有账号，登录页无法进入。
 *
 * 这个入口等价于 CLI `npm run seed:user` 的图形化版本，但只在「一个账号都没有」
 * 时开放；请求还必须通过 main.ts 的回环 Host/Origin 守卫。安装包是单人本机使用，
 * 因此不会引入比 CLI 更大的攻击面。
 */
@Injectable()
export class SetupService {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  async needsSetup(): Promise<boolean> {
    const rows = await this.db.select({ id: users.id }).from(users).limit(1);
    return rows.length === 0;
  }

  async bootstrap(input: { email: string; password: string; displayName?: string | null }) {
    // 先判空再写。已有账号后初始化入口永久关闭，避免被人拿来提权建 admin。
    if (!(await this.needsSetup())) {
      throw new ConflictException('已存在账号，初始化入口已关闭');
    }

    const email = String(input?.email || '').trim().toLowerCase();
    const password = String(input?.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new BadRequestException('邮箱格式不正确');
    }
    if (password.length < 8) throw new BadRequestException('密码至少 8 位');

    const passwordHash = await hashPassword(password);
    const [row] = await this.db
      .insert(users)
      .values({
        email,
        passwordHash,
        role: 'admin',
        displayName: input?.displayName ? String(input.displayName).slice(0, 100) : null,
      })
      .returning({ id: users.id, email: users.email, role: users.role });
    return { user: row };
  }
}
