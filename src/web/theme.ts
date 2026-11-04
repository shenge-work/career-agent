/* =============================================================
 * 前端主题系统（UI Theme）
 * -------------------------------------------------------------
 * 主题 = 一组 CSS 变量（挂在 <html data-theme="..."> 上，见 styles.css）。
 * 这里维护「可注册主题」的元数据 + 应用/切换/持久化逻辑。
 *
 * 新增主题的步骤：
 *   1. 在 styles.css 加一个 `:root[data-theme='xxx'] { ... }` 变量块；
 *   2. 在下方 THEMES 数组里注册一条 { id, name, desc }；
 *   3. （可选）给 THEME_STORAGE_KEY 之外的持久化逻辑无需改动。
 * ============================================================= */

export interface UiTheme {
  id: string;
  name: string;
  desc: string;
  /** 是否为浅色（用于 UI 里展示预览底色，非强制） */
  light?: boolean;
}

export const THEMES: UiTheme[] = [
  { id: 'dark', name: '暗色 · Lessie', desc: '出厂默认，深色面板 + 高对比象牙白文字' },
  { id: 'light', name: '亮色 · 简洁', desc: '浅色背景 + 深色文字，适合白天阅读' },
];

const DEFAULT_THEME = 'dark';
const STORAGE_KEY = 'careeragent.theme';
const ATTR = 'data-theme';

/** 校验并归一化主题 id（未知值回退默认）。 */
export function resolveTheme(id: unknown): string {
  const s = String(id || '').trim();
  return THEMES.some((t) => t.id === s) ? s : DEFAULT_THEME;
}

/** 把主题应用到 <html>，返回实际生效的 id。 */
export function applyTheme(id: string): string {
  const resolved = resolveTheme(id);
  document.documentElement.setAttribute(ATTR, resolved);
  return resolved;
}

/** 从 localStorage 读缓存的偏好（未设则默认暗色）。 */
export function readCachedTheme(): string {
  try {
    return resolveTheme(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

/** 写 localStorage 缓存（不抛错，隐私模式下静默失败）。 */
export function cacheTheme(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, resolveTheme(id));
  } catch {
    /* ignore */
  }
}

/** 从服务端 settings 读主题偏好（settings.payload.theme）。 */
export function themeFromSettings(payload: Record<string, any> | undefined | null): string {
  return resolveTheme(payload?.theme);
}

/** 切换主题：应用 + 缓存，返回新主题 id。 */
export function switchTheme(id: string): string {
  const resolved = applyTheme(id);
  cacheTheme(resolved);
  return resolved;
}

/**
 * 启动时调用：先用 localStorage 缓存立刻应用（避免闪烁），
 * 等服务端 settings 返回后再以 settings 为准覆盖（跨设备同步）。
 */
export function initTheme(): string {
  return applyTheme(readCachedTheme());
}
