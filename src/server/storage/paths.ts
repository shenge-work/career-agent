import path from 'node:path';

/**
 * 本地安装包的数据目录（唯一入口）。
 *
 * 开发态沿用历史约定：PGDATA 默认 ./pgdata，blobs/ 与它并列。
 * 打包态请设置 CAREER_AGENT_DATA_DIR 到**用户可写的绝对路径**
 * （macOS ~/Library/Application Support/CareerAgent、Windows %APPDATA%\CareerAgent）——
 * 绝不能落在 .app bundle / Program Files 里（签名只读、写入要管理员权限）。
 *
 * 优先级：显式 PGDATA > CAREER_AGENT_DATA_DIR/pgdata > ./pgdata。
 */
export interface DataDirs {
  /** 数据根目录，备份 / 卸载 / 导出只需拷这个目录。 */
  root: string;
  pgdata: string;
  blobs: string;
}

export function resolveDataDirs(env: NodeJS.ProcessEnv = process.env): DataDirs {
  const explicitRoot = env.CAREER_AGENT_DATA_DIR
    ? path.resolve(env.CAREER_AGENT_DATA_DIR)
    : null;
  const pgdata = env.PGDATA
    ? path.resolve(env.PGDATA)
    : explicitRoot
      ? path.join(explicitRoot, 'pgdata')
      : path.resolve('./pgdata');
  const blobs = explicitRoot
    ? path.join(explicitRoot, 'blobs')
    : path.join(path.dirname(pgdata), 'blobs');
  return { root: explicitRoot ?? path.dirname(pgdata), pgdata, blobs };
}
