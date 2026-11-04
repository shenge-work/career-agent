/* =============================================================
 * N13 · 作品集官网内容模型与模板接口
 * -------------------------------------------------------------
 * 内容/布局/模板三者解耦：
 *   - 内容（PortfolioContent）：作品集专属数据，独立维护（不复用简历）。
 *   - 布局（layout）：板块顺序/显隐，由前端结构面板承载。
 *   - 模板（template）：纯函数 (content, layout) => html 字符串，只改视觉不改内容。
 *
 * 模板是纯函数、零 DOM、零外部依赖，服务端可直接调用生成静态站，
 * 也可被测试单测（输出确定性的 HTML 字符串）。
 * ============================================================= */

/** 一条项目经历（作品集卡片）。 */
export interface PortfolioProject {
  name: string;
  desc: string;
  link?: string;
  tags?: string[];
  /** 量化成果，渲染为 kpi 数字带。 */
  metrics?: Array<{ label: string; value: string }>;
}

/** 一条工作/教育经历。 */
export interface PortfolioExperience {
  org: string;
  role: string;
  period: string;
  desc: string;
}

/** 作品集完整内容（payload 的结构化约定）。 */
export interface PortfolioContent {
  name: string;
  title: string;
  bio: string;
  /** 首屏大标题 / slogan。 */
  headline?: string;
  email?: string;
  phone?: string;
  location?: string;
  links?: Array<{ label: string; url: string }>;
  skills?: string[];
  projects?: PortfolioProject[];
  experience?: PortfolioExperience[];
  education?: PortfolioExperience[];
  /** 自定义自由段落（可含 markdown 式粗体）。 */
  custom?: Array<{ title: string; body: string }>;
}

/** 布局配置（板块顺序/显隐）。 */
export interface PortfolioLayout {
  order?: string[];
  visible?: Record<string, boolean>;
}

/** 模板元信息（给模板画廊展示）。 */
export interface TemplateMeta {
  id: string;
  name: string;
  description: string;
}

/** 模板函数：内容 + 布局 → 完整 HTML 文档（含 <!DOCTYPE> 与内联 CSS）。 */
export type PortfolioTemplate = {
  meta: TemplateMeta;
  render: (content: PortfolioContent, layout: PortfolioLayout) => string;
};

/** 内置模板 id 列表（供校验 templateId 合法性）。 */
export const TEMPLATE_IDS = ['minimal', 'magazine', 'dark-tech'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export function isTemplateId(v: unknown): v is TemplateId {
  return typeof v === 'string' && (TEMPLATE_IDS as readonly string[]).includes(v);
}
