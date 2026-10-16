/* 简历编辑器核心逻辑测试（在 vm 上下文内执行，与 data.js / app.js 共享同一作用域）。
   断言通过全局 __ok(name, cond) 上报；环境桩由 test/run.js 提供。
   覆盖：P0（存储通用化 / JSON 导入导出 / projects 预览）+ P1（板块增删 / 撤销重做栈）。 */

function E(name, cond){ __ok(name, !!cond); }
function clearLS(){ localStorage.removeItem(SAVE_KEY); localStorage.removeItem(SAVE_KEY_LEGACY); }

/* ===== P0：存储通用化（去硬编码身份）===== */
E('SAVE_KEY 通用化（不含硬编码姓名）',
  SAVE_KEY === 'resume_builder_data_v1' && SAVE_KEY.indexOf('chenpeisheng') === -1);

/* exportJSON 在桩环境下不抛错（Blob/URL/createElement 均被桩接管） */
let exportThrew = false;
try { exportJSON(); } catch(e){ exportThrew = true; console.log('exportJSON threw:', e && e.message); }
E('exportJSON 调用不抛错', !exportThrew);

/* applyImported 拒绝非法格式（缺 data.sections），且弹错不改动数据 */
confirmReturn = true;
alertCalls.length = 0;
const nameBeforeBad = data.name;
applyImported({ foo: 1 });
E('applyImported 拒绝非法格式', alertCalls.length > 0);
E('applyImported 拒绝后不改数据', data.name === nameBeforeBad);

/* applyImported 接受合法数据并规范化（projects 缺 spacing 被补全） */
alertCalls.length = 0;
const payload = {
  data: {
    name: '导入名', subtitle: '', meta: '', contact: [],
    sections: [ { id: 'x', type: 'projects', title: '项目经历',
      items: [ { name: 'P1', stack: '', desc: '', results: [], pageBreak: false } ] } ]
  },
  fonts: {}, spacing: {}
};
applyImported(JSON.parse(JSON.stringify(payload)));
E('applyImported 导入后 name 生效', data.name === '导入名');
const projSec = data.sections.find(s => s.type === 'projects');
E('applyImported 规范化补 spacing',
  projSec && projSec.items[0].spacing && typeof projSec.items[0].spacing === 'object');

/* P0 存储统一：localStorage 不再承载简历数据（打包安装包无浏览器环境）。
   自动保存改走本地文件系统（Tauri 命令 / serve.js /api/library/*）；
   旧 SAVE_KEY* 仅保留常量定义用于清理残留，loadState 已移除。 */
clearLS();
localStorage.setItem(SAVE_KEY, 'LEGACY_RESIDUE');
saveState();
E('saveState 不再写 localStorage 简历数据', localStorage.getItem(SAVE_KEY) === 'LEGACY_RESIDUE');
E('SAVE_KEY 常量仍保留（用于清理残留）', SAVE_KEY === 'resume_builder_data_v1');

/* ===== P0：projects 板块预览分支（之前是静默空白 bug）===== */
data = { subtitleBold: false, metaBold: false, name: '预览测试', subtitle: '', meta: '', contact: [],
         sections: [ blankSection('projects') ] };
data.sections[0].items[0].name = '项目X';
let previewHtml = '', previewThrew = false;
try { previewHtml = renderResumeInner(); } catch(e){ previewThrew = true; console.log('renderResumeInner threw:', e && e.message); }
E('renderResumeInner(projects) 不抛错', !previewThrew);
E('renderResumeInner(projects) 含项目名', previewHtml.indexOf('项目X') !== -1);

/* ===== 专业技能矩阵式渲染（2026-09-20 新增 keywords / detail）
   失效面（任一断掉都要红）：
   · 渲染分支漏掉 → 新格式整块不渲染（只留一个「专业技能」标题）；
   · kwText 漏掉 → **重点** 以字面量星号显示；分隔符不统一 → 行内粘成一坨；
   · 旧版兜底被覆盖 → 没填 keywords 的老分组直接消失。 */
