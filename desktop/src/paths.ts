import path from 'node:path';

/**
 * 桌面端所有路径的唯一入口（纯函数，便于单测）。
 *
 * 打包后 app 目录（Contents/Resources/app 或 win-unpacked/resources/app）是只读的，
 * 所有构建产物（dist-server / dist-web / legacy / drizzle / desktop）都放在这里；
 * 用户数据必须写到 app.getPath('userData')，绝不写进安装目录。
 *
 * 之所以不用 asar：PGlite 的 wasm/data 与 @node-rs/argon2 的 .node 都要求真实文件路径，
 * 且内嵌服务进程需要按普通 Node 规则解析 app 目录下的 node_modules。
 */
export interface DesktopPaths {
  /** 应用根目录，构建产物都在它下面。 */
  appRoot: string;
  /** 用户可写数据根目录（下挂 pgdata/ 与 blobs/）。 */
  dataDir: string;
  webDir: string;
  migrationsDir: string;
  legacyRoot: string;
  /** 编译后的 Nest 入口（dist-server/server/main.js）。 */
  serverMain: string;
  setupHtml: string;
  utilityEntry: string;
  preload: string;
}

export function resolveDesktopPaths(input: { appRoot: string; userData: string }): DesktopPaths {
  const appRoot = path.resolve(input.appRoot);
  const distMain = path.join(appRoot, 'desktop', 'dist-main');
  return {
    appRoot,
    dataDir: path.join(path.resolve(input.userData), 'data'),
    webDir: path.join(appRoot, 'dist-web'),
    migrationsDir: path.join(appRoot, 'drizzle'),
    legacyRoot: path.join(appRoot, 'legacy'),
    serverMain: path.join(appRoot, 'dist-server', 'server', 'main.js'),
    setupHtml: path.join(appRoot, 'desktop', 'setup.html'),
    utilityEntry: path.join(distMain, 'server-entry.js'),
    preload: path.join(distMain, 'preload.js'),
  };
}

/**
 * 内嵌服务进程的环境变量。刻意剔除开发态开关，避免用户机器上的
 * DEV_SKIP_AUTH / DB_CLIENT_PORT 之类的全局环境变量把安装包带偏。
 */
export function serverEnvironment(
  paths: DesktopPaths,
  inherited: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inherited };
  delete env.DEV_SKIP_AUTH;
  delete env.DB_CLIENT_PORT;
  delete env.PORT;
  delete env.CHROME_PATH;
  delete env.CAREER_AGENT_DESKTOP_DEV;
  delete env.CAREER_AGENT_DESKTOP_URL;
  // utility process 必须是正常 Electron 进程（process.parentPort 才存在）；
  // 采集脚本需要 Node 模式时由 collect.service.ts 自己给子进程加这个变量。
  delete env.ELECTRON_RUN_AS_NODE;

  env.CAREER_AGENT_DESKTOP = '1';
  env.CAREER_AGENT_APP_ROOT = paths.appRoot;
  env.CAREER_AGENT_DATA_DIR = paths.dataDir;
  env.CAREER_AGENT_MIGRATIONS_DIR = paths.migrationsDir;
  env.CAREER_AGENT_WEB_DIR = paths.webDir;
  env.CAREER_AGENT_SETUP_HTML = paths.setupHtml;
  env.LEGACY_ROOT = paths.legacyRoot;
  // 采集脚本在 Electron 里需要拿应用可执行文件当 Node 解释器用。
  env.CAREER_AGENT_NODE_BIN = process.execPath;
  return env;
}
