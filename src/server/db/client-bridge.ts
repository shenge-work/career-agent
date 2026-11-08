import type { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

/**
 * 可选的 PostgreSQL wire protocol 桥：让 DBeaver / pgAdmin / DataGrip / TablePlus / psql
 * 等主流客户端能直连应用进程内的 PGlite 实例，查看（并修改）本地数据。
 *
 * 设计约束：
 * - 默认完全不启动；只有显式设置 DB_CLIENT_PORT 才生效。
 * - 只绑 127.0.0.1，绝不接受 0.0.0.0，与 security.ts 的回环安全模型一致。
 * - 复用同一个 PGlite 实例，因此 GUI 的写入是实时的，也会绕过 TenantDb 行级隔离，
 *   属于「开发者/排查模式」能力，不应在面向普通用户的安装包里默认开启。
 */

export const BRIDGE_HOST = '127.0.0.1';
/** 允许少量并发连接以适配 GUI 客户端的元数据连接；底层仍由查询队列串行执行。 */
const BRIDGE_MAX_CONNECTIONS = 4;

export interface PgClientBridge {
  host: string;
  /** 实际监听端口（port=0 时为系统分配值）。 */
  port: number;
  /** 可直接粘进客户端的连接串。 */
  connectionString: string;
  stop: () => Promise<void>;
}

/**
 * 解析开关。未设置 / 空值 = 关闭；0 = 由系统分配空闲端口；1-65535 = 指定端口。
 * 非法值直接抛错，避免「以为开了桥却连不上」的静默降级。
 */
export function readBridgePort(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.DB_CLIENT_PORT;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`DB_CLIENT_PORT 必须是 0-65535 的整数（0 = 自动分配），当前值：${text}`);
  }
  const port = Number(text);
  if (port > 65535) {
    throw new Error(`DB_CLIENT_PORT 超出范围（0-65535）：${text}`);
  }
  return port;
}

/** getServerConn() 返回 "127.0.0.1:5432"；port=0 时是系统实际分配后的端口。 */
function parseActualPort(serverConn: string): number {
  const idx = serverConn.lastIndexOf(':');
  const port = idx >= 0 ? Number(serverConn.slice(idx + 1)) : NaN;
  if (!Number.isInteger(port) || port < 1) {
    throw new Error(`无法解析 PG 客户端桥的实际端口：${serverConn}`);
  }
  return port;
}

/** 启动桥。失败时抛出明确错误（端口占用 / 权限问题），由调用方决定是否阻断启动。 */
export async function startPgClientBridge(client: PGlite, port: number): Promise<PgClientBridge> {
  const server = new PGLiteSocketServer({
    db: client,
    port,
    host: BRIDGE_HOST,
    maxConnections: BRIDGE_MAX_CONNECTIONS,
  });

  try {
    await server.start();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `PG 客户端桥无法监听 ${BRIDGE_HOST}:${port === 0 ? '自动端口' : port}（${detail}）。` +
        `请更换 DB_CLIENT_PORT，或留空以关闭该桥。`
    );
  }

  const actualPort = parseActualPort(server.getServerConn());
  const connectionString = `postgresql://postgres@${BRIDGE_HOST}:${actualPort}/postgres`;

  console.log(`[PG 客户端桥] 已开启 → ${connectionString}`);
  console.log('  客户端须关闭 SSL：psql 用 PGSSLMODE=disable；DBeaver / pgAdmin 里 SSL mode 选 disable');
  console.log('  DBeaver 建议关闭「为元数据读取单独打开连接」，连接数不超过 4');
  console.log('  注意：该端口可读写全部账号数据且绕过应用层隔离，仅限本机调试，勿在共享网络暴露');

  let stopped = false;
  return {
    host: BRIDGE_HOST,
    port: actualPort,
    connectionString,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await server.stop();
    },
  };
}
