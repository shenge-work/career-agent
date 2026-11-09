import fs from 'node:fs';
import path from 'node:path';
import { createDatabase } from './client';
import { resolveDataDirs } from '../storage/paths';

export interface MigrationClient {
  exec: (sql: string) => Promise<any>;
  query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>;
}

/**
 * 迁移 SQL 目录。开发态是 `<cwd>/drizzle`；安装包里 drizzle/ 位于只读的 app 目录，
 * 由桌面端通过 CAREER_AGENT_MIGRATIONS_DIR 显式指过去（不能依赖安装包的 CWD）。
 */
export function migrationsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.CAREER_AGENT_MIGRATIONS_DIR || path.join(process.cwd(), 'drizzle'));
}

/**
 * 顺序应用 drizzle/*.sql，用 _migrations 表记录已应用的版本。
 * 不依赖 drizzle-kit 的在线连接（PGlite 是进程内库，没有 TCP 端点），
 * 但 SQL 由 drizzle-kit generate 产出/校验，方言与真 PG 一致。
 */
export async function applyMigrations(client: MigrationClient): Promise<string[]> {
  await client.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());'
  );
  const res = await client.query('SELECT name FROM _migrations');
  const applied = new Set<string>(res.rows.map((r) => String(r.name)));

  const dir = migrationsDir();
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    : [];

  const done: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    await client.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
    await client.query('INSERT INTO _migrations(name) VALUES ($1)', [file]);
    done.push(file);
  }
  return done;
}

async function main(): Promise<void> {
  const { pgdata, root } = resolveDataDirs();
  const { client, close } = await createDatabase(pgdata);
  try {
    const done = await applyMigrations(client);
    console.log(
      done.length ? `已应用迁移: ${done.join(', ')}` : '数据库已是最新，无待应用迁移'
    );
    console.log(`数据目录: ${root}（pgdata + blobs）`);
  } finally {
    await close();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[db:migrate] 失败:', e);
    process.exit(1);
  });
}
