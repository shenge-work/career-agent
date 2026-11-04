/* =============================================================
 * 简历数据模型（配置 + 离线兜底骨架）
 * -------------------------------------------------------------
 * 本文件只剩两样东西：
 *   1) 字体 / 间距的「出厂默认值」（defaultFonts / defaultSpacing）
 *      —— 驱动「重置为默认」按钮，属于应用配置，必须内联（file:// 无法 fetch）。
 *   2) 一份极简的离线兜底数据骨架（data）
 *      —— 仅在 file:// 直接打开、且浏览器无任何本地缓存时作为占位；
 *         公开演示用的「完整示范简历」已移到仓库根目录 template.json，
 *         由 npm start 打开时自动加载（见 js/app.js 的初始化优先级）。
 *
 * ⚠️ 演示内容（虚构示例人物「林一帆」）现在唯一的来源是仓库根目录 template.json，
 *    不要在此文件里再内联大段简历。单文件构建（tools/build-single.js）会把
 *    template.json 注入到下面的 DEMO_DATA 钩子，使双击打开的单文件版仍是完整示范。
 *
 * 业务代码见 js/app.js；想改默认字号 / 全局间距改这里即可。
 * ============================================================= */

/* ============ 离线 / 单文件兜底数据 ============ */
/* DEMO_DATA 是构建钩子：开发态与 file:// 下为 null → 用空骨架占位；
   单文件构建时由 tools/build-single.js 替换为仓库根目录 template.json 的内容。 */
const DEMO_DATA = null;
let data = DEMO_DATA || {
  name: "", subtitle: "", subtitleBold: false,
  meta: "", metaBold: false,
  contact: [],
  sections: []
};

/* ============ 字体配置（出厂默认值） ============ */
const defaultFonts = {
  base:    {label:'基础正文', val:12, min:8,  max:20, desc:'段落、列表项'},
  name:    {label:'姓名',     val:28, min:16, max:48, desc:''},
  section: {label:'章节标题', val:16, min:12, max:28, desc:''},
  job:     {label:'公司/项目名', val:14, min:10, max:24, desc:''},
  role:    {label:'岗位/时间', val:12, min:8,  max:20, desc:''},
  stack:   {label:'技术栈标签', val:11, min:8,  max:18, desc:''},
  contact: {label:'联系方式', val:12, min:8,  max:20, desc:'右上角联系信息'}
};
let currentFonts = JSON.parse(JSON.stringify(defaultFonts));

/* ============ 间距配置（全局默认值，每行可单独叠加） ============ */
const defaultSpacing = {
  name:      {label:'姓名',         mt:0, mb:4},
  subtitle:  {label:'核心头衔',     mt:2, mb:2},
  meta:      {label:'顶部标签',     mt:0, mb:4},
  contact:   {label:'联系方式',     mt:0, mb:2},
  section:   {label:'章节标题',     mt:10, mb:6},
  job:       {label:'公司块',       mt:0, mb:8},
  jobTitle:  {label:'公司名',       mt:0, mb:2},
  jobRole:   {label:'岗位',         mt:0, mb:2},
  jobDate:   {label:'时间',         mt:0, mb:2},
  summary:   {label:'公司概述',     mt:4, mb:6},
  project:   {label:'项目块',       mt:6, mb:8},
  pTitle:    {label:'项目名',       mt:0, mb:2},
  pStack:    {label:'技术栈',       mt:0, mb:4},
  pDesc:     {label:'项目描述',     mt:2, mb:4},
  result:    {label:'量化成果',     mt:0, mb:3},
  skillGroup:{label:'技能分组',     mt:4, mb:6},
  skillTitle:{label:'技能分组名',   mt:0, mb:3},
  skillItem: {label:'技能点',       mt:0, mb:2},
  /* 矩阵式技能行（2026-09-20 新增）：关键词行 / 补充说明行 各自可独立微调。
     skillMatrix 是矩阵行的「行间距」全局默认——行与行之间靠 CSS 内边距 + 细线分隔，
     所以默认值取 0，避免和 skillGroup 的默认值叠加成大片空白。 */
  skillKw:    {label:'技能关键词行', mt:0, mb:2},
  skillDetail:{label:'技能说明行',   mt:0, mb:0},
  skillMatrix:{label:'技能矩阵行',   mt:0, mb:0},
  adv:       {label:'优势条目',     mt:0, mb:4},
  /* 以下 5 类此前只在预览里被引用、没进这张默认表（表现为「每行微调能调，
     但「间距配置」面板里找不到对应全局默认值」）。2026-09-20 补齐，
     让内容编辑区里每个间距控件都有对应的全局默认值可调。 */
  highlightCard:{label:'高亮卡',    mt:0, mb:6},
  phaseLabel:{label:'成长阶段标签', mt:0, mb:2},
  phaseDate: {label:'成长阶段时间', mt:0, mb:2},
  phaseTitle:{label:'成长阶段主题', mt:0, mb:3},
  phaseDesc: {label:'成长阶段描述', mt:0, mb:4},
  /* N9 官网板块在 A4 预览里的降级形态（官网首屏要视觉冲击，PDF 要信息密度，
     同一份数据两种排版），这两项对应它们各自的「行间距」全局默认值 */
  kpiItem:   {label:'关键数据项',   mt:0, mb:0},
  evidence:  {label:'优化证据链',   mt:2, mb:2}
};
let currentSpacing = JSON.parse(JSON.stringify(defaultSpacing));

/* ============ 页面页边距默认值（A4 打印用） ============ */
const defaultPageMargins = { top: 14, right: 14, bottom: 14, left: 14 };
