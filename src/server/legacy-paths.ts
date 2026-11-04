import fs from 'node:fs';
import path from 'node:path';

/**
 * legacy 渲染资产目录定位（CDP 采集脚本等非渲染模块使用）。
 *
 * v1 已退役：渲染引擎资产（8 个 JS + style.css + vendor 截图库 + boss-collect）
 * 收编进项目内 `legacy/` 目录，不再是「另一个项目的仓库根」。
 * 与 render/legacy-renderer.ts 的探测条件保持一致，但独立实现：
 * 采集模块不应该为了拿一个路径去 import 整个渲染器（vm 沙箱、CSS 缓存都在那个模块里）。
 */
export function findLegacyRoot(explicit: string | undefined = process.env.LEGACY_ROOT): string | null {
  if (explicit) {
    const r = path.resolve(explicit);
    return fs.existsSync(path.join(r, 'js/render/resume-render.js')) ? r : null;
  }
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const cand = path.join(dir, 'legacy');
    if (fs.existsSync(path.join(cand, 'js/render/resume-render.js'))) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 返回 legacy 资产目录里的绝对路径；找不到时返回 null。 */
export function legacyPath(...segments: string[]): string | null {
  const root = findLegacyRoot();
  return root ? path.join(root, ...segments) : null;
}
