import { contextBridge, ipcRenderer } from 'electron';

/**
 * 只暴露几个与「桌面壳」有关的能力，业务数据仍全部走 HTTP /api。
 * 不开放 fs / child_process / 任意 ipc 通道，渲染进程保持与浏览器版同等权限。
 */
contextBridge.exposeInMainWorld('careerAgentDesktop', {
  platform: process.platform,
  isDesktop: true,
  info: () => ipcRenderer.invoke('desktop:info'),
  openDataDir: () => ipcRenderer.invoke('desktop:open-data-dir'),
  copyLocalAddress: () => ipcRenderer.invoke('desktop:copy-address'),
});