data = { subtitleBold: false, metaBold: false, name: '技能测试', subtitle: '', meta: '', contact: [],
         sections: [ { id: 's_sk', type: 'skills', title: '专业技能', pageBreak: false,
           groups: [
             { name: 'AI / Agent', keywords: '**Multi-Agent 协作编排** · **JVM 调优 · 并发编程** · RAG 增强检索',
               detail: 'LangChain / LangGraph · Few-Shot 自学习框架', items: [] },
             { name: '语言', items: ['Python', 'Go'] }
           ], spacing: {mt:0, mb:0} } ] };
let skHtml = '', skThrew = false;
try { skHtml = renderResumeInner(); } catch(e){ skThrew = true; console.log('renderResumeInner(skills) threw:', e && e.message); }
E('renderResumeInner(skills 矩阵) 不抛错', !skThrew);
E('技能矩阵：左列分组名', skHtml.indexOf('class="skill-name"') !== -1 && skHtml.indexOf('AI / Agent') !== -1);
E('技能矩阵：关键词行与高亮', skHtml.indexOf('class="skill-kw"') !== -1
  && skHtml.indexOf('<strong>Multi-Agent 协作编排</strong>') !== -1
  && skHtml.indexOf('**Multi-Agent') === -1);
E('技能矩阵：补充说明行', skHtml.indexOf('class="skill-detail"') !== -1 && skHtml.indexOf('Few-Shot 自学习框架') !== -1);
E('技能矩阵：分隔符渲染为统一圆点', skHtml.indexOf('<span class="skill-sep">·</span>') !== -1);
/* 每个专业名词包一层 skill-seg（inline-block）：换行时整段挪走，不把词从中间截断。
   断言落在结构上——分隔圆点必须在段外，否则换行点又跑回段中间。 */
E('技能矩阵：专业名词整段换行（段外是唯一换行点）',
  skHtml.indexOf('<span class="skill-seg">') !== -1
  && skHtml.indexOf('</span><span class="skill-sep">·</span><span class="skill-seg">') !== -1);
E('技能矩阵：跨分隔符的加粗整段高亮（不被 · 切开）',
  skHtml.indexOf('<strong>JVM 调优 · 并发编程</strong>') !== -1);
E('技能矩阵：页面上不残留字面量星号', skHtml.indexOf('**') === -1);
E('技能矩阵：无 keywords 的分组走旧版列表', skHtml.indexOf('<h4') !== -1 && skHtml.indexOf('<li') !== -1
  && skHtml.indexOf('Python') !== -1);
E('技能矩阵：矩阵行单独用 skillMatrix 间距（不与 skillGroup 叠加）',
  skHtml.indexOf('margin-top:0px;margin-bottom:0px;') !== -1);
/* 编辑器面板：新增字段必须真的渲染出输入框，否则「能存不能填」——
   数据模型改了、渲染改了，但右侧面板里没有 keywords / detail 两个框，用户永远填不进去。 */
let edHtml = '', edThrew = false;
try { edHtml = ResumeEditorSchema.renderEditorHTML(data); } catch (e) { edThrew = true; console.log('renderEditorHTML threw:', e && e.message); }
E('技能矩阵：编辑器不抛错', !edThrew);
E('技能矩阵：编辑器渲染出关键词行 / 说明行输入框',
  edHtml.indexOf('data-path="sections.0.groups.0" data-field="keywords"') !== -1
  && edHtml.indexOf('data-path="sections.0.groups.0" data-field="detail"') !== -1);
E('技能矩阵：编辑器留出旧版逐条技能点入口（可回退）',
  edHtml.indexOf('data-field="name"') !== -1 && edHtml.indexOf('sections.0.groups.0.items') !== -1);

/* ===== P1：板块工厂 ===== */
const adv = blankSection('advantages');
E('blankSection(advantages) 结构',
  adv.type === 'advantages' && Array.isArray(adv.items) && adv.items.length === 1
  && typeof adv.id === 'string' && adv.id.length > 0);
const sk = blankSection('skills');
E('blankSection(skills) 含 groups',
  sk.type === 'skills' && Array.isArray(sk.groups) && sk.groups.length === 1 && Array.isArray(sk.groups[0].items));
const pr = blankSection('projects');
E('blankSection(projects) 含 items+results',
  pr.type === 'projects' && Array.isArray(pr.items) && Array.isArray(pr.items[0].results) && typeof pr.items[0].name === 'string');
