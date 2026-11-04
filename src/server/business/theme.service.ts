/* =============================================================
 * 主题模板系统（移植自 v1 N1 · js/theme-templates.js）
 * -------------------------------------------------------------
 * 主题 = 字体 / 间距 / 纸张边距 / 强调色 的预设差异值。
 * 「应用主题」= 把主题差异值合并进 payload 的既有 fonts / spacing /
 * pageMargins / data.theme（覆盖式合并，缺失键保留原值），不重写渲染层。
 *
 * 内置 5 套主题（复用 v1 差异值）：classic / modern / elegant / warm / minimal。
 * 强调色通过 data.theme.overrides.color 持久化，渲染层（v1 css 的 --paper-*）
 * 消费它们；classic 无颜色微调时为空对象，交给样式表默认 → 像素级一致。
 * ============================================================= */

export interface ThemeDef {
  id: string;
  name: string;
  desc: string;
  layout: 'single' | 'double';
  fonts: Record<string, { val?: number }>;
  spacing: Record<string, { mt?: number; mb?: number }>;
  paper: { size: 'A4' | 'Letter'; margin: { top: number; right: number; bottom: number; left: number } };
  color: Record<string, string>;
}

export const THEMES: ThemeDef[] = [
  {
    id: 'classic', name: '经典', desc: '中性单栏，出厂默认外观', layout: 'single',
    fonts: {}, spacing: {},
    paper: { size: 'A4', margin: { top: 14, right: 14, bottom: 14, left: 14 } },
    color: {},
  },
  {
    id: 'modern', name: '现代蓝', desc: '蓝色主调，姓名更大、间距更紧凑', layout: 'single',
    fonts: { name: { val: 32 }, base: { val: 12 }, section: { val: 15 }, job: { val: 14 } },
    spacing: { section: { mt: 8, mb: 5 }, job: { mt: 0, mb: 7 }, project: { mt: 6, mb: 7 } },
    paper: { size: 'A4', margin: { top: 16, right: 16, bottom: 16, left: 16 } },
    color: { rule: '#2563eb', strong: '#1d4ed8', kwText: '#2563eb', panelBar: '#2563eb', chipText: '#2563eb', tagText: '#1d4ed8', arrow: '#2563eb' },
  },
  {
    id: 'elegant', name: '雅致墨绿', desc: '墨绿主调，沉稳优雅', layout: 'single',
    fonts: { name: { val: 30 }, base: { val: 11.5 } },
    spacing: { section: { mt: 12, mb: 7 }, job: { mt: 0, mb: 9 } },
    paper: { size: 'A4', margin: { top: 15, right: 15, bottom: 15, left: 15 } },
    color: { rule: '#0f766e', strong: '#115e59', kwText: '#0f766e', panelBar: '#0f766e', chipText: '#0f766e', tagText: '#115e59', arrow: '#0f766e' },
  },
  {
    id: 'warm', name: '暖橙', desc: '暖橙主调，亲和明快', layout: 'single',
    fonts: { name: { val: 30 }, base: { val: 12 } },
    spacing: { section: { mt: 10, mb: 6 }, job: { mt: 0, mb: 8 } },
    paper: { size: 'A4', margin: { top: 14, right: 14, bottom: 14, left: 14 } },
    color: { rule: '#c2410c', strong: '#9a3412', kwText: '#c2410c', panelBar: '#c2410c', chipText: '#9a3412', tagText: '#9a3412', arrow: '#c2410c' },
  },
  {
    id: 'minimal', name: '极简', desc: '大留白，灰阶克制', layout: 'single',
    fonts: { name: { val: 26 }, base: { val: 11 }, section: { val: 14 } },
    spacing: { section: { mt: 16, mb: 10 }, job: { mt: 0, mb: 10 }, project: { mt: 8, mb: 10 } },
    paper: { size: 'A4', margin: { top: 18, right: 18, bottom: 18, left: 18 } },
    color: { rule: '#9aa0a6', strong: '#333333', kwText: '#555555', panelBar: '#888888', chipText: '#666666', tagText: '#555555', arrow: '#aaaaaa' },
  },
];

const BY_ID: Record<string, ThemeDef> = {};
THEMES.forEach((t) => (BY_ID[t.id] = t));

export function getTheme(id: string): ThemeDef {
  return BY_ID[id] || BY_ID.classic;
}
export function allThemes(): ThemeDef[] {
  return THEMES.slice();
}

/** 把主题差异值合并进 payload（不修改入参，返回新 payload）。 */
export function applyThemeToPayload(payload: any, themeId: string): any {
  const theme = getTheme(themeId);
  const out: any = JSON.parse(JSON.stringify(payload || {}));

  // 字体：覆盖式合并（保留原 label/desc/min/max，只改 val）
  if (!out.fonts || typeof out.fonts !== 'object') out.fonts = {};
  Object.keys(theme.fonts).forEach((k) => {
    const src = theme.fonts[k];
    const cur = out.fonts[k] || {};
    out.fonts[k] = { ...cur, val: src.val ?? cur.val };
  });

  // 间距：覆盖式合并 mt/mb
  if (!out.spacing || typeof out.spacing !== 'object') out.spacing = {};
  Object.keys(theme.spacing).forEach((k) => {
    const src = theme.spacing[k];
    const cur = out.spacing[k] || {};
    out.spacing[k] = {
      label: cur.label || k,
      mt: src.mt != null ? src.mt : cur.mt != null ? cur.mt : 0,
      mb: src.mb != null ? src.mb : cur.mb != null ? cur.mb : 0,
    };
  });

  // 纸张边距
  if (!out.data || typeof out.data !== 'object') out.data = {};
  out.data.pageMargins = { ...(out.data.pageMargins || {}), ...theme.paper.margin };

  // 主题标识 + 强调色 overrides
  if (!out.data.theme || typeof out.data.theme !== 'object') out.data.theme = {};
  out.data.theme.id = theme.id;
  out.data.theme.overrides = {
    ...(out.data.theme.overrides || {}),
    color: { ...(out.data.theme.overrides?.color || {}), ...theme.color },
  };

  return out;
}

/** 列出主题的轻量描述（不含完整 color 细节，前端只需 id/name/desc）。 */
export function themeList() {
  return THEMES.map((t) => ({ id: t.id, name: t.name, desc: t.desc, layout: t.layout }));
}
