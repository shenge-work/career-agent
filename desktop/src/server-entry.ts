/**
 * Electron utility process：在本机回环上跑完整的 NestJS + PGlite 服务。
 *
 * 与主进程分开是为了不让 PGlite 的 WASM 计算卡住 UI 线程；
 * 端口用 listen(0) 由系统分配，再通过 parentPort 回传给主进程，
 * 因此永远不会和用户已有的 3000 端口冲突。
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDesktopPaths } from './paths';
import { registerStaticRoutes } from './static';

interface ParentPortLike {
  postMessage: (message: unknown) => void;
  on: (event: 'message', listener: (event: any) => void) => void;
}

const parentPort: ParentPortLike | undefined = (process as any).parentPort;

function post(message: unknown): void {
  if (parentPort?.postMessage) parentPort.postMessage(message);
}

interface Runtime {
  webDir: string;
  setupHtml: string;
  migrationsDir: string;
  legacyRoot: string;
  serverMain: string;
  dataDir: string;
}

function runtimeFromEnv(): Runtime {
  // 主进程把算好的绝对路径放进 env；没有时（手工 node 运行）按目录结构自行推导。
  const appRoot = path.resolve(
    process.env.CAREER_AGENT_APP_ROOT || path.resolve(__dirname, '../..')
  );
  const fallback = resolveDesktopPaths({
    appRoot,
    userData: path.join(appRoot, '.desktop-userdata'),
  });
  return {
    webDir: process.env.CAREER_AGENT_WEB_DIR || fallback.webDir,
    setupHtml: process.env.CAREER_AGENT_SETUP_HTML || fallback.setupHtml,
    migrationsDir: process.env.CAREER_AGENT_MIGRATIONS_DIR || fallback.migrationsDir,
    legacyRoot: process.env.LEGACY_ROOT || fallback.legacyRoot,
    serverMain: path.join(appRoot, 'dist-server', 'server', 'main.js'),
    dataDir: process.env.CAREER_AGENT_DATA_DIR || fallback.dataDir,
  };
}

async function main(): Promise<void> {
  const rt = runtimeFromEnv();

  // 服务端模块在运行时读这些 env（migrationsDir / findLegacyRoot / resolveDataDirs），
  // 必须在 require(main.js) 之前补齐并写回 process.env。
  process.env.CAREER_AGENT_DATA_DIR = rt.dataDir;
  process.env.CAREER_AGENT_MIGRATIONS_DIR = rt.migrationsDir;
  process.env.CAREER_AGENT_WEB_DIR = rt.webDir;
  process.env.CAREER_AGENT_SETUP_HTML = rt.setupHtml;
  process.env.LEGACY_ROOT = rt.legacyRoot;

  fs.mkdirSync(rt.dataDir, { recursive: true });
  if (!fs.existsSync(rt.serverMain)) {
    throw new Error(`未找到服务端构建产物：${rt.serverMain}（请先执行 npm run build）`);
  }
  if (!fs.existsSync(path.join(rt.webDir, 'index.html'))) {
    throw new Error(`未找到前端构建产物：${rt.webDir}/index.html（请先执行 npm run build）`);
  }
  const hasMigrations =
    fs.existsSync(rt.migrationsDir) &&
    fs.readdirSync(rt.migrationsDir).some((f) => f.endsWith('.sql'));
  if (!hasMigrations) {
    throw new Error(`迁移目录缺少 SQL 文件：${rt.migrationsDir}`);
  }

  const { createServerApp } = require(rt.serverMain) as {
    createServerApp: () => Promise<any>;
  };
  const app = await createServerApp();
  const fastify = app.getHttpAdapter().getInstance();
  registerStaticRoutes(fastify, { webDir: rt.webDir, setupHtml: rt.setupHtml });

  await app.listen(0, '127.0.0.1');
  const address = fastify.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  if (!port) throw new Error('无法确定内嵌服务监听端口');

  post({ type: 'ready', port, dataDir: rt.dataDir });
  console.log(`[desktop] CareerAgent 内嵌服务 → http://127.0.0.1:${port}`);
  console.log(`[desktop] 数据目录: ${rt.dataDir}`);

  if (parentPort?.on) {
    parentPort.on('message', async (event: any) => {
      const message = event?.data ?? event;
      if (message?.type !== 'shutdown') return;
      // 先让 Nest 正常 close（PGlite 落盘），再退出进程；主进程有超时 kill 兜底。
      try {
        await app.close();
      } catch (err) {
        console.warn('[desktop] 关闭服务时出错:', err);
      }
      process.exit(0);
    });
  }
}

main().catch((err) => {
  const message = String((err as Error)?.stack || err);
  console.error('[desktop] 内嵌服务启动失败:', message);
  post({ type: 'error', message });
  process.exit(1);
});
