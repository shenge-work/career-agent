import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import * as schema from './schema';
import { readBridgePort, startPgClientBridge, type PgClientBridge } from './client-bridge';

export type Database = PgliteDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  /** 原始 PGlite 客户端，DDL / 迁移走它（drizzle 的 query builder 不做建表）。 */
  client: any;
  close: () => Promise<void>;
  /** 仅设置 DB_CLIENT_PORT 时存在：给 DBeaver / psql 等用的本地协议桥（默认 null）。 */
  bridge: PgClientBridge | null;
}

/**
 * dataDir 为空 = 内存库（测试用）；传路径 = 落盘到该目录（生产用）。
 * PGlite 同时提供 ESM / CJS 入口，静态 import 在 ts-node(commonjs) 与 Vite SSR 下都能解析。
 * PGlite 是 PostgreSQL 的 WASM 构建，方言与真 PG 一致，后期换 node-postgres 只改这里。
 *
 * DB_CLIENT_PORT 是可选的开发者开关：设置后在 127.0.0.1 上挂一个 wire protocol 桥，
 * 让主流 PG 客户端能直连同一个库实例；默认（未设置）完全不监听端口，行为与原来一致。
 */
export async function createDatabase(dataDir?: string): Promise<DbHandle> {
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  await client.waitReady;
  const db = drizzle(client, { schema }) as Database;

  let bridge: PgClientBridge | null = null;
  const port = readBridgePort();
  if (port !== null) {
    try {
      bridge = await startPgClientBridge(client, port);
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
  }

  let closed = false;
  return {
    db,
    client,
    bridge,
    close: async () => {
      if (closed) return;
      closed = true;
      if (bridge) await bridge.stop();
      await client.close();
    },
  };
}