const ca = blankSection('career');
E('blankSection(career) 含 projects 数组',
  ca.type === 'career' && Array.isArray(ca.items) && Array.isArray(ca.items[0].projects));
E('blankSection id 唯一', blankSection('advantages').id !== blankSection('advantages').id);

/* ===== P1：添加板块 + 撤销/重做 ===== */
const before = data.sections.length;            // 当前为 projects-only（1 个）
recordHistory('action');
data.sections.push(blankSection('skills'));
E('添加板块后 +1', data.sections.length === before + 1);
undo();
E('撤销恢复板块数', data.sections.length === before);
redo();
E('重做 +1', data.sections.length === before + 1);
undo();                                         // 回到 before

/* ===== P1：单板块删除守卫（click 处理器内的守卫前提条件）===== */
data.sections = [ blankSection('advantages') ];
E('仅 1 个板块时 del-section 守卫成立', data.sections.length <= 1);

/* ===== P1：多步历史栈 ===== */
hist.undo.length = 0; hist.redo.length = 0; hist.last = { kind: '', t: 0 };
const base = data.sections.length;             // 1
recordHistory('action'); data.sections.push(blankSection('skills'));   // +1
recordHistory('action'); data.sections.push(blankSection('career'));  // +1
E('两步添加共 +2', data.sections.length === base + 2);
undo(); E('撤销一步', data.sections.length === base + 1);
undo(); E('再撤销一步', data.sections.length === base);
redo(); E('重做一步', data.sections.length === base + 1);

/* ===== P1：输入合并策略（避免逐字符/逐格历史爆炸）===== */
hist.undo.length = 0; hist.redo.length = 0; hist.last = { kind: '', t: 0 };
recordHistory('edit'); recordHistory('edit'); recordHistory('edit');
E('连续 edit 合并为 1 个历史项', hist.undo.length === 1);
recordHistory('setting'); recordHistory('setting');
E('连续 setting 合并为 1 个历史项（独立 kind）', hist.undo.length === 2);

/* ===== P1：板块级 pageBreak（强制板块从新一页开始）===== */
hist.undo.length = 0; hist.redo.length = 0; hist.last = { kind:'', t:0 };
data.sections = [];
const adv0 = blankSection('advantages');
const car0 = blankSection('career');
data.sections.push(adv0, car0);
E('blankSection("advantages").pageBreak 默认 false', adv0.pageBreak === false);
E('blankSection("career").pageBreak 默认 false', car0.pageBreak === false);

/* section.pageBreak 缺字段时 migratePageBreaks 补 false */
data.sections[0].pageBreak = undefined;
migratePageBreaks(data);
E('migratePageBreaks 把缺失的 section.pageBreak 补为 false', data.sections[0].pageBreak === false);

/* 显式 true 不会被迁移改写 */
data.sections[1].pageBreak = true;
migratePageBreaks(data);
E('migratePageBreaks 保留显式 pageBreak=true', data.sections[1].pageBreak === true);

/* 板块级 pageBreak 影响渲染：在 .section 元素上挂 page-break-before */
const secHtml = `<section class="section${car0.pageBreak ? ' page-break-before' : ''}">…</section>`;
E('career 渲染时挂上 page-break-before class', secHtml.includes('page-break-before'));
const advHtml = `<section class="section${adv0.pageBreak ? ' page-break-before' : ''}">…</section>`;
E('advantages 默认不带 page-break-before', !advHtml.includes('page-break-before'));

/* ===== N1 主题模板系统（F1/F2/F3/F5/F6）===== */
E('ResumeThemeTemplates 已加载', !!ResumeThemeTemplates);
E('内置主题数量 = 5', ResumeThemeTemplates.allThemes().length === 5);
E('默认主题为 classic', ResumeThemeTemplates.defaultThemeId() === 'classic');

/* 应用 modern 主题：字号 / 间距 / 纸张随之变化，且经 API 可读 */
data = { name:'主题测试', subtitle:'', subtitleBold:false, meta:'', metaBold:false, contact:[], sections:[], theme:{ id:'classic', overrides:{} } };
applyTheme('modern');
E('applyTheme 后当前主题 = modern', getActiveThemeId() === 'modern');
E('applyTheme(moden) 改姓名字号', currentFonts.name.val === 32);
E('applyTheme(moden) 改页面边距', JSON.stringify(data.pageMargins) === JSON.stringify({ top:16, right:16, bottom:16, left:16 }));

