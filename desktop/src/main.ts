/**
 * CareerAgent 桌面客户端主进程。
 *
 * 职责边界：只管窗口、菜单、单实例和内嵌服务的生命周期；
 * 业务数据与鉴权仍全部由 127.0.0.1 上的 NestJS 服务负责，前端代码零改动。
 */
import {
  app,
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  ipcMain,
  shell,
  utilityProcess,
  type MenuItemConstructorOptions,
  type UtilityProcess,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDesktopPaths, serverEnvironment, type DesktopPaths } from './paths';

const DEFAULT_DEV_URL = 'http://127.0.0.1:5173';
const devShell = process.argv.includes('--desktop-dev');
const smoke = process.argv.includes('--smoke');

let paths: DesktopPaths;
let baseUrl = DEFAULT_DEV_URL;
let serverChild: UtilityProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;

function computePaths(): DesktopPaths {
  // dist-main/ 恒在 <appRoot>/desktop/ 下，打包态与非打包态结构一致。
  const appRoot = path.resolve(__dirname, '../..');
  return resolveDesktopPaths({ appRoot, userData: app.getPath('userData') });
}

/** 启动内嵌服务并等待它回报真实监听端口。 */
function startEmbeddedServer(): Promise<number> {
  const env = serverEnvironment(paths, process.env);
  const child = utilityProcess.fork(paths.utilityEntry, [], {
    env,
    serviceName: 'career-agent-server',
  });
  serverChild = child;

  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('内嵌服务启动超时（60 秒），请检查数据目录权限'));
    }, 60_000);

    child.on('message', (raw: any) => {
      const msg = raw?.data ?? raw;
      if (settled) return;
      if (msg?.type === 'ready') {
        settled = true;
        clearTimeout(timer);
        resolve(Number(msg.port));
      } else if (msg?.type === 'error') {
        settled = true;
        clearTimeout(timer);
        reject(new Error(String(msg.message || '内嵌服务启动失败')));
      }
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`内嵌服务意外退出（code=${code}）`));
    });
  });
}

/** 先请求服务优雅关闭（Nest close → PGlite 落盘），超时再强杀。 */
async function stopEmbeddedServer(): Promise<void> {
  const child = serverChild;
  if (!child) return;
  serverChild = null;
  try {
    child.postMessage({ type: 'shutdown' });
  } catch {
    /* 进程可能已经退出 */
  }
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish();
    }, 5000);
    child.once('exit', finish);
  });
}

function registerIpc(): void {
  ipcMain.handle('desktop:info', () => ({
    platform: process.platform,
    appVersion: app.getVersion(),
    electron: (process.versions as any).electron,
    node: process.versions.node,
    dataDir: paths.dataDir,
    baseUrl,
  }));
  ipcMain.handle('desktop:open-data-dir', () => shell.openPath(paths.dataDir));
  ipcMain.handle('desktop:copy-address', () => {
    clipboard.writeText(baseUrl);
    return baseUrl;
  });
}

function buildMenu(): void {
  const macAppMenu: MenuItemConstructorOptions[] =
    process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : [];

  const template: MenuItemConstructorOptions[] = [
    ...macAppMenu,
    {
      label: '文件',
      submenu: [
        {
          label: '打开数据目录…',
          click: () => void shell.openPath(paths.dataDir),
        },
        {
          label: '复制本地服务地址',
          click: () => clipboard.writeText(baseUrl),
        },
        { type: 'separator' },
        { role: 'quit', label: '退出 CareerAgent' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 CareerAgent',
          click: () => {
            app.setAboutPanelOptions({
              applicationName: 'CareerAgent',
              applicationVersion: app.getVersion(),
              version: process.versions.electron,
              credits: '本地优先的求职工作台，数据只保存在这台电脑。',
            });
            app.showAboutPanel();
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function initialPath(): Promise<string> {
  if (devShell) return '/';
  try {
    const res = await fetch(`${baseUrl}/api/setup/status`);
    if (res.ok) {
      const body = (await res.json()) as { needsSetup?: boolean };
      if (body.needsSetup) return '/__desktop/setup';
    }
  } catch {
    /* 服务刚起来，直接进主页面由前端自行报错/重试 */
  }
  return '/';
}

async function createWindow(initial: string): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'CareerAgent',
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      preload: paths.preload,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  mainWindow = win;

  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) {
      return { action: 'allow' };
    }
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  await win.loadURL(baseUrl + initial);
  return win;
}

/** 无人值守自检：不创建窗口，验证内嵌服务 + SPA + 向导页都 reachable。 */
async function runSmoke(): Promise<void> {
  const targets = ['/api/setup/status', '/', '/__desktop/setup'];
  const results = await Promise.all(
    targets.map(async (p) => {
      try {
        const res = await fetch(baseUrl + p);
        return { p, status: res.status };
      } catch (err) {
        return { p, status: `ERR ${String((err as Error).message || err)}` };
      }
    })
  );
  const ok = results.every((r) => typeof r.status === 'number' && r.status >= 200 && r.status < 400);
  console.log('[smoke] ' + results.map((r) => `${r.p} → ${r.status}`).join(' | '));
  await stopEmbeddedServer();
  app.exit(ok ? 0 : 1);
}

async function bootstrap(): Promise<void> {
  paths = computePaths();
  fs.mkdirSync(paths.dataDir, { recursive: true });
  registerIpc();
  buildMenu();

  if (devShell) {
    baseUrl = process.env.CAREER_AGENT_DESKTOP_URL || DEFAULT_DEV_URL;
  } else {
    const port = await startEmbeddedServer();
    baseUrl = `http://127.0.0.1:${port}`;
  }

  if (smoke) {
    await runSmoke();
    return;
  }
  await createWindow(await initialPath());
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(bootstrap).catch((err) => {
    const message = String((err as Error)?.stack || err);
    console.error('[desktop] 启动失败:', message);
    if (smoke) {
      app.exit(1);
      return;
    }
    dialog.showErrorBox('CareerAgent 启动失败', message);
    app.exit(1);
  });

  app.on('before-quit', (event) => {
    if (quitting || !serverChild) return;
    event.preventDefault();
    quitting = true;
    void stopEmbeddedServer().finally(() => app.exit(0));
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow('/');
  });
}
