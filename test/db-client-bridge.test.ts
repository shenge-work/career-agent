import 'reflect-metadata';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import {
  BRIDGE_HOST,
  readBridgePort,
  startPgClientBridge,
  type PgClientBridge,
} from '../src/server/db/client-bridge';
import { createDatabase, type DbHandle } from '../src/server/db/client';

let bridge: PgClientBridge | null = null;
let raw: PGlite | null = null;
let handle: DbHandle | null = null;

afterEach(async () => {
  if (bridge) {
    await bridge.stop();
    bridge = null;
  }
  if (handle) {
    await handle.close();
    handle = null;
  }
  if (raw) {
    await raw.close();
    raw = null;
  }
});

/** 端口不再监听时，connect 会立刻 ECONNREFUSED。 */
function portRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, BRIDGE_HOST);
    socket.setTimeout(2000);
    socket.once('error', () => resolve(true));
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

describe('PG 客户端桥（DB_CLIENT_PORT）', () => {
  it('默认关闭，空值也视为关闭', () => {
    expect(readBridgePort({})).toBeNull();
    expect(readBridgePort({ DB_CLIENT_PORT: '' })).toBeNull();
    expect(readBridgePort({ DB_CLIENT_PORT: '   ' })).toBeNull();
  });

  it('0 表示自动分配，非法值明确报错', () => {
    expect(readBridgePort({ DB_CLIENT_PORT: '0' })).toBe(0);
    expect(readBridgePort({ DB_CLIENT_PORT: '55432' })).toBe(55432);
    expect(() => readBridgePort({ DB_CLIENT_PORT: 'abc' })).toThrow(/DB_CLIENT_PORT/);
    expect(() => readBridgePort({ DB_CLIENT_PORT: '-1' })).toThrow(/DB_CLIENT_PORT/);
    expect(() => readBridgePort({ DB_CLIENT_PORT: '70000' })).toThrow(/DB_CLIENT_PORT/);
  });

  it('createDatabase 未设置开关时不挂桥，且 close 幂等', async () => {
    handle = await createDatabase();
    expect(handle.bridge).toBeNull();
    await handle.close();
    await handle.close();
    handle = null;
  });

  it('设置开关后由 createDatabase 挂桥，close 会释放端口', async () => {
    const prev = process.env.DB_CLIENT_PORT;
    process.env.DB_CLIENT_PORT = '0';
    try {
      handle = await createDatabase();
      expect(handle.bridge).not.toBeNull();
      const active = handle.bridge!;
      expect(active.port).toBeGreaterThan(0);

      const client = new pg.Client({
        connectionString: active.connectionString,
        connectionTimeoutMillis: 5000,
        ssl: false,
      });
      await client.connect();
      const res = await client.query('SELECT 1 AS ok');
      expect(res.rows[0].ok).toBe(1);
      await client.end();

      const port = active.port;
      await handle.close();
      handle = null;
      expect(await portRefused(port)).toBe(true);
    } finally {
      if (handle) {
        await handle.close();
        handle = null;
      }
      if (prev === undefined) delete process.env.DB_CLIENT_PORT;
      else process.env.DB_CLIENT_PORT = prev;
    }
  });

  it('真实 PG 客户端能读表、写数据，且与应用内实例实时共享', async () => {
    raw = new PGlite();
    await raw.waitReady;
    await raw.exec(
      `CREATE TABLE bridge_probe (id int primary key, note text);
       INSERT INTO bridge_probe VALUES (1, 'hello'), (2, '世界');`
    );

    bridge = await startPgClientBridge(raw, 0);
    expect(bridge.host).toBe(BRIDGE_HOST);
    expect(bridge.port).toBeGreaterThan(0);
    expect(bridge.connectionString).toBe(
      `postgresql://postgres@${BRIDGE_HOST}:${bridge.port}/postgres`
    );

    const client = new pg.Client({
      connectionString: bridge.connectionString,
      connectionTimeoutMillis: 5000,
      ssl: false,
    });
    await client.connect();
    try {
      const rows = await client.query('SELECT id, note FROM bridge_probe ORDER BY id');
      expect(rows.rows).toEqual([
        { id: 1, note: 'hello' },
        { id: 2, note: '世界' },
      ]);

      const catalog = await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'bridge_probe'"
      );
      expect(catalog.rowCount).toBe(1);

      await client.query("INSERT INTO bridge_probe VALUES (3, 'from-client')");
      const viaApp = await raw.query<{ n: number }>('SELECT count(*)::int AS n FROM bridge_probe');
      expect(viaApp.rows[0].n).toBe(3);
    } finally {
      await client.end();
    }

    const port = bridge.port;
    await bridge.stop();
    bridge = null;
    expect(await portRefused(port)).toBe(true);
  });
});