/* 颜色微调写进 overrides，且当前调色板包含该色 */
customizeThemeColor('rule', '#ff0000');
E('customizeThemeColor 写 overrides.color.rule', getCurrentPalette().rule === '#ff0000');

/* 重置微调回到主题出厂外观 */
resetThemeOverrides();
E('resetThemeOverrides 清除颜色微调', getCurrentPalette().rule !== '#ff0000');

/* 默认主题（classic）无颜色微调时调色板为 null（交给样式表 / 夜间纸张，保证默认一致） */
data.theme = { id:'classic', overrides:{} };
E('classic 无微调时 resolvePalette 为 null', ResumeThemeTemplates.resolvePalette(data) === null);

/* 逐节标题显隐（F6）：headingVisible=false 时渲染省略 section-title，true 时正常渲染 */
const hv = blankSection('advantages'); hv.headingVisible = false; hv.title = 'HDR_X';
data.sections = [hv];
E('headingVisible=false 省略标题渲染', ResumeRender.renderResumeInner().indexOf('HDR_X') === -1);
hv.headingVisible = true;
E('headingVisible=true 渲染标题', ResumeRender.renderResumeInner().indexOf('HDR_X') !== -1);

/* 自定义板块（F5）：渲染出 custom-body 且内容可见 */
const cs = ResumeEditorSchema.createSection('custom');
cs.title = '自定'; cs.html = '自定义内容 **加粗**';
data.sections = [cs];
const csHtml = ResumeRender.renderResumeInner();
E('custom 板块渲染出 custom-body', csHtml.indexOf('custom-body') !== -1);
E('custom 板块内容含文本', csHtml.indexOf('自定义内容') !== -1);

/* 恢复默认主题与数据，避免污染后续用例 */
applyTheme('classic');
data = { name:'', subtitle:'', subtitleBold:false, meta:'', metaBold:false, contact:[], sections:[] };

/* N5：缩略图渲染（buildResumeHtml）按 payload 渲染，不改写全局、空简历返回空串 */
(function () {
  const sample = {
    data: { name:'缩略图测试', subtitle:'S', contact:[],
      sections: [{ id:'s1', type:'advantages', title:'优势', items:[{ label:'L', text:'内容' }] }] },
    fonts: {}, spacing: {}
  };
  const html = ResumeRender.buildResumeHtml(sample);
  E('buildResumeHtml 返回 .resume 包裹', /class="resume"/.test(html));
  E('buildResumeHtml 含姓名', html.indexOf('缩略图测试') !== -1);
  E('buildResumeHtml 含板块标题', html.indexOf('优势') !== -1);
  E('buildResumeHtml 空 sections 返回空串', ResumeRender.buildResumeHtml({ data:{ name:'x', sections:[] }, fonts:{}, spacing:{} }) === '');
  /* 临时交换全局 data 后必须恢复：调用前 data 是上面的空对象，调用后仍是它 */
  E('buildResumeHtml 不改写全局 data', data && data.sections && data.sections.length === 0);
})();

/* 项目「技术栈」chip 为空时必须不输出：空 <span class="stack"> 仍带 padding + border，
   会渲染成一个小空框。项目独有技术名词改在描述 / 成果里自然提及，
   通用栈（Spring Boot / Redis 等）由「专业技能」板块统一承载，不再逐项目罗列。 */
