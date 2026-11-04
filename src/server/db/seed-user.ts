import { eq } from 'drizzle-orm';
import { hashPassword } from '../auth/password';
import { ROLES, type Role } from '../../shared/constants';
import { createDatabase } from './client';
import { applyMigrations } from './migrate';
import { users } from './schema';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const email = (arg('email') || '').trim().toLowerCase();
  const password = arg('password') || '';
  const role = (arg('role') || 'member') as Role;
  const displayName = (arg('name') || '').trim() || null;

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('用法: npm run seed:user -- --email a@b.com --password 至少8位 [--role admin|member] [--name 显示名]');
  }
  if (password.length < 8) throw new Error('密码至少 8 位');
  if (!ROLES.includes(role)) throw new Error('role 只能是 admin 或 member');

  const { db, client, close } = await createDatabase(process.env.PGDATA || './pgdata');
  try {
    await applyMigrations(client);
    const passwordHash = await hashPassword(password);
    const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing.length) {
      await db
        .update(users)
        .set({ passwordHash, role, status: 'active', displayName })
        .where(eq(users.id, existing[0].id));
      console.log(`已更新账号: ${email} (${role})`);
    } else {
      const [row] = await db
        .insert(users)
        .values({ email, passwordHash, role, displayName })
        .returning({ id: users.id });
      console.log(`已创建账号: ${email} (${role}) id=${row.id}`);
    }
  } finally {
    await close();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[seed:user] 失败:', e.message || e);
    process.exit(1);
  });
}
