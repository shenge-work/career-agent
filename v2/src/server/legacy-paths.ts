import fs from 'node:fs';
import path from 'node:path';

/**
 * v1 仓库根目录定位（AI 配置回退、CDP 采集脚本都用它）。
 *
 * 与 render/legacy-renderer.ts 的探测条件一致，但独立实现：AI / 采集模块
 * 不应该为了拿一个路径去 import 整个渲染器（vm 沙箱、CSS 缓存都在那个模块里）。
 * 同时兼容 ts-node 源码目录（v2/src/server）与 tsc 产物（v2/dist-server/server）。
 */
export function findLegacyRoot(explicit: string | undefined = process.env.LEGACY_ROOT): string | null {
  const candidates = explicit
    ? [path.resolve(explicit)]
    : [
        path.resolve(__dirname, '../../..'),
        path.resolve(process.cwd(), '..'),
        path.resolve(process.cwd()),
      ];
  for (const root of candidates) {
    if (
      fs.existsSync(path.join(root, 'js/render/resume-render.js')) ||
      fs.existsSync(path.join(root, 'tools/serve.js'))
    ) {
      return root;
    }
  }
  return null;
}

/** 返回 v1 仓库里的绝对路径；找不到根目录时返回 null。 */
export function legacyPath(...segments: string[]): string | null {
  const root = findLegacyRoot();
  return root ? path.join(root, ...segments) : null;
}

/** 只读 JSON 配置，文件缺失/损坏一律返回 null，绝不抛给请求链路。 */
export function readLegacyJson(filename: string, explicit?: string): Record<string, any> | null {
  const file = explicit || legacyPath(filename);
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