(function () {
  const mkDoc = (type, stackVal) => ({
    data: {
      name: 'T', subtitle: '', meta: '', contact: [],
      sections: [{ id: 's1', type: type, title: '项目',
        items: type === 'projects'
          ? [{ name: 'P1', stack: stackVal, desc: '描述D', results: ['成果R'] }]
          : [{ company: 'C', role: 'R', date: 'D', projects: [{ name: 'P1', stack: stackVal, desc: '描述D', results: ['成果R'] }] }] }]
    },
    fonts: {}, spacing: {}
  });
  ['projects', 'career'].forEach(function (type) {
    const withStack = ResumeRender.buildResumeHtml(mkDoc(type, 'Spring Boot · Redis'));
    const noStack = ResumeRender.buildResumeHtml(mkDoc(type, ''));
    E(type + ' 技术栈非空时输出 stack chip',
      withStack.indexOf('class="stack"') !== -1 && withStack.indexOf('Spring Boot · Redis') !== -1);
    E(type + ' 技术栈为空时不输出 stack chip（不留空框）', noStack.indexOf('class="stack"') === -1);
    E(type + ' 技术栈为空时标题/描述/成果照常渲染',
      noStack.indexOf('P1') !== -1 && noStack.indexOf('描述D') !== -1 && noStack.indexOf('成果R') !== -1);
  });
})();

/* ============ 分页「不切行」吸附（图片版 PDF 跨页切行 bug） ============
   切片按内容区高度等分，切点落在文字行中间 → 那一行被拦腰截断。
   snapBreaksToBoxes 是纯函数：给「会落墨的盒子」与「等分切点」，把切点上移到行间空档。
   下面用等行距文本（行盒高 16px、行距 20px）模拟真实排版。 */
(function () {
  const snap = ResumeRender.snapBreaksToBoxes;
  E('snapBreaksToBoxes 已导出', typeof snap === 'function');
  if (typeof snap !== 'function') return;

  /* 60 行文本：第 i 行占 [i*20, i*20+16] */
  const lines = [];
  for (let i = 0; i < 60; i++) lines.push({ top: i * 20, bottom: i * 20 + 16 });
  const hard = (arr) => arr.map((y, i) => ({ y: y, hard: i === 0 || i === arr.length - 1 }));

  /* 1) 切在行中间 → 上移到该行行盒顶部（这一行整体挪到下一页） */
  const cutMid = snap(hard([0, 507, 1200]), lines, 36);
  E('切点落在文字行内部时上移到该行顶部', cutMid[1] === 500);
  E('吸附后长度与顺序不变（首/末边界保持）', cutMid.length === 3 && cutMid[0] === 0 && cutMid[2] === 1200);

  /* 2) 本来就落在行间空档 → 原地不动（不制造无谓偏移） */
  const cutGap = snap(hard([0, 498, 1200]), lines, 36);
  E('切点已在行间空档时保持不动', cutGap[1] === 498);

  /* 3) 切点正好压在行盒下沿（临界）→ 视为安全，不动 */
  const cutEdge = snap(hard([0, 516, 1200]), lines, 36);
  E('切点压在行盒边缘时不动（下半行从边缘起）', cutEdge[1] === 516);

  /* 4) 多个盒子同时跨过切点（嵌套/大盒子）→ 迭代收敛到最上面那个盒子的顶
        （总上移量 50px，这里把预算放宽到 60px 才够；预算不够时见第 5 条） */
  const nested = [{ top: 480, bottom: 540 }, { top: 500, bottom: 560 }];
  const cutNest = snap(hard([0, 530, 1200]), nested, 60);
  E('多层盒子叠加跨过时收敛到最外层盒顶', cutNest[1] === 480);

  /* 5) 上移量超预算 → 放弃吸附，保留原切点（宁可切一行，也不掏空半页） */
  const cutBudget = snap(hard([0, 530, 1200]), nested, 10);
  E('上移量超出预算时保留原切点', cutBudget[1] === 530);

  /* 6) maxShift<=0 等于关闭吸附（老行为，供回退用） */
  const cutOff = snap(hard([0, 507, 1200]), lines, 0);
  E('maxShift=0 时不吸附', cutOff[1] === 507);

  /* 7) 首行 / 末页边界 / 强制换页点（hard）永不吸附 */
  const cutHard = snap([{ y: 0, hard: true }, { y: 507, hard: true }, { y: 1200, hard: true }], lines, 36);
  E('hard（强制换页 / 末页边界）位置不吸附', cutHard[1] === 507);

  /* 8) 没有墨盒（空文档）→ 原样返回，不崩 */
  const cutEmpty = snap(hard([0, 507, 1200]), [], 36);
  E('无墨盒时原样返回', cutEmpty[1] === 507 && cutEmpty.length === 3);

  /* 9) 连续多页：每个自然分页点都要落在空档上（真实 3 页场景） */
  const multi = snap(hard([0, 507, 1013, 1520, 2000]), lines, 36);
  const hitAny = multi.slice(1, -1).some(function (y) {
    return lines.some(function (b) { return b.top < y - 0.5 && b.bottom > y + 0.5; });
  });
  E('多页场景下所有自然分页点都不切行', hitAny === false);
  E('多页吸附后仍单调不减', multi.every(function (v, i) { return i === 0 || v >= multi[i - 1]; }));

  /* 10) 页底预算：随下边距变小而收缩，且有安全上下限 */
  const budget = ResumeRender.pageSnapBudget(973);
  E('pageSnapBudget 返回有限像素预算', budget >= 10 && budget <= 36);
})();

