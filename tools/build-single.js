#!/usr/bin/env node
/* =============================================================
 * 构建脚本：把多文件项目打包回「单文件 HTML」
 * -------------------------------------------------------------
 * 用法：  node tools/build-single.js
 * 输出：  dist/简历编辑器-单文件.html  （离线可用，可直接双击打开；git 忽略）
 *
 * 说明：日常开发改 css/ / js/ 下的文件，需要分发时再跑本脚本。
 *       产物仅生成在 dist/（已在 .gitignore 中忽略），不再在仓库根放副本，
 *       从根本上消除「根目录 / dist 两份不同步」的隐患。不要直接手改产物，它每次都会被覆盖。
 * ============================================================= */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
/* 复用统一的注入属性清理实现（与 build-desktop-frontend.js 同源） */
const { stripInjections, countInjections } = require('./clean-html-injections.js');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT_FILE = path.join(DIST, '简历编辑器-单文件.html');

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let html = read('index.html');

/* 0) 先净化源 HTML：某些 HTML 可视化编辑/预览工具会给每个标签注入
      data-page-node-id="..."（对运行无影响，但会污染 diff 与产物）。
      这里只净化「内存中的字符串」，不改动源 index.html；
      源文件用 npm run clean:html 清理。
      不净化的话，下面第 1 步的精确标签匹配会直接失败。
      正则与 build-desktop-frontend.js 共用同一份实现，避免两处漂移。 */
{
  const injected = countInjections(html);
  if (injected) {
    html = stripInjections(html);
    console.log('ℹ 产物已剥离注入属性 data-page-node-id × ' + injected + '（源 index.html 请跑 npm run clean:html）');
  }
}

/* 内联脚本中若出现 </script 会提前结束标签，必须转义 */
const safe = (code) => code.replace(/<\/script/gi, '<\\/script');
const inlineScript = (code, name) =>
  '\n<!-- ===== 内联：' + name + '（由 build-single.js 生成） ===== -->\n<script>' + safe(code) + '</script>\n';

/* 1) CSS 内联 */
const css = read('css/style.css');
const LINK = '<link rel="stylesheet" href="css/style.css">';
if (!html.includes(LINK)) { console.error('index.html 中未找到样式表引用：' + LINK); process.exit(1); }
html = html.replace(LINK, '<style>' + css + '</style>');
/* P0 多页面骨架样式：内联在 style.css 之后，被其覆盖 */
const layoutCss = read('css/layout.css');
const LAYOUT_LINK = '<link rel="stylesheet" href="css/layout.css">';
if (!html.includes(LAYOUT_LINK)) { console.error('index.html 中未找到样式表引用：' + LAYOUT_LINK); process.exit(1); }
html = html.replace(LAYOUT_LINK, '<style>' + layoutCss + '</style>');

/* AI 面板样式：内联在 layout.css 之后 */
const aiCss = read('css/ai.css');
const AI_LINK = '<link rel="stylesheet" href="css/ai.css">';
if (!html.includes(AI_LINK)) { console.error('index.html 中未找到样式表引用：' + AI_LINK); process.exit(1); }
html = html.replace(AI_LINK, '<style>' + aiCss + '</style>');

