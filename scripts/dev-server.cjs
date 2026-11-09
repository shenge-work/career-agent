#!/usr/bin/env node
/**
 * 跨平台启动开发服务器。
 *
 * 背景：原来的 `"dev:server": "DEV_SKIP_AUTH=true ts-node ..."` 用的是 POSIX 的
 * 「环境变量前缀」语法。npm 在 Windows 上默认用 cmd.exe 执行 script，cmd 不认识
 * 这种写法，会把 `DEV_SKIP_AUTH=true` 当成一个可执行命令，直接报
 * "'DEV_SKIP_AUTH' 不是内部或外部命令"，导致 `npm run dev` 在 Windows 上跑不起来。
 *
 * 这里改用 Node 启动器：先设置环境变量，再以子进程方式调用 ts-node，
 * 不需要新增 cross-env 依赖，Windows / macOS / Linux 行为一致。
 *
 * 用法：node scripts/dev-server.cjs
 *   - 若要显式关闭跳过鉴权：DEV_SKIP_AUTH=false npm run dev
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const env = { ...process.env };

// 仅当调用方没有显式指定时才默认跳过鉴权，避免覆盖用户自己的设置
if (env.DEV_SKIP_AUTH === undefined || env.DEV_SKIP_AUTH === '') {
  env.DEV_SKIP_AUTH = 'true';
}

let tsNodeBin;
try {
  tsNodeBin = require.resolve('ts-node/dist/bin.js', { paths: [root] });
} catch {
  console.error('[dev-server] 找不到 ts-node，请先执行 npm install');
  process.exit(1);
}

const args = [tsNodeBin, '-r', 'tsconfig-paths/register', path.join('src', 'server', 'main.ts')];

const child = spawn(process.execPath, args, {
  cwd: root,
  env,
  stdio: 'inherit',
});

const signals = ['SIGINT', 'SIGTERM'];
for (const sig of signals) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
  });
}

child.on('error', (err) => {
  console.error('[dev-server] 启动失败：', err.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(0);
  }
  process.exit(code === null ? 0 : code);
});