/* ============ 分页几何：内容区高度必须等于「纸张高 - 上下页边距」 ============
   背景（2026-09-22 bug）：曾用 contentW * 297/210 当内容区高度 —— 把整张纸的长宽比
   套在内容区宽度上，得出的是「以内容区为宽的整页高」，比真实可打印高度少
   (top + bottom) * 297/210 ≈ 11mm/页。后果：图片版 PDF 每页少装一行半内容，
   还把切片按 h/pageH * contentH 贴到纸上时纵向拉伸 4.5%（269/257.4），
   与矢量版（Chrome 打印，内容盒实测 688×1017 px = 182×269 mm）对不上。 */
(function(){
  const { getPageMetrics, mmToPx } = ResumeRender;
  /* 用一个假根节点直接量：getPageMetrics 只读 offsetWidth / offsetHeight */
  const fake = function(w, h){ return { offsetWidth: w, offsetHeight: h }; };

  // A4 210mm 宽在 96dpi 下 = 793.7px；边距 14mm（默认）
  const m = getPageMetrics(fake(794, 2727));
  E('A4 渲染宽度 ≈ 210mm', Math.abs(m.pageW - 794) < 1);
  E('内容区宽度 = 210mm - 左右边距',
    Math.abs(m.contentW - (794 - 2 * mmToPx(14))) < 0.01);
  E('内容区高度 = 297 - 上下边距（= 269mm，而不是 contentW*297/210）',
    Math.abs(m.pageH - mmToPx(269)) < 0.01);
  E('内容区高度真的变了：旧算式会得到 257.4mm',
    Math.abs(m.pageH - m.contentW * 297 / 210) > mmToPx(10));
  E('内容区高度 mm 一并给出（供导出侧换算）', Math.abs(m.contentHmm - 269) < 0.01);
  E('内容总高 = 元素高 - 上下 padding',
    Math.abs(m.totalH - (2727 - 2 * mmToPx(14))) < 0.01);

  /* 边距改变 → 可打印区域随之变化；非法值必须回退默认，不能变成 0 边距 */
  const pm = ResumeRender.getPageMargins();
  const saved = { top: pm.top, right: pm.right, bottom: pm.bottom, left: pm.left };
  const setMargins = function(v){ pm.top = v; pm.right = v; pm.bottom = v; pm.left = v; };
  setMargins(0);
  E('页边距为 0 时内容区高度 = 整张纸 297mm',
    Math.abs(getPageMetrics(fake(794, 2000)).pageH - mmToPx(297)) < 0.01);
  setMargins(30);
  E('页边距 30mm 时内容区高度 = 297-60 = 237mm',
    Math.abs(getPageMetrics(fake(794, 2000)).pageH - mmToPx(237)) < 0.01);
  pm.top = null; pm.bottom = '';
  E('边距为 null/空串时按默认 14mm 计算（Number(null)===0 坑）',
    Math.abs(getPageMetrics(fake(794, 2000)).pageH - mmToPx(297 - 14 - 14)) < 0.01);
  pm.top = saved.top; pm.right = saved.right; pm.bottom = saved.bottom; pm.left = saved.left;
  E('测试后边距已还原', pm.top === saved.top && pm.bottom === saved.bottom);
  E('页面高度取整后与 688px 内容宽同源（矢量版内容盒实测 1017px）',
    Math.abs(getPageMetrics(fake(794, 2000)).pageH - 1016.7) < 1);
})();
