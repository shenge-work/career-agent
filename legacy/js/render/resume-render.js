/* =============================================================
 * 简历渲染引擎（纯函数 + HTML 字符串构建）
 * -------------------------------------------------------------
 * 从 js/app.js 物理拆分。本文件不碰 DOM、不调用其它模块，
 * 只依赖 js/data.js 暴露的全局 data / currentFonts / currentSpacing /
 * defaultPageMargins（均为顶层 let/const，跨脚本可读可写）。
 * 挂 window.ResumeRender 供 app.js 解构复用。
 *
 * 内容编辑区（右侧表单）自 2026-09-20 起由 js/render/editor-schema.js 的
 * 声明式 schema 驱动：本文件只负责「把 schema 产出的 HTML 挂进 DOM、
 * 把控件事件分发给 schema 的写回函数」，不再逐字段手写 if-else。
 * 基础件（esc / T / S / z / objify / blank*）统一从 schema 取，保持单一实现。
 * ============================================================= */
(function(global){
"use strict";
/* 编辑区 schema 引擎：必须在 js/render/resume-render.js 之前加载（见 index.html）。
   缺了就直接报错，而不是退化成「编辑区空白」这种静默失效。 */
const ES = global.ResumeEditorSchema;
if(!ES) throw new Error('[resume-render] 缺少 js/render/editor-schema.js（需在本文件之前加载）');
/* ============ 工具 ============ */
const { esc, T, S, z, objify, line, blankItem, blankProject, blankPhase, blankSkillGroup,
        createSection: blankSection } = ES;
/* 把 **xxx** 转为 <strong>xxx</strong>，其它字符转义 */
function boldText(s){
  const safe = esc(s);
  return safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}
/* 技能行（关键词行 / 说明行）的「· 分隔 + 高亮」渲染。
   ⚠️ 切段必须「跳过 **加粗** 区间内部的分隔符」：
   **JVM 调优 · 并发编程** 里那个「·」属于同一个高亮短语，若先按分隔符切段，
   ** 标记会被切成两半，页面上就漏出字面量星号（踩过，test/cases.js 有断言钉住）。 */
function kwSplit(s){
  const str = String(s==null?'':s);
  /* 交替分支按优先级：先尝试整体吃下 **...** 区段（其中的 · 不参与切分），再认分隔符 */
  const re = /\*\*[^*]*\*\*|[·・•]/g;
  const parts = []; let last = 0, m;
  while((m = re.exec(str))){
    const tok = m[0];
    if(tok.length > 1) continue;          /* 命中加粗区段：整段保留在当前片段内 */
    parts.push(str.slice(last, m.index));
    last = m.index + tok.length;
  }
  parts.push(str.slice(last));
  return parts.map(x=>x.trim()).filter(Boolean);
}
function kwText(s){
  const parts = kwSplit(s);
  if(!parts.length) return '';
  /* 每段包一层 inline-block：整段在换行时作为整体挪到下一行，
     不会出现「LLM 评测体 / 系」这种把专业名词拦腰截断的情况；
     分隔圆点留在段外，是唯一的换行点。段内仍可兜底断行（overflow-wrap）。 */
  return parts.map(x=>'<span class="skill-seg">'+boldText(x)+'</span>')
    .join('<span class="skill-sep">·</span>');
}
function getSection(id){ return data.sections.find(s=>s.id===id); }
function getVarStr(){ return Object.keys(currentFonts).map(k=>`--font-${esc(k)}:${z(currentFonts[k].val)}px`).join(';')+';'; }


/* 行间距：全局默认值 + 该行独立偏移 */
function spacingStyle(type, itemSpacing){
  const g = currentSpacing[type] || {mt:0, mb:0};
  const s = itemSpacing || {mt:0, mb:0};
  /* 必须经 z() 强制数值化：导入数据里 mt/mb 可能是恶意字符串，
     直接相加会退化成字符串拼接并注入 style 属性（如 '" onfocus="...'） */
  const mt = z(g.mt) + z(s.mt);
  const mb = z(g.mb) + z(s.mb);
  return `margin-top:${mt}px;margin-bottom:${mb}px;`;
}
function getPageMargins(){ return data.pageMargins || defaultPageMargins; }
function mmToPx(mm){ return mm * 3.7795275591; }  // 96 DPI: 1 mm ≈ 3.7795 px
function pxToMm(px){ return px / 3.7795275591; }

/* ============ 渲染简历 HTML（来自数据模型） ============ */
function renderResumeInner(){
  let h='';
  const subTag = data.subtitleBold ? 'b' : 'span';
  const metaTag = data.metaBold ? 'b' : 'span';
  h+=`<header class="header">`
     +`<div class="header-left"><h1 class="name" style="${spacingStyle('name', data.nameSpacing)}">${esc(data.name)}</h1>`
     +`<div class="subtitle" style="${spacingStyle('subtitle', data.subtitleSpacing)}"><${subTag}>${esc(data.subtitle)}</${subTag}></div></div>`
     +`<div class="header-right"><div class="meta" style="${spacingStyle('meta', data.metaSpacing)}"><${metaTag}>${esc(data.meta)}</${metaTag}></div>`
     + (Array.isArray(data.contact) ? data.contact : []).map(c=>`<div style="${spacingStyle('contact', (c&&typeof c==='object'&&c.spacing)?c.spacing:null)}">${esc(T(c))}</div>`).join('') + `</div></header>`;
  data.sections.forEach(sec=>{
    const secBreak = sec.pageBreak ? ' page-break-before' : '';
    const secIdEsc = esc(sec.id); /* sec.id 来自可导入 JSON，拼属性前必须转义 */
    h+=`<section class="section${secBreak}" data-drag="section:${secIdEsc}" draggable="true" style="${spacingStyle('section', sec.spacing)}">`;
    /* F6 逐节标题显隐：headingVisible === false 时只隐藏标题（含 ↑↓ 重排按钮），内容仍在；
       板块仍可由「拖动整段」重排（section 自身带 data-drag）。 */
    if(sec.headingVisible !== false){
      h+=`<h2 class="section-title"><span class="section-title-text">${esc(sec.title)}</span>${reorderBtns('section', secIdEsc, null, null)}</h2>`;
    }
    if(sec.type==='advantages'){
      h+='<ul class="adv">';
      sec.items.forEach((it,i)=>{
        const tag = it.labelBold!==false ? 'b' : 'span';
        h+=`<li class="adv-li" data-drag="item:${secIdEsc}:${i}" draggable="true" style="${spacingStyle('adv', it.spacing)}">${reorderBtns('item', secIdEsc, i, null)}<${tag}>${esc(it.label)}</${tag}>：${esc(T(it.text))}</li>`;
      });
      h+='</ul>';
    } else if(sec.type==='career'){
      sec.items.forEach((job,i)=>{
        const jobBreak = job.pageBreak ? ' page-break-before' : '';
        h+=`<div class="job${jobBreak}" data-drag="job:${secIdEsc}:${i}" draggable="true" style="${spacingStyle('job', job.spacing)}">${reorderBtns('job', secIdEsc, i, null)}`;
        h+=`<div class="job-header">`;
        let wrapStyle='';
        const lg = Number(job.logoGap);
        if(job.logoGap!=='' && job.logoGap!=null && !isNaN(lg) && lg>0){ wrapStyle = ` style="gap:${lg}px"`; }
        h+=`<div class="job-title-wrap"${wrapStyle}>`;
        if(job.logo && job.logo.trim()){
          const ls = Number(job.logoSize);
          const def = (job.logoSize==='' || job.logoSize==null || isNaN(ls) || ls<=0) ? 28 : ls;
          let logoStyle = `height:${def}px`;
          const lw = Number(job.logoWidth);
          if(job.logoWidth!=='' && job.logoWidth!=null && !isNaN(lw) && lw>0){ logoStyle += `;width:${lw}px`; }
          h+=`<img class="job-logo" src="${esc(job.logo)}" alt="" style="${logoStyle}">`;
        }
        h+=`<p class="job-title" style="${spacingStyle('jobTitle', job.companySpacing)}">${esc(T(job.company))}</p></div>`
          +`<span class="job-date" style="${spacingStyle('jobDate', job.dateSpacing)}">${esc(T(job.date||''))}</span></div>`;
        h+=`<p class="job-role" style="${spacingStyle('jobRole', job.roleSpacing)}">${esc(T(job.role))}</p>`;
        if(job.summary && T(job.summary).trim()){
          const quote = job.summaryQuote !== false;
          const color = esc(job.summaryColor || '#888888');
          const qStyle = quote ? `padding:6px 0 6px 10px;border-left:2px solid ${color};background:var(--paper-card-bg,#fafafa);` : '';
          h+=`<div class="job-summary" style="${spacingStyle('summary', job.summarySpacing)}${qStyle}">${esc(T(job.summary)).replace(/\n/g,'<br>')}</div>`;
        }
        (job.projects||[]).forEach((p,pi)=>{
          const projBreak = p.pageBreak ? ' page-break-before' : '';
          h+=`<div class="project nested${projBreak}" data-drag="proj:${secIdEsc}:${i}:${pi}" draggable="true" style="${spacingStyle('project', p.spacing)}">${reorderBtns('proj', secIdEsc, i, pi)}`;
          h+=`<p class="project-title" style="${spacingStyle('pTitle', p.nameSpacing)}">${esc(T(p.name))}</p>`;
          /* 技术栈 chip 为空时不输出：否则空 span 仍带 padding/border，会渲染成一个小空框。
             项目特有技术名词改在项目描述 / 成果里自然提及，通用栈（Spring Boot / Redis 等）不再单列。 */
          if(T(p.stack).trim()) h+=`<span class="stack" style="${spacingStyle('pStack', p.stackSpacing)}">${esc(T(p.stack))}</span>`;
          const pQuote = p.descQuote !== false;
          const pColor = esc(p.descColor || '#888888');
          const pQStyle = pQuote ? `padding:6px 0 6px 10px;border-left:2px solid ${pColor};background:var(--paper-card-bg,#fafafa);` : '';
          h+=`<p class="desc" style="${spacingStyle('pDesc', p.descSpacing)}${pQStyle}">${esc(T(p.desc))}</p>`;
          h+=`<ul>`;
          (p.results||[]).forEach((r,ri)=>{
            const rt = T(r);
            if(!rt.trim()) return;
            h+=`<li style="${spacingStyle('result', S(r).spacing)}">${esc(rt)}</li>`;
          });
          h+='</ul></div>';
        });
        h+='</div>';
      });
    } else if(sec.type==='projects'){
      sec.items.forEach((p,i)=>{
        const projBreak = p.pageBreak ? ' page-break-before' : '';
        h+=`<div class="project nested${projBreak}" data-drag="item:${secIdEsc}:${i}" draggable="true" style="${spacingStyle('project', p.spacing)}">${reorderBtns('item', secIdEsc, i, null)}`;
        h+=`<p class="project-title" style="${spacingStyle('pTitle', p.nameSpacing)}">${esc(T(p.name))}</p>`;
        if(T(p.stack).trim()) h+=`<span class="stack" style="${spacingStyle('pStack', p.stackSpacing)}">${esc(T(p.stack))}</span>`;
        const pQuote = p.descQuote !== false;
        const pColor = esc(p.descColor || '#888888');
        const pQStyle = pQuote ? `padding:6px 0 6px 10px;border-left:2px solid ${pColor};background:var(--paper-card-bg,#fafafa);` : '';
        h+=`<p class="desc" style="${spacingStyle('pDesc', p.descSpacing)}${pQStyle}">${esc(T(p.desc))}</p>`;
        h+=`<ul>`;
        (p.results||[]).forEach((r,ri)=>{
          const rt = T(r);
          if(!rt.trim()) return;
          h+=`<li style="${spacingStyle('result', S(r).spacing)}">${esc(rt)}</li>`;
        });
        h+='</ul></div>';
      });
    } else if(sec.type==='kpi-band'){
      /* N9：官网「大数字带」在 A4 / PDF 视图里的**降级渲染** —— 一行小数字 + 标签，
         不吃版面。同一份数据，官网首屏要视觉冲击、PDF 要信息密度，两种排版各取所需。 */
      const kpis = (sec.items||[]).filter(it=>it && (T(it.value).trim() || T(it.label).trim()));
      if(kpis.length){
        h+='<div class="kpi-band">';
        kpis.forEach((it,i)=>{
          h+=`<div class="kpi-item" data-drag="item:${secIdEsc}:${i}" draggable="true" style="${spacingStyle('kpiItem', it.spacing)}">`
            + reorderBtns('item', secIdEsc, i, null)
            + (T(it.value).trim() ? `<span class="kpi-value">${esc(T(it.value))}</span>` : '')
            + (T(it.label).trim() ? `<span class="kpi-label">${esc(T(it.label))}</span>` : '')
            + `</div>`;
        });
        h+='</div>';
      }
    } else if(sec.type==='project-cards'){
      /* N9：项目卡片墙降级为与 projects 板块一致的时间线样式（**保证 PDF 版式不被官网带偏**）。
         ⚠️ 重排索引指向的是 sec.cards 而不是 sec.items，所以这里用专用的 kind='card'，
         复用 'item' 会去改一个不存在的数组。 */
      (sec.cards||[]).forEach((c,i)=>{
        if(!c) return;
        const cardBreak = c.pageBreak ? ' page-break-before' : '';
        h+=`<div class="project nested${cardBreak}" data-drag="card:${secIdEsc}:${i}" draggable="true" style="${spacingStyle('project', c.spacing)}">${reorderBtns('card', secIdEsc, i, null)}`;
        h+=`<p class="project-title" style="${spacingStyle('pTitle', c.nameSpacing)}">${esc(T(c.name))}</p>`;
        if(T(c.stack).trim()) h+=`<span class="stack" style="${spacingStyle('pStack', c.stackSpacing)}">${esc(T(c.stack))}</span>`;
        if(T(c.desc).trim()) h+=`<p class="desc" style="${spacingStyle('pDesc', c.descSpacing)}">${esc(T(c.desc))}</p>`;
        const metrics = (c.metrics||[]).map(m=>T(m)).map(s=>String(s).trim()).filter(Boolean);
        if(metrics.length) h+=`<ul class="card-metrics">`+metrics.map(m=>`<li>${esc(m)}</li>`).join('')+`</ul>`;
        const ev = [];
        if(T(c.before).trim()) ev.push('优化前：'+T(c.before));
        if(T(c.after).trim()) ev.push('优化后：'+T(c.after));
        if(T(c.approach).trim()) ev.push('手段：'+T(c.approach));
        if(ev.length) h+=`<p class="evidence" style="${spacingStyle('evidence', c.evidenceSpacing)}">${esc(ev.join('　·　'))}</p>`;
        h+=`</div>`;
      });
    } else if(sec.type==='skills'){
      sec.groups.forEach((grp,g)=>{
        const drag = `data-drag="item:${secIdEsc}:${g}" draggable="true"`;
        const kw = T(grp.keywords), dt = T(grp.detail);
        if(kw.trim() || dt.trim()){
          /* 矩阵式技能行（2026-09-20）：左列分组名，右列「关键词行 + 补充说明行」。
             关键词走 **xxx** 高亮——专业名词完整保留（供 HR / AI 检索定位），
             同时把掌握程度与成果压在同一视觉块里，扫一眼就能读出强弱。 */
          h+=`<div class="skill-group skill-matrix" ${drag} style="${spacingStyle('skillMatrix', grp.spacing)}">${reorderBtns('item', secIdEsc, g, null)}`
            +`<div class="skill-name" style="${spacingStyle('skillTitle', grp.nameSpacing)}">${esc(T(grp.name))}</div>`
            +`<div class="skill-body">`;
          if(kw.trim()) h+=`<div class="skill-kw" style="${spacingStyle('skillKw', grp.keywordsSpacing)}">${kwText(kw)}</div>`;
          if(dt.trim()) h+=`<div class="skill-detail" style="${spacingStyle('skillDetail', grp.detailSpacing)}">${kwText(dt)}</div>`;
          h+='</div></div>';
          return;
        }
        /* 旧版逐条列表：分组内没填 keywords / detail 时保持原样，老数据零改动 */
        h+=`<div class="skill-group" ${drag} style="${spacingStyle('skillGroup', grp.spacing)}">${reorderBtns('item', secIdEsc, g, null)}<h4 style="${spacingStyle('skillTitle', grp.nameSpacing)}">${esc(T(grp.name))}</h4><ul>`;
        grp.items.forEach((it,ii)=>{
          const itt = T(it);
          if(!itt.trim()) return;
          h+=`<li style="${spacingStyle('skillItem', S(it).spacing)}">${esc(itt)}</li>`;
        });
        h+='</ul></div>';
      });
    } else if(sec.type==='highlights'){
      // 高亮卡（左侧灰竖条）+ 标签芯片。文本里 **xxx** 视为加粗。
      h+='<div class="highlights">';
      (sec.cards||[]).forEach(card=>{
        const txt = T(card && card.text);
        if(txt.trim()) h += '<div class="highlight-card" style="' + spacingStyle('highlightCard', (card&&card.spacing)||null) + '">'+boldText(txt)+'</div>';
      });
      const tags = (sec.tags||[]).map(t=>String(T(t)).trim()).filter(Boolean);
      if(tags.length){
        h+='<div class="highlight-tags">';
        tags.forEach(t=>{ h+='<span class="highlight-tag">'+esc(t)+'</span>'; });
        h+='</div>';
      }
      h+='</div>';
    } else if(sec.type==='growth'){
      // 三栏时间轴：phase ▸ phase ▸ phase，中间用 ▶ 串接
      const phases = sec.phases || [];
      h+='<div class="growth">';
      phases.forEach((ph,i)=>{
        h+=`<div class="growth-phase">`;
        h+=`<span class="phase-label" style="${spacingStyle('phaseLabel', ph.labelSpacing)}">${esc(T(ph.label))}</span>`;
        if(T(ph.date).trim()) h+=`<div class="phase-date" style="${spacingStyle('phaseDate', ph.dateSpacing)}">${esc(T(ph.date))}</div>`;
        if(T(ph.title).trim()) h+=`<div class="phase-title" style="${spacingStyle('phaseTitle', ph.titleSpacing)}">${esc(T(ph.title))}</div>`;
        if(T(ph.desc).trim()) h+=`<p class="phase-desc" style="${spacingStyle('phaseDesc', ph.descSpacing)}">${esc(T(ph.desc))}</p>`;
        h+='</div>';
        if(i < phases.length - 1){ h += '<div class="growth-arrow" aria-hidden="true">▶</div>'; }
      });
      h += '</div>';
    }
    else if(sec.type==='custom'){
      /* F5 自定义板块：标题 + 自由内容（支持 **加粗** 与换行），富文本不落任意 CSS。
         标题显隐仍由 headingVisible 统一管控（上方 section 头部处理）。 */
      const html = T(sec.html||'');
      if(html.trim()) h += '<div class="custom-body">'+boldText(html).replace(/\n/g,'<br>')+'</div>';
    }
    h+='</section>';
  });
  return h;
}

/* 模型工厂（blankItem / blankProject / blankPhase / blankSection / objify）
   已统一收敛到 js/render/editor-schema.js：编辑区渲染、点「添加」造新条目、
   导入兜底、测试全走同一份实现，避免「工厂改了但界面没跟上」。
   本文件顶部已从 schema 解构，故这里不再重复定义。 */

const preview = document.getElementById('preview');

/* 打印 / 静默导出的页边距必须跟随「页面边距」面板：
   css/style.css 里的 @page{size:A4;margin:14mm} 只是出厂默认，这里用一条动态规则覆盖它。
   刻意不写成 @page{margin:var(--x)} —— @page 规则内的 var() 各浏览器解析时机不一致，不可靠。 */
const PRINT_PAGE_STYLE_ID = 'printPageMarginStyle';
function safeMm(v, fallback){
  // 空值必须显式回退：Number(null) === 0，否则导入的外部 JSON 里一个 null 会变成「0mm 边距」
  if(v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  if(!Number.isFinite(n) || n < 0) return fallback;
  return Math.round(n * 100) / 100;
}
function syncPrintPageMargin(){
  const m = getPageMargins();
  const css = '@media print{@page{size:A4;margin:'
    + safeMm(m.top, 14) + 'mm ' + safeMm(m.right, 14) + 'mm '
    + safeMm(m.bottom, 14) + 'mm ' + safeMm(m.left, 14) + 'mm;}}';
  let el = document.getElementById(PRINT_PAGE_STYLE_ID);
  if(!el){
    el = document.createElement('style');
    el.id = PRINT_PAGE_STYLE_ID;
    // document.head 在极简 DOM 桩（tools/render-resume.js、测试沙箱）里可能不存在，逐级兜底
    const host = document.head || document.documentElement || document.body;
    if(host && host.appendChild) host.appendChild(el);
  }
  if(el.textContent !== css) el.textContent = css;
}

function renderPreview(){
  const m = getPageMargins();
  const marginStyle = `width:210mm;max-width:none;box-sizing:border-box;padding-top:${mmToPx(m.top)}px;padding-right:${mmToPx(m.right)}px;padding-bottom:${mmToPx(m.bottom)}px;padding-left:${mmToPx(m.left)}px;`;
  preview.innerHTML = `<div class="resume" style="${getVarStr()}${marginStyle}">${renderResumeInner()}</div>`;
  /* N1 主题调色板：把生效主题的 --paper-* 写到 .resume 内联 style（classic 且无微调时清除，
     交给样式表 / 夜间纸张）。缺 ResumeThemeTemplates 时静默跳过，向后兼容。 */
  if (global.ResumeThemeTemplates) {
    try { global.ResumeThemeTemplates.applyPaletteToEl(preview.querySelector('.resume'), data); } catch (e) {}
  }
  syncPrintPageMargin();
  scheduleDrawPageGuides();
  RB.saveState();
}

/* ============ N5：给定 payload 渲染简历 HTML 字符串（缩略图 / 分享等场景） ============
   纯字符串构建、不碰 DOM。为避免改动已稳定多年的渲染层（renderResumeInner 直读模块全局
   data / currentFonts / currentSpacing），这里用「临时覆盖全局 → 渲染 → finally 恢复」的
   受保护交换：调用是同步的、不递归，恢复一定发生，不会影响正在编辑的实时预览。
   返回 '' 表示空简历（调用方据此显示占位纸张）。 */
function buildResumeHtml(payload) {
  payload = payload || {};
  const d = payload.data;
  if (!d || !Array.isArray(d.sections) || !d.sections.length) return '';
  /* 全局 data 由 data.js 声明（顶层 let，跨脚本可读写）；测试桩缺省时直接返回空，避免在 Node 端崩。 */
  if (typeof data === 'undefined') return '';
  const saved = { data: data, fonts: currentFonts, spacing: currentSpacing };
  try {
    data = d;
    currentFonts = payload.fonts || {};
    currentSpacing = payload.spacing || {};
    const m = getPageMargins();
    const pad = 'padding:' + mmToPx(m.top) + 'px ' + mmToPx(m.right) + 'px '
      + mmToPx(m.bottom) + 'px ' + mmToPx(m.left) + 'px;';
    return '<div class="resume" style="' + getVarStr() + pad + '">' + renderResumeInner() + '</div>';
  } finally {
    data = saved.data; currentFonts = saved.fonts; currentSpacing = saved.spacing;
  }
}

/* ============ 拖拽重排（左侧预览） ============ */
/* N3-F1：锁定态下预览里的「改数据」操作（拖拽 / ↑↓ 重排）一并禁掉。
   预览区整体不设 inert —— 那会把长简历的滚动一起锁死；只拦这两个入口。 */
function isDocLocked(){
  try{ return !!(typeof document !== 'undefined' && document.body && document.body.classList.contains('resume-locked')); }
  catch(e){ return false; }
}
let drag = null;
preview.addEventListener('dragstart', e=>{
  if(isDocLocked()){ e.preventDefault(); drag=null; return; }   // 锁定：不接受拖拽重排
  if(e.target.closest('[data-reorder]')){ e.preventDefault(); drag=null; return; } // ↑↓ 按钮不触发拖拽
  const el = e.target.closest('[data-drag]'); if(!el) return;
  const p = el.dataset.drag.split(':');
  drag = {kind:p[0], secId:p[1], idx:p[2], pidx:p[3], el};
  e.dataTransfer.effectAllowed='move';
  try{ e.dataTransfer.setData('text/plain', el.dataset.drag); }catch(_){}
  setTimeout(()=>el.classList.add('dragging'),0);
});
preview.addEventListener('dragover', e=>{
  if(!drag) return;
  const el = e.target.closest('[data-drag]'); if(!el) return;
  const d = el.dataset.drag.split(':');
  const ok =
    (drag.kind==='section' && d[0]==='section') ||
    (drag.kind==='item'    && d[0]==='item'    && d[1]===drag.secId) ||
    (drag.kind==='item'    && d[0]==='job'     && d[1]===drag.secId) ||
    (drag.kind==='job'     && d[0]==='item'    && d[1]===drag.secId) ||
    (drag.kind==='job'     && d[0]==='job'     && d[1]===drag.secId) ||
    (drag.kind==='proj'    && d[0]==='proj'    && d[1]===drag.secId && d[2]===drag.idx) ||
    (drag.kind==='card'    && d[0]==='card'    && d[1]===drag.secId);
  if(!ok) return;
  e.preventDefault();
  const r = el.getBoundingClientRect();
  const before = e.clientY < r.top + r.height/2;
  clearDrop();
  el.classList.add(before ? 'drop-before' : 'drop-after');
  drag.dropEl = el; drag.dropBefore = before;
});
preview.addEventListener('drop', e=>{
  if(!drag || !drag.dropEl) return;
  e.preventDefault();
  RB.recordHistory('action');
  const td = drag.dropEl.dataset.drag.split(':');
  if(drag.kind==='section') moveSection(drag.secId, td[1], drag.dropBefore);
  else if(drag.kind==='job') moveJob(drag.secId, +drag.idx, +td[2], drag.dropBefore);
  else if(drag.kind==='proj') moveProj(drag.secId, +drag.idx, +drag.pidx, +td[3], drag.dropBefore);
  else if(drag.kind==='card') moveCard(drag.secId, +drag.idx, +td[2], drag.dropBefore);
  else moveItem(drag.secId, +drag.idx, +td[2], drag.dropBefore);
  clearDrag(); renderPreview(); renderEditor();
});
preview.addEventListener('dragend', clearDrag);
/* 触屏 / 键盘可用的 ↑↓ 排序：点按即重排，替代 HTML5 DnD（移动端不支持拖拽） */
preview.addEventListener('click', e=>{
  const b = e.target.closest('[data-reorder]'); if(!b) return;
  e.preventDefault();
  if(isDocLocked()) return;   // 锁定：↑↓ 重排同样不允许
  const ds = b.dataset;
  const dir = ds.reorder === 'up' ? -1 : 1;
  const moved = reorderWithin(ds.kind, ds.sec, ds.idx !== undefined ? +ds.idx : undefined, ds.pidx !== undefined ? +ds.pidx : undefined, dir);
  if(moved){ RB.recordHistory('action'); renderPreview(); renderEditor(); }
});
function clearDrop(){ preview.querySelectorAll('.drop-before,.drop-after').forEach(x=>x.classList.remove('drop-before','drop-after')); }
function clearDrag(){ clearDrop(); if(drag&&drag.el) drag.el.classList.remove('dragging'); drag=null; }

/* ↑↓ 排序按钮的 HTML（触屏替代拖拽；桌面 hover 时显示，移动端常显） */
function reorderBtns(kind, secId, idx, pidx){
  const di = (idx===null||idx===undefined) ? '' : ` data-idx="${idx}"`;
  const dp = (pidx===null||pidx===undefined) ? '' : ` data-pidx="${pidx}"`;
  return `<span class="reorder-btns" role="group" aria-label="调整顺序">`
    + `<button type="button" class="reorder-btn" data-reorder="up" data-kind="${kind}" data-sec="${secId}"${di}${dp} aria-label="上移" title="上移">↑</button>`
    + `<button type="button" class="reorder-btn" data-reorder="down" data-kind="${kind}" data-sec="${secId}"${di}${dp} aria-label="下移" title="下移">↓</button>`
    + `</span>`;
}

/* 纯重排逻辑（不触碰渲染）：在「同板块同层级」内上/下移一位。返回是否真的发生移动。 */
function reorderWithin(kind, secId, idx, pidx, dir){
  if(kind==='section'){
    const arr = data.sections; const from = arr.findIndex(s=>s.id===secId); if(from<0) return false;
    if((dir<0 && from===0) || (dir>0 && from===arr.length-1)) return false;
    moveSection(secId, arr[from+dir].id, dir<0); return true;
  }
  if(kind==='job'){
    const sec = getSection(secId); if(!sec || !sec.items) return false;
    const arr = sec.items; const from = +idx;
    if((dir<0 && from===0) || (dir>0 && from===arr.length-1)) return false;
    reInsert(arr, from, from+dir, dir<0); return true;
  }
  if(kind==='proj'){
    const sec = getSection(secId); if(!sec || !sec.items[+idx]) return false;
    const arr = sec.items[+idx].projects; if(!arr) return false;
    const from = +pidx;
    if((dir<0 && from===0) || (dir>0 && from===arr.length-1)) return false;
    reInsert(arr, from, from+dir, dir<0); return true;
  }
  /* N9 project-cards 板块：条目挂在 sec.cards（不是 sec.items），需要独立分支 */
  if(kind==='card'){
    const sec = getSection(secId); if(!sec || !sec.cards) return false;
    const arr = sec.cards; const from = +idx;
    if((dir<0 && from===0) || (dir>0 && from===arr.length-1)) return false;
    reInsert(arr, from, from+dir, dir<0); return true;
  }
  // item：advantages 条目 / skills 分组 / projects 板块条目（均挂在 sec.items 或 sec.groups）
  const sec = getSection(secId); if(!sec) return false;
  const arr = sec.type==='skills' ? sec.groups : sec.items; const from = +idx;
  if((dir<0 && from===0) || (dir>0 && from===arr.length-1)) return false;
  reInsert(arr, from, from+dir, dir<0); return true;
}

function moveSection(fromId,toId,before){
  const arr=data.sections; const from=arr.findIndex(s=>s.id===fromId); if(from<0) return;
  const [m]=arr.splice(from,1);
  let to=arr.findIndex(s=>s.id===toId); if(to<0) to=arr.length-1;
  if(!before) to++; arr.splice(to,0,m);
}
function moveItem(secId,fromIdx,toIdx,before){
  const sec=getSection(secId); if(!sec) return;
  const arr = sec.type==='skills' ? sec.groups : sec.items;
  if(fromIdx<0||fromIdx>=arr.length) return;
  reInsert(arr, fromIdx, toIdx, before);
}
function moveJob(secId,fromIdx,toIdx,before){
  const sec=getSection(secId); if(!sec||!sec.items) return;
  reInsert(sec.items, fromIdx, toIdx, before);
}
function moveProj(secId,jobIdx,fromIdx,toIdx,before){
  const sec=getSection(secId); if(!sec||!sec.items[jobIdx]) return;
  const arr = sec.items[jobIdx].projects; if(!arr) return;
  reInsert(arr, fromIdx, toIdx, before);
}
/* N9 project-cards：卡片数组在 sec.cards 上，与 moveItem（sec.items / sec.groups）分开 */
function moveCard(secId,fromIdx,toIdx,before){
  const sec=getSection(secId); if(!sec||!sec.cards) return;
  if(fromIdx<0||fromIdx>=sec.cards.length) return;
  reInsert(sec.cards, fromIdx, toIdx, before);
}
function reInsert(arr, from, to, before){
  if(from<0||from>=arr.length) return;
  const [m]=arr.splice(from,1);
  let t=to; if(from<to) t--; if(!before) t++;
  if(t<0) t=0; if(t>arr.length) t=arr.length;
  arr.splice(t,0,m);
}

/* ============ 右侧纯文本编辑器（表单，无代码） ============ */
/* 本文件只负责「把 schema 产出的表单挂进 DOM + 把事件分发给 schema」；
   「有哪些字段、值写回哪里、增删移怎么算」全部在 js/render/editor-schema.js。
   于是所有层级的列表都自动拥有 ＋ 新增 / × 删除 / ↑↓ 排序，新增板块类型
   也只需在 schema 里注册一次，不必再改本文件。 */
const editor = document.getElementById('editor');
function renderEditor(){
  editor.innerHTML = ES.renderEditorHTML(data);
}

/* 三类控件各用一套寻址属性，互不干扰：
     · 字段      data-path（对象路径）+ data-field（属性名；空 = 整行就是该值）
     · 间距微调  data-spath（挂间距的对象路径）+ data-sp（间距属性名）+ data-pos（mt/mb）
     · 列表操作  data-act（add/del/up/down）+ data-list（数组路径）+ data-listid + data-idx
   替代了原先 data-sec/data-iidx/data-gidx/data-pidx/data-cidx/data-tidx 六套索引
   与 'j:s1:0:company' 这类字符串编码解析。 */
editor.addEventListener('input', e=>{
  const t = e.target;
  const ds = t.dataset || {};
  if(ds.spath === undefined && ds.path === undefined) return;   // 非编辑区字段，忽略
  RB.recordHistory('edit');   // 每次输入前记录（同类型短时间内的连续输入会合并为一个撤销步）
  if(ds.spath !== undefined){
    if(ES.writeSpacingInput(data, ds, t.value)) renderPreview();
    return;
  }
  if(ES.writeInput(data, ds, ES.coerceInput(t.type, t.value, t.checked))) renderPreview();
});

/* 列表操作：一套通用实现覆盖所有层级（板块 / 公司 / 项目 / 量化成果 /
   技能分组 / 技能点 / 高亮卡 / 标签芯片 / 阶段 / 联系方式）。
   返回 true 表示数据真的变了，调用方据此重渲染（校验失败或首末位空转不重渲染，
   避免无意义地重建表单、丢掉滚动位置）。 */
function handleListAction(b){
  const ds = b.dataset || {};
  if(!ds.act || ds.list === undefined) return false;
  const verdict = ES.checkAction(data, ds);
  if(!verdict.ok){
    if(verdict.message) alert(verdict.message);   // 如「至少保留一个板块，无法删除。」
    return false;
  }
  if(verdict.confirm && !confirm(verdict.confirm)) return false;
  if(verdict.noop) return false;
  RB.recordHistory('action');   // 先记快照再改数据，撤销才能回到改前
  return ES.applyAction(data, ds);
}
editor.addEventListener('click', e=>{
  const b = e.target.closest('button[data-act]'); if(!b) return;
  if(handleListAction(b)){ renderEditor(); renderPreview(); }
});

/* ============ 撤销 / 重做（全量状态快照栈） ============ */
/* 取当前完整状态的可序列化快照 */

/* ============ 字体设置 ============ */
const settings = document.getElementById('settings');
function renderSettings(){
  settings.innerHTML = Object.keys(currentFonts).map(k=>{
    const s=currentFonts[k];
    return `<div class="setting"><label>${esc(s.label)}${s.desc?`<small>${esc(s.desc)}</small>`:''}</label>`
      +`<input type="number" min="${z(s.min)}" max="${z(s.max)}" step="0.5" value="${z(s.val)}" data-key="${esc(k)}"></div>`;
  }).join('');
  settings.querySelectorAll('input').forEach(inp=>{
    inp.addEventListener('input', function(){
      const k=this.dataset.key; let v=parseFloat(this.value); if(isNaN(v)) return;
      RB.recordHistory('setting');
      v=Math.max(currentFonts[k].min, Math.min(currentFonts[k].max, v));
      currentFonts[k].val=v; renderPreview();
    });
  });
}
function resetFonts(){ RB.recordHistory('action'); currentFonts=JSON.parse(JSON.stringify(defaultFonts)); renderSettings(); renderPreview(); }
function renderSpacingSettings(){
  const wrap = document.getElementById('spacingSettings');
  wrap.innerHTML = Object.keys(currentSpacing).map(k=>{
    const s=currentSpacing[k];
    return `<div class="setting"><label>${esc(s.label)}</label>`
      +`<span style="display:flex;gap:6px;align-items:center;">`
      +`<small style="color:var(--ui-faint);">上</small><input type="number" min="-40" max="80" step="1" value="${z(s.mt)}" data-k="${esc(k)}" data-pos="mt" title="上间距" style="width:46px;">`
      +`<small style="color:var(--ui-faint);">下</small><input type="number" min="-40" max="80" step="1" value="${z(s.mb)}" data-k="${esc(k)}" data-pos="mb" title="下间距" style="width:46px;">`
      +`</span></div>`;
  }).join('');
  wrap.querySelectorAll('input').forEach(inp=>{
    inp.addEventListener('input', function(){
      const k=this.dataset.k; const pos=this.dataset.pos;
      let v=parseFloat(this.value); if(isNaN(v)) return;
      RB.recordHistory('setting');
      v=Math.max(-40, Math.min(80, v));
      currentSpacing[k][pos] = v; renderPreview();
    });
  });
}
function resetSpacing(){ RB.recordHistory('action'); currentSpacing=JSON.parse(JSON.stringify(defaultSpacing)); renderSpacingSettings(); renderPreview(); }
function renderMarginSettings(){
  const wrap = document.getElementById('marginSettings');
  if(!wrap) return;
  const m = getPageMargins();
  const mk = (label, key)=>`<div class="setting"><label>${label}</label><input type="number" min="0" max="60" step="1" value="${m[key]}" data-margin="${key}" title="${label}" style="width:60px;"></div>`;
  wrap.innerHTML = mk('上边距', 'top') + mk('右边距', 'right') + mk('下边距', 'bottom') + mk('左边距', 'left');
  wrap.querySelectorAll('input[data-margin]').forEach(inp=>{
    inp.addEventListener('input', function(){
      const key = this.dataset.margin;
      let v = parseFloat(this.value); if(isNaN(v)) return;
      RB.recordHistory('setting');
      v = Math.max(0, Math.min(60, v));
      data.pageMargins = data.pageMargins || {top:14, right:14, bottom:14, left:14};
      data.pageMargins[key] = v;
      renderPreview();
    });
  });
}
function resetMargins(){ RB.recordHistory('action'); data.pageMargins = JSON.parse(JSON.stringify(defaultPageMargins)); renderMarginSettings(); renderPreview(); }

/* ============ A4 分页参考线（与 PDF 截图分页严格对齐，支持强制换页） ============ */
let guidesOn = false;
/* 以 A4 210 mm 为基准，把页边距去掉后得到内容区域；
   分页参考线与图片版 PDF 都按内容区域高度计算。
   ⚠️ 内容区高度必须是「纸张高 - 上下页边距」= (297 - top - bottom) mm。
   历史 bug（2026-09-22 修）：这里曾写 contentW * 297/210 —— 把整张纸的长宽比套在内容区
   宽度上，得到的是「以内容区为宽的整页高」，比真实可打印高度少 (top+bottom)*(297/210)
   ≈ 11mm/页。后果是三条链路互相打架：
     · 预览分页参考线比真实纸面页底高 11mm；
     · 图片版 PDF 每页少装 11mm 内容（同样的简历多出一页），且把切片按
       h/pageH * contentH 贴到纸上时纵向被拉伸 269/257.4 = 4.5%（字被压扁/拉长）；
     · 矢量版（Chrome 打印，内容盒实测 688×1017 px = 182×269 mm）与上面两者都对不上。
   root 可选：导出时要量「被截图的那个克隆节点」（它与实时预览同宽同 padding，
   传进来才能保证切口与实际截到的像素严格对齐）；不传则量实时预览。 */
function getPageMetrics(root){
  const resume = root || preview.querySelector('.resume');
  if(!resume) return null;
  const m = getPageMargins();
  const pl = mmToPx(m.left), pr = mmToPx(m.right), pt = mmToPx(m.top), pb = mmToPx(m.bottom);
  const pageW = resume.offsetWidth;       // A4 实际渲染宽度（px）
  const contentW = pageW - pl - pr;       // A4 内容区域宽度（px）
  /* 内容区高度（px）：纸张 297mm 去掉上下页边距。safeMm 兜底 null/非法值（Number(null)===0 坑） */
  const contentHmm = Math.max(1, 297 - safeMm(m.top, 14) - safeMm(m.bottom, 14));
  const pageH = mmToPx(contentHmm);       // A4 内容区域高度（px）
  const totalH = Math.max(0, resume.offsetHeight - pt - pb); // 内容总高度（px）
  return { resume, pageW, contentW, pageH, contentHmm, totalH, pt, pr, pb, pl };
}
/* ============ 分页「不切行」吸附 ============
   问题：图片版 PDF 按「内容区高度等分」切片，切点落在文字行中间时，那一行会被拦腰
   截断（上半行留在这页底部、下半行跑到下页顶部），导出成品看着像渲染坏了。
   做法：把每个「自然分页点」上移到此点之前最近的、不与任何内容相交的位置（行间空白 /
   段落间距），再交给导出切片；分页参考线用同一份结果绘制，所以预览里的分页线与
   导出 PDF 的切口依然严格对齐。
   不参与吸附的位置：首行（0）、强制换页点（.page-break-before）、末页边界（内容总高）。
   分两层：collectInkBoxes 量 DOM（含单位换算），snapBreaksToBoxes 是纯函数（可单测）。 */

/* 量出 .resume 内所有「会落到纸上」的盒子，换算成内容区坐标（px，已抵消预览等比缩放）。
   三类来源：
   1) 文本行盒：Range 覆盖每个文本节点，逐行一个 rect —— 简历里 99% 的墨都在这里；
   2) 替换元素：img / svg / canvas / video …（Range 量不到，但一样会被切）
   3) 跨过候选切点的元素框线：1~2px 分隔线被切一半同样难看（板块标题下的横线等）。
      只对「正好跨过候选切点」的元素读 computedStyle，避免每次重绘全量读样式。 */
function collectInkBoxes(resume, metrics, cands){
  const out = [];
  if(!resume || typeof resume.getBoundingClientRect !== 'function') return out;
  let base;
  try{ base = resume.getBoundingClientRect(); }catch(e){ return out; }
  const layoutW = z(resume.offsetWidth);
  const scale = layoutW > 0 ? (base.width / layoutW) : 1;   // transform:scale 补偿
  if(!(scale > 0)) return out;
  const pt = metrics ? z(metrics.pt) : 0;
  /* 入参是设备像素（getBoundingClientRect 的坐标系），出口统一换成内容区坐标 */
  const push = function(topDev, bottomDev){
    const t = (topDev - base.top) / scale - pt;
    const b = (bottomDev - base.top) / scale - pt;
    if(b - t > 0.4) out.push({ top: t, bottom: b });
  };
  const pushRect = function(r){
    if(!r) return;
    if(!(r.width > 0.5) || !(r.height > 0.5)) return;
    push(r.top, r.bottom);
  };
  const safeRect = function(el){
    try{ return el.getBoundingClientRect(); }catch(e){ return null; }
  };

  /* 1) 文本行盒 —— Range 覆盖文本节点，逐行给出 rect */
  const doc = resume.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if(doc && typeof doc.createRange === 'function' && typeof doc.createTreeWalker === 'function'){
    const range = doc.createRange();
    if(range && typeof range.getClientRects === 'function' && typeof range.selectNodeContents === 'function'){
      let walker = null;
      try{ walker = doc.createTreeWalker(resume, 4 /* NodeFilter.SHOW_TEXT */, null, false); }catch(e){ walker = null; }
      if(walker){
        /* 上限只是防「桩对象返回自己」这类死循环，正常文本节点数远小于它 */
        for(let guard=0; guard<20000; guard++){
          let node = null;
          try{ node = walker.nextNode(); }catch(e){ break; }
          if(!node) break;
          const txt = node.nodeValue;
          if(!txt || !txt.trim()) continue;
          const pe = node.parentElement;
          /* ↑↓ 重排按钮不进导出（克隆时被删掉），别让它们的箭头影响吸附结果 */
          if(pe && typeof pe.closest === 'function' && pe.closest('.reorder-btns')) continue;
          try{
            range.selectNodeContents(node);
            const rects = range.getClientRects();
            for(let i=0;i<rects.length;i++) pushRect(rects[i]);
          }catch(e){}
        }
      }
    }
  }

  /* 2) 替换元素（没有文本节点，但一样占纸面） */
  if(typeof resume.querySelectorAll === 'function'){
    let atoms = null;
    try{ atoms = resume.querySelectorAll('img,svg,canvas,video,iframe,object,embed'); }catch(e){ atoms = null; }
    if(atoms) for(let i=0;i<atoms.length;i++) pushRect(safeRect(atoms[i]));
  }

  /* 3) 框线：只处理正好跨过候选切点的元素，避免全量 computedStyle 开销 */
  const gcs = (global && typeof global.getComputedStyle === 'function') ? global.getComputedStyle : null;
  if(gcs && cands && cands.length && typeof resume.querySelectorAll === 'function'){
    let els = null;
    try{ els = resume.querySelectorAll('*'); }catch(e){ els = null; }
    if(els){
      for(let i=0;i<els.length;i++){
        const el = els[i];
        if(el === resume) continue;                 // 根节点自身（整页背景）不算墨
        const r = safeRect(el);
        if(!r || !(r.height > 0.5) || !(r.width > 0.5)) continue;
        const t = (r.top - base.top) / scale - pt, b = (r.bottom - base.top) / scale - pt;
        let hit = false;
        for(let k=0;k<cands.length;k++){
          if(t < cands[k] - 0.5 && b > cands[k] + 0.5){ hit = true; break; }
        }
        if(!hit) continue;
        let cs = null;
        try{ cs = gcs(el); }catch(e){ cs = null; }
        if(!cs) continue;
        const bw = function(k){ const v = parseFloat(cs[k]); return isNaN(v) ? 0 : v; };
        const bt = bw('borderTopWidth'), bb = bw('borderBottomWidth');
        const bl = bw('borderLeftWidth'), br = bw('borderRightWidth');
        /* 横线只占一条细带：把那条带标成墨即可（切点会挪到它上面一点点） */
        if(bt > 0.2) push(r.top, r.top + bt * scale);
        if(bb > 0.2) push(r.bottom - bb * scale, r.bottom);
        /* 竖线（左侧引用条等）一旦被切断就是断口，整块让到下一页更稳 */
        if(bl > 0.2 || br > 0.2) push(r.top, r.bottom);
      }
    }
  }
  return out;
}

/* 纯函数：把分页点吸附到「不与任何内容盒相交」的位置。
   breaks: [{ y, hard }]（升序，内容区坐标 px；hard=true 的位置不参与吸附）
   boxes : [{ top, bottom }]（会落墨的盒子）
   maxShift: 单个分页点最多上移多少 px（<=0 表示关闭吸附）
   返回 y 数组（与 breaks 等长、单调不减）。
   ⚠️ 窗口内找不到空档时保留原几何切点：宁可切一行，也不要把整页掏空成半页。 */
function snapBreaksToBoxes(breaks, boxes, maxShift){
  const list = [];
  (boxes || []).forEach(function(b){ if(b && (b.bottom - b.top) > 0.4) list.push(b); });
  const src = breaks || [];
  const out = [];
  const shift = z(maxShift);
  for(let i=0;i<src.length;i++){
    const cur = src[i] || { y: 0, hard: true };
    let y = z(cur.y);
    if(!cur.hard && i > 0 && shift > 0 && list.length){
      const floor = Math.max(z(out[i-1]) + 1, y - shift);
      let probe = y;
      /* 每轮至少上移 0.5px，所以循环次数必然收敛；guard 只是防御性上限 */
      for(let guard=0; guard<list.length+1; guard++){
        let bestTop = -Infinity;
        for(let k=0;k<list.length;k++){
          const b = list[k];
          if(b.top < probe - 0.5 && b.bottom > probe + 0.5 && b.top > bestTop) bestTop = b.top;
        }
        if(bestTop === -Infinity) break;            // 落在空档 → 收敛
        if(bestTop < floor){ probe = null; break; } // 上移量超预算 → 放弃吸附
        probe = bestTop;
      }
      if(probe !== null) y = Math.round(probe);
    }
    out.push(y);
  }
  return out;
}

/* 单个分页点最多能上移多少 px：吸附会让那一页变高，而切片按
   (h / pageH) * contentH 换算成毫米贴到纸上 —— 页底最多还能吃掉 80% 下边距
   而不越出纸张（越出会被 PDF 物理页边裁掉）。下限 10px 保证 0 页边距时也能救回切行，
   上限 36px 防止一页被塞得过满。 */
function pageSnapBudget(pageHpx){
  const m = getPageMargins();
  const contentH_mm = Math.max(1, 297 - z(m.top) - z(m.bottom));
  const mmPerPx = contentH_mm / Math.max(1, z(pageHpx));
  const budget = (z(m.bottom) * 0.8) / mmPerPx;
  return Math.max(10, Math.min(36, Math.round(budget)));
}

// 计算真实分页位置：先收集右侧勾选的「强制换页」元素 offsetTop，再与自然 A4 高度取并集
// 返回的 break 值是相对于内容区域顶部的偏移（不含上页边距）；自然分页点已做「不切行」吸附
function computePageBreaks(root){
  const m = getPageMetrics(root);
  if(!m) return [];
  const { resume, pageH, totalH, pt } = m;
  const forced = Array.from(resume.querySelectorAll('.page-break-before'))
    .map(el => (el.offsetTop - resume.offsetTop) - pt)
    .filter(y => y > 2)
    .sort((a, b) => a - b);
  const marks = [{ y: 0, hard: true }];
  let last = 0;
  for(const y of forced){
    let cy = last;
    while(cy + pageH < y - 1){ cy += pageH; marks.push({ y: Math.round(cy), hard: false }); }
    marks.push({ y: Math.round(y), hard: true });   // 强制换页点：切在板块顶上，不允许上移
    last = y;
  }
  let cy = last;
  while(cy + pageH < totalH - 1){ cy += pageH; marks.push({ y: Math.round(cy), hard: false }); }
  // 最后一页边界
  if(marks[marks.length-1].y < totalH - 1) marks.push({ y: Math.round(totalH), hard: true });
  // 去重并排序（浮点像素可能产生极小误差，取整）；同一点上 hard 优先（不可吸附）
  const byY = new Map();
  marks.forEach(k => { byY.set(k.y, k.hard || !!byY.get(k.y)); });
  const list = [];
  byY.forEach((hard, y) => list.push({ y: y, hard: hard }));
  list.sort((a, b) => a.y - b.y);
  // 吸附：把自然分页点挪到行间空白处，避免把文字行 / 图片 / 分隔线切成两半
  const snappable = [];
  list.forEach(k => { if(!k.hard) snappable.push(k.y); });
  if(!snappable.length) return list.map(k => k.y);
  let boxes = [];
  try{ boxes = collectInkBoxes(resume, m, snappable); }catch(e){ boxes = []; }
  return snapBreaksToBoxes(list, boxes, pageSnapBudget(pageH));
}
function drawPageGuides(){
  preview.querySelectorAll('.page-guide').forEach(g=>g.remove());
  if(!guidesOn) return;
  const m = getPageMetrics();
  if(!m) return;
  const breaks = computePageBreaks();
  if(breaks.length < 2) return;
  const rect = m.resume.getBoundingClientRect();
  const prect = preview.getBoundingClientRect();
  const left = rect.left - prect.left + m.pl;
  const frag = document.createDocumentFragment();
  for(let n = 1; n < breaks.length; n++){
    const y = breaks[n] + m.pt;
    const d = document.createElement('div'); d.className = 'page-guide';
    d.style.top = (rect.top - prect.top + y) + 'px';
    d.style.left = left + 'px';
    d.style.right = 'auto';
    d.style.width = m.contentW + 'px';
    d.innerHTML = '<span>第 ' + n + ' 页底 / 第 ' + (n + 1) + ' 页顶</span>';
    frag.appendChild(d);
  }
  preview.appendChild(frag);
}
/* #9：drawPageGuides 合并到下一帧，避免每键 renderPreview 同步重画分页线
   （DOM 查询 + getBoundingClientRect + 建碎片，逐键同步很贵）。rAF 不存在时（测试桩 / 老浏览器）
   直接同步执行，保证行为一致；已有待执行帧则合并，不堆叠。 */
let _guideRaf = null;
function scheduleDrawPageGuides(){
  if(_guideRaf) return;
  if(typeof requestAnimationFrame !== 'function'){ drawPageGuides(); return; }
  _guideRaf = requestAnimationFrame(function(){
    _guideRaf = null;
    drawPageGuides();
  });
}
function toggleGuides(){
  guidesOn = !guidesOn;
  /* 两端各一个按钮（桌面 / 手机同一份入口清单）→ 都更新；
     且必须判空：此前裸取 textContent，元素不在就会直接抛错中断切换。 */
  ['guideBtn', 'guideBtnMobile'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = guidesOn ? '隐藏分页线' : '显示分页线';
  });
  drawPageGuides();
}
window.addEventListener('resize', ()=>{ if(guidesOn) scheduleDrawPageGuides(); });

/* ============ 预览等比缩放：窄屏下让 A4 整页可见 ============
   为什么用 transform 而不是 zoom / 改宽度：
   - transform 只影响绘制，不触发重排 → offsetWidth/offsetHeight 读数与实际排版不变，
     与打印/导出的 WYSIWYG 一致（zoom 实测会使内容重排，offsetHeight 2451→2464）；
   - 导出用的 makeCaptureClone 会显式 clone.style.transform='none' 且用 live.offsetWidth 取尺寸，
     因此缩放不会污染导出成品；
   - 打印由 @media print 里的 !important 复位（见 css/style.css）。
   触发时机：预览尺寸变化、内容重渲染（renderPreview 会重建 .resume 节点）、窗口缩放/旋转。 */
function applyPreviewScale(){
  const resume = preview.querySelector('.resume');
  if(!resume) return;
  const cs = getComputedStyle(preview);
  const avail = preview.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  const naturalW = resume.offsetWidth, naturalH = resume.offsetHeight;
  if(avail <= 0 || !naturalW || !naturalH) return;   // 预览不可见（手机处于编辑/同步页）时跳过
  const s = Math.min(1, avail / naturalW);
  const scaled = s < 0.999;
  preview.classList.toggle('is-scaled', scaled);
  if(!scaled){
    resume.style.transform = '';
    resume.style.transformOrigin = '';
    resume.style.marginBottom = '';
    return;
  }
  resume.style.transformOrigin = 'top left';
  resume.style.transform = 'translateX(' + Math.max(0, (avail - naturalW * s) / 2) + 'px) scale(' + s + ')';
  // 视觉高度变为 naturalH*s，用负 margin 把布局高度补回缩放后的高度，避免底部出现大片空白
  resume.style.marginBottom = (-(1 - s) * naturalH) + 'px';
}
/* 性能债第 3 层（评估文档 §4.4）：applyPreviewScale 每次读 getComputedStyle + clientWidth +
   offsetWidth/offsetHeight（强制 reflow），而 MutationObserver（每键 renderPreview 重建 .resume 节点）
   + ResizeObserver + resize/orientationchange 都会直接触发它 → 每键一次完整 reflow。
   改为 rAF 合并到单帧（与 #9 分页线同款）：高频的 observer/resize 触发统一走 schedulePreviewScale，
   同一帧内多次触发只执行一次；rAF 缺失时（测试桩/老浏览器）回退同步执行保持行为一致。 */
let _scaleRaf = null;
function schedulePreviewScale(){
  if(_scaleRaf) return;
  if(typeof requestAnimationFrame !== 'function'){ applyPreviewScale(); return; }
  _scaleRaf = requestAnimationFrame(function(){
    _scaleRaf = null;
    applyPreviewScale();
  });
}
if(typeof MutationObserver === 'function'){
  new MutationObserver(schedulePreviewScale).observe(preview, {childList:true});
}
if(typeof ResizeObserver === 'function'){
  new ResizeObserver(schedulePreviewScale).observe(preview);
}
window.addEventListener('resize', schedulePreviewScale);
window.addEventListener('orientationchange', schedulePreviewScale);

function migrateQuoteColors(d){
  (d.sections||[]).forEach(sec=>{
    if(sec.type==='career'){
      (sec.items||[]).forEach(job=>{
        if(job.summaryColor==='#1a1a1a') job.summaryColor='#888888';
      });
    }
  });
}
/* 移除旧版「插入分页符」痕迹：删除 <<PAGE_BREAK>> 标记、__break 占位块；
   并将联系方式 / 量化成果 / 技能点 的纯字符串数组升级为 {text, spacing} 对象数组 */
const PB = '<<PAGE_BREAK>>';
function stripPB(s){ return String(s==null?'':s).split(PB).join(''); }
function toLine(x){
  if(x && typeof x==='object' && 'text' in x){
    x.text = stripPB(x.text);
    /* 历史遗留：2026-09-20 之前的编辑区把「行间距微调」错写成了行对象的 mt/mb
       （预览读的是 .spacing，所以那批数值一直没生效）。这里把它们搬回正确位置后删掉脏字段。 */
    if(x.mt!==undefined || x.mb!==undefined){
      if(!x.spacing) x.spacing = {mt: z(x.mt), mb: z(x.mb)};
      delete x.mt; delete x.mb;
    }
    x.spacing = x.spacing || {mt:0,mb:0};
    return x;
  }
  return {text: stripPB(x||''), spacing:{mt:0,mb:0}};
}
/* 高亮卡：兼容「纯字符串」与「{text}」两种旧形态（旧数据的字符串卡此前会被预览整张丢掉） */
function toCard(x){
  if(x && typeof x==='object'){
    x.text = T(x);
    x.spacing = x.spacing || {mt:0,mb:0};
    return x;
  }
  return {text: T(x), spacing:{mt:0,mb:0}};
}
function ensureSpacing(obj, fields){ if(!obj) return; fields.forEach(f=>{ if(obj[f+'Spacing']==null) obj[f+'Spacing']={mt:0,mb:0}; }); }
function migrateSpacing(d){
  /* 旧版把联系方式的行间距存在根级 contactSpacing[] 数组里（与预览读取位置不一致），
     统一折叠回每行自己的 spacing；同时兼容直接挂在行上的 mt/mb。 */
  if(Array.isArray(d.contact)) d.contact = d.contact.map(toLine);
  if(Array.isArray(d.contactSpacing)){
    d.contact.forEach((c,i)=>{
      const leg = d.contactSpacing[i];
      const cur = (c && typeof c==='object') ? c.spacing : null;
      if(leg && (!cur || (!cur.mt && !cur.mb))){
        c.spacing = {mt: z(leg.mt), mb: z(leg.mb)};
      }
    });
    delete d.contactSpacing;
  }
  (d.sections||[]).forEach(sec=>{
    if(sec.spacing==null) sec.spacing={mt:0,mb:0};
    if(sec.type==='advantages'){
      sec.items = (sec.items||[]).filter(it=>!it.__break).map(it=>{ it.spacing=it.spacing||{mt:0,mb:0}; it.text=stripPB(it.text||''); return it; });
    } else if(sec.type==='career'){
      sec.items = (sec.items||[]).filter(j=>!j.__break).map(job=>{
        ensureSpacing(job, ['company','role','date','summary','logo','logoSize','logoWidth','logoGap']);
        job.spacing=job.spacing||{mt:0,mb:0};
        ['company','role','date','summary'].forEach(f=> job[f]=stripPB(job[f]||''));
        (job.projects||[]).forEach(p=>{
          ensureSpacing(p, ['name','stack','desc']);
          p.spacing=p.spacing||{mt:0,mb:0};
          ['name','stack','desc'].forEach(f=> p[f]=stripPB(p[f]||''));
          p.results=(p.results||[]).map(toLine);
        });
        return job;
      });
    } else if(sec.type==='skills'){
      sec.groups = (sec.groups||[]).filter(g=>!g.__break).map(grp=>{
        ensureSpacing(grp, ['name','keywords','detail']); grp.spacing=grp.spacing||{mt:0,mb:0};
        grp.name=stripPB(grp.name||'');
        /* 关键词行 / 说明行：统一压成字符串（兼容旧数据里的 {text} 形态） */
        grp.keywords=stripPB(T(grp.keywords||''));
        grp.detail=stripPB(T(grp.detail||''));
        grp.items=(grp.items||[]).map(toLine);
        return grp;
      });
    } else if(sec.type==='projects'){
      sec.items = (sec.items||[]).filter(it=>!it.__break).map(p=>{
        ensureSpacing(p, ['name','stack','desc']); p.spacing=p.spacing||{mt:0,mb:0};
        ['name','stack','desc'].forEach(f=> p[f]=stripPB(p[f]||''));
        p.results=(p.results||[]).map(toLine);
        return p;
      });
    } else if(sec.type==='highlights'){
      /* 高亮卡此前完全没有迁移：cards 若是纯字符串，预览会整张丢掉；tags 保持纯字符串数组 */
      sec.cards = (sec.cards||[]).map(toCard);
      sec.tags = (sec.tags||[]).map(t=>String(T(t)));
    } else if(sec.type==='growth'){
      sec.phases = (sec.phases||[]).map(ph=>{
        ensureSpacing(ph, ['label','date','title','desc']);
        ph.spacing = ph.spacing || {mt:0,mb:0};
        return ph;
      });
    }
  });
}

/* v6 迁移：新版间距默认值新增「公司块」「技能分组」独立类型，并整体收紧；
   若用户本地仍保存旧版默认值，直接重置为当前 defaultSpacing（保留每行独立微调） */
function migrateSpacingDefaults(){
  currentSpacing = JSON.parse(JSON.stringify(defaultSpacing));
}

// 迁移：确保 career 板块每段的 pageBreak 为合法布尔值（旧数据可能缺失该字段）
function migratePageBreaks(d){
  (d.sections||[]).forEach(sec=>{
    if(sec.type==='career'){
      (sec.items||[]).forEach(job=>{
        if(job.pageBreak === undefined) job.pageBreak = false;
      });
    }
    // 板块级 pageBreak：缺失补 false（让「强制本板块从新一页开始」开关默认关闭）
    if(typeof sec.pageBreak !== 'boolean') sec.pageBreak = false;
  });
}

global.ResumeRender = {
  // pure utils
  esc: esc, boldText: boldText, getSection: getSection, getVarStr: getVarStr,
  spacingStyle: spacingStyle, z: z, getPageMargins: getPageMargins,
  mmToPx: mmToPx, pxToMm: pxToMm, T: T, S: S,
  // html builders
  renderResumeInner: renderResumeInner,
  buildResumeHtml: buildResumeHtml,
  // constructors（实现已收敛到 editor-schema.js，这里保持导出名不变）
  blankItem: blankItem, blankProject: blankProject, blankSection: blankSection,
  blankPhase: blankPhase, blankSkillGroup: blankSkillGroup, objify: objify,
  // 编辑区 schema（供外部/测试直接访问引擎）
  EditorSchema: ES,
  // preview + drag
  safeMm: safeMm, syncPrintPageMargin: syncPrintPageMargin,
  renderPreview: renderPreview,
  // 触屏 ↑↓ 排序（#8）：纯重排逻辑 + 按钮 HTML，均不碰 DOM
  reorderWithin: reorderWithin, reorderBtns: reorderBtns,
  // N9 project-cards 板块的卡片重排（数组挂在 sec.cards，与 items/groups 不同）
  moveCard: moveCard,
  // N3-F1 锁定态判定（拖拽 / ↑↓ 重排的守卫条件）
  isDocLocked: isDocLocked,
  // editor form
  renderEditor: renderEditor, handleListAction: handleListAction,
  // settings panels
  renderSettings: renderSettings, resetFonts: resetFonts,
  renderSpacingSettings: renderSpacingSettings, resetSpacing: resetSpacing,
  renderMarginSettings: renderMarginSettings, resetMargins: resetMargins,
  // page guides
  getPageMetrics: getPageMetrics, computePageBreaks: computePageBreaks,
  collectInkBoxes: collectInkBoxes, snapBreaksToBoxes: snapBreaksToBoxes, pageSnapBudget: pageSnapBudget,
  drawPageGuides: drawPageGuides, toggleGuides: toggleGuides,
  applyPreviewScale: applyPreviewScale,
  schedulePreviewScale: schedulePreviewScale,
  migrateQuoteColors: migrateQuoteColors,
  migrateSpacing: migrateSpacing,
  migrateSpacingDefaults: migrateSpacingDefaults,
  migratePageBreaks: migratePageBreaks
};
})(typeof window !== "undefined" ? window : globalThis);
