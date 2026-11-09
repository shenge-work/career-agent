/**
 * 从 npm script 启动 Electron 的跨平台包装器。
 *
 * 宿主环境（例如某些 IDE / Electron 工具的集成终端）可能全局设置了
 * ELECTRON_RUN_AS_NODE=1，这会让 Electron 二进制退化成纯 Node，主进程里 app 为 undefined。
 * 这里显式剔除该变量再 spawn 真正的二进制；打包后用户双击启动不经过本脚本。
 */
const { spawn } = require('node:child_process');

let electronPath;
try {
  // electron 包在普通 Node 下导出的是可执行文件绝对路径
  electronPath = require('electron');
} catch (err) {
  console.error('[desktop] 无法定位 Electron 二进制，请先 npm install：', err);
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = ['.'].concat(process.argv.slice(2));
const child = spawn(electronPath, args, {
  env,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('error', (err) => {
  console.error('[desktop] Electron 启动失败:', err);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) console.warn(`[desktop] Electron 被信号终止: ${signal}`);
  process.exit(code === null ? 1 : code);
});
