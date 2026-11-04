import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import * as schema from './schema';

export type Database = PgliteDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  /** 原始 PGlite 客户端，DDL / 迁移走它（drizzle 的 query builder 不做建表）。 */
  client: any;
  close: () => Promise<void>;
}

/**
 * dataDir 为空 = 内存库（测试用）；传路径 = 落盘到该目录（生产用）。
 * PGlite 同时提供 ESM / CJS 入口，静态 import 在 ts-node(commonjs) 与 Vite SSR 下都能解析。
 * PGlite 是 PostgreSQL 的 WASM 构建，方言与真 PG 一致，后期换 node-postgres 只改这里。
 */
export async function createDatabase(dataDir?: string): Promise<DbHandle> {
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  await client.waitReady;
  const db = drizzle(client, { schema }) as Database;
  return {
    db,
    client,
    close: () => client.close(),
  };
}