/* 2) JS 内联（顺序必须与 index.html 一致） */
const files = [
  ['vendor/html2canvas.min.js', 'html2canvas 1.4.1'],
  ['vendor/jspdf.umd.min.js', 'jsPDF 2.5.1'],
  ['vendor/qrcode-generator.js', 'qrcode-generator 1.4.4（飞书扫码注册二维码渲染）'],
  ['js/theme.js', 'js/theme.js（日间 / 夜间主题）'],
  ['js/store/resume-store.js', 'js/store/resume-store.js（P0 数据门面）'],
  ['js/store/resume-library.js', 'js/store/resume-library.js（M1 多简历仓库）'],
  ['js/store/local-history.js', 'js/store/local-history.js（N11 本地版本历史）'],
  ['js/store/native-bridge.js', 'js/store/native-bridge.js（P2 原生桥）'],
  ['js/store/snippet-library.js', 'js/store/snippet-library.js（A5 经历素材库）'],
  ['js/store/datasource.js', 'js/store/datasource.js（M4 数据源契约与注册表）'],
  ['js/store/adapter-local.js', 'js/store/adapter-local.js（M4 本地适配器）'],
  ['js/store/adapter-feishu.js', 'js/store/adapter-feishu.js（M4 飞书适配器）'],
  ['js/store/company-store.js', 'js/store/company-store.js（公司调研数据层：http + localStorage 降级）'],
  ['js/router/router.js', 'js/router/router.js（P0 微型 hash 路由）'],
  ['js/router/layout.js', 'js/router/layout.js（P0 全局 rail / view-root）'],
  ['js/views/library-view.js', 'js/views/library-view.js（P0 简历库占位页）'],
  ['js/views/editor-view.js', 'js/views/editor-view.js（P0 编辑器视图包装）'],
  ['js/views/settings-view.js', 'js/views/settings-view.js（P2 设置页）'],
  ['js/views/history-view.js', 'js/views/history-view.js（P2 历史版本页）'],
  ['js/views/tracker-view.js', 'js/views/tracker-view.js（P3 投递追踪）'],
  ['js/views/templates-view.js', 'js/views/templates-view.js（排版预设页）'],
  ['js/views/portfolio-view.js', 'js/views/portfolio-view.js（个人官网预览页）'],
  ['js/views/company-view.js', 'js/views/company-view.js（公司调研板块：调研库 + 投递/入库/锁简历标记）'],
  ['js/render/editor-schema.js', 'js/render/editor-schema.js（内容编辑区 schema + 通用渲染写回引擎）'],
  ['js/render/resume-render.js', 'js/render/resume-render.js（简历渲染引擎拆分）'],
  ['js/render/portfolio-html.js', 'js/render/portfolio-html.js（N9 个人官网导出：脱敏 + 单文件官网 HTML 渲染）'],
  ['js/export/export-pdf.js', 'js/export/export-pdf.js（PDF / 长图 / 单文件 HTML 导出）'],
  ['js/feishu/feishu-sync.js', 'js/feishu/feishu-sync.js（飞书同步 / 扫码授权 / 注册 / 自动同步）'],
  ['js/ui/menu-actions.js', 'js/ui/menu-actions.js（统一入口清单：桌面工具菜单 + 手机 sync-pane 同源渲染）'],
  ['js/ui/save-status.js', 'js/ui/save-status.js（保存状态条：保存三态 + 存储降级告警）'],
  ['js/ui/notifier.js', 'js/ui/notifier.js（消息通知中心）'],
  ['js/ui/pane-mobile.js', 'js/ui/pane-mobile.js（面板 / 移动端 UI）'],
  ['js/io/jsonresume-adapter.js', 'js/io/jsonresume-adapter.js（JSON Resume 互操作适配器）'],
  ['js/theme-templates.js', 'js/theme-templates.js（N1 主题模板系统：简历视觉主题 Schema + 内置主题库）'],
  ['js/store/library-share.js', 'js/store/library-share.js（N3 分享与权限控制：锁定 / 分享开关 / 分享标识 / 整库备份的纯逻辑）'],
  ['js/ai/presets.js', 'js/ai/presets.js（AI 厂商预设）'],
  ['js/ai/provider.js', 'js/ai/provider.js（AI 调用层 + SSE 解析）'],
  ['js/ai/ui/panel.js', 'js/ai/ui/panel.js（AI 面板壳）'],
  ['js/app.js', 'js/app.js'],
  ['js/router/bootstrap.js', 'js/router/bootstrap.js（P0 路由启动）'],
  ['js/export-extra.js', 'js/export-extra.js（T7 DOCX / 纯文本 / Markdown / 静默 PDF 导出）'],
  ['js/audit.js', 'js/audit.js（T7 投递体检）'],
  ['js/jd-match.js', 'js/jd-match.js（JD 匹配分析：岗位关键词覆盖三档）'],
  ['js/jd-derive.js', 'js/jd-derive.js（A4 JD 派生版本：缺失/弱覆盖关键词整理为定制版）']
];
for (const [file, name] of files) {
  const tag = '<script src="' + file + '"></script>';
  if (!html.includes(tag)) { console.error('index.html 中未找到脚本引用：' + tag); process.exit(1); }
  html = html.replace(tag, () => inlineScript(read(file), name));
}

/* 3) data.js 特殊处理：把公开示范数据 template.json 注入 DEMO_DATA 钩子，
      使双击打开的单文件版无需服务器也能看到完整示范简历（file:// 下 fetch 不可用）。 */
{
  const dataTag = '<script src="js/data.js"></script>';
  if (!html.includes(dataTag)) { console.error('index.html 中未找到脚本引用：' + dataTag); process.exit(1); }
  let dataSrc = read('js/data.js');
  const templatePath = path.join(ROOT, 'template.json');
  if (!fs.existsSync(templatePath)) { console.error('未找到 template.json，无法注入示范数据'); process.exit(1); }
  const tmpl = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  const demoLiteral = JSON.stringify(tmpl.data || {});
  if (!dataSrc.includes('DEMO_DATA = null')) { console.error('js/data.js 中未找到 DEMO_DATA 钩子，无法注入示范数据'); process.exit(1); }
  dataSrc = dataSrc.replace('DEMO_DATA = null', 'DEMO_DATA = ' + demoLiteral);
  html = html.replace(dataTag, () => inlineScript(dataSrc, 'js/data.js（已注入 template.json 示范数据）'));
  console.log('✓ 已将 template.json 注入单文件版 data.js（离线演示可用）');
}

if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(OUT_FILE, html, 'utf8');

/* 仅校验产物本身已正确写入 dist（不再比较根目录副本） */
const md5 = crypto.createHash('md5').update(fs.readFileSync(OUT_FILE)).digest('hex');
const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0);
console.log('✓ 已生成单文件：dist/简历编辑器-单文件.html  (' + kb + ' KB)');
console.log('  md5  :', md5);
/* 只统计「真实」的外部引用：路径里含引号或加号的是三方库内部的拼接字符串
   （如 jsPDF 的 '<script src="' + o + '">'），不能算作产物残留，否则会长期误报 1 个。 */
const extRefs = html.match(/<script\s+src="[^"'+]*"|<link\s+rel="stylesheet"\s+href="[^"'+]*"/gi) || [];
console.log('  剩余外部引用: ' + extRefs.length + ' 个（应为 0）' + (extRefs.length ? ' → ' + extRefs.join(', ') : ''));
