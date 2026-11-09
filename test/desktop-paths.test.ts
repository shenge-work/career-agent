import 'reflect-metadata';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDesktopPaths, serverEnvironment } from '../desktop/src/paths';
import { mimeFor, resolveStaticFile } from '../desktop/src/static';
import { migrationsDir } from '../src/server/db/migrate';

describe('桌面端 · 路径与环境', () => {
  const winRoot = path.resolve('C:/apps/CareerAgent/resources/app');
  const userData = path.resolve('C:/Users/qing/AppData/Roaming/CareerAgent');

  it('构建产物全部落在只读 app 根，用户数据落在 userData/data', () => {
    const p = resolveDesktopPaths({ appRoot: winRoot, userData });
    expect(p.appRoot).toBe(winRoot);
    expect(p.dataDir).toBe(path.join(userData, 'data'));
    for (const key of ['webDir', 'migrationsDir', 'legacyRoot', 'serverMain', 'setupHtml', 'utilityEntry', 'preload'] as const) {
      expect(path.resolve(p[key]).startsWith(winRoot + path.sep)).toBe(true);
    }
    expect(p.serverMain).toBe(path.join(winRoot, 'dist-server', 'server', 'main.js'));
    expect(p.utilityEntry).toBe(path.join(winRoot, 'desktop', 'dist-main', 'server-entry.js'));
  });

  it('内嵌服务 env 指向正确的资源目录，并剔除开发态开关', () => {
    const p = resolveDesktopPaths({ appRoot: winRoot, userData });
    const env = serverEnvironment(p, {
      DEV_SKIP_AUTH: 'true',
      DB_CLIENT_PORT: '55432',
      PORT: '3000',
      CHROME_PATH: 'C:/old/chrome.exe',
      ELECTRON_RUN_AS_NODE: '1',
      PATH: 'C:/Windows',
    });
    expect(env.CAREER_AGENT_DATA_DIR).toBe(p.dataDir);
    expect(env.CAREER_AGENT_MIGRATIONS_DIR).toBe(p.migrationsDir);
    expect(env.CAREER_AGENT_WEB_DIR).toBe(p.webDir);
    expect(env.LEGACY_ROOT).toBe(p.legacyRoot);
    expect(env.CAREER_AGENT_DESKTOP).toBe('1');
    expect(env.CAREER_AGENT_NODE_BIN).toBeTruthy();
    for (const key of ['DEV_SKIP_AUTH', 'DB_CLIENT_PORT', 'PORT', 'CHROME_PATH', 'ELECTRON_RUN_AS_NODE']) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.PATH).toBe('C:/Windows');
  });

  it('迁移目录支持打包态显式覆盖', () => {
    expect(migrationsDir({ CAREER_AGENT_MIGRATIONS_DIR: '/opt/CareerAgent/drizzle' }))
      .toBe(path.resolve('/opt/CareerAgent/drizzle'));
    expect(migrationsDir({})).toBe(path.resolve(process.cwd(), 'drizzle'));
  });
});

describe('桌面端 · 静态托管', () => {
  const web = path.resolve('/srv/career-agent/dist-web');

  it('常规资源与根路径解析正确', () => {
    expect(resolveStaticFile(web, '/')).toBe(path.join(web, 'index.html'));
    expect(resolveStaticFile(web, '/assets/index-a1b2.js'))
      .toBe(path.join(web, 'assets', 'index-a1b2.js'));
    expect(resolveStaticFile(web, '/assets/logo.svg?v=1'))
      .toBe(path.join(web, 'assets', 'logo.svg'));
  });

  it('拒绝路径穿越、NUL 与坏编码', () => {
    expect(resolveStaticFile(web, '/../secret.txt')).toBeNull();
    expect(resolveStaticFile(web, '/%2e%2e/secret.txt')).toBeNull();
    expect(resolveStaticFile(web, '/assets/%00.js')).toBeNull();
    expect(resolveStaticFile(web, '/a\\..\\..\\secret')).toBeNull();
    expect(resolveStaticFile(web, '/%E0%A4%A')).toBeNull();
  });

  it('MIME 覆盖前端常见资源', () => {
    expect(mimeFor('a.html')).toContain('text/html');
    expect(mimeFor('a.js')).toContain('javascript');
    expect(mimeFor('a.css')).toContain('text/css');
    expect(mimeFor('a.svg')).toContain('image/svg+xml');
    expect(mimeFor('a.unknownext')).toBe('application/octet-stream');
  });
});
