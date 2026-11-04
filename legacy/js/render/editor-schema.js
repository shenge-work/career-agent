/* =============================================================
 * 内容编辑区：声明式 schema + 通用渲染 / 写回引擎
 * -------------------------------------------------------------
 * 为什么要有这个文件（改造前的三个真实痛点）：
 *   1) 「加一种新板块类型」要同时改 6 处：blankSection 工厂、renderResumeInner
 *      预览分支、编辑卡卡片 HTML、字段写回的 if-else、点击按钮的 if-else、
 *      「添加板块」按钮列表 —— 漏一处就是静默缺功能。
 *   2) 列表型数据的「增 / 删 / 上移 / 下移」每个类型各写一遍，而且
 *      联系方式、量化成果、技能点 三处根本没写：用户只能改已有行，
 *      加不出新行（本次需求就是「联系方式要能用 + 号继续新增」）。
 *   3) 间距微调的目标对象靠字符串编码（'j:s1:0:company'）手工解析，
 *      联系方式 / 量化成果 / 技能点 都写错了位置（写到了行对象的 mt/mb 上，
 *      而预览读的是行对象的 spacing），表现为「数值调了没反应」。
 *      高亮卡 / 标签 / 阶段标签 更是渲染了输入框但没有任何写回分支（假控件）。
 *
 * 本文件把「编辑区长什么样、值写回哪里」变成**数据**：
 *   · 字段描述符 field  { key,label,kind,spacing,def,min,max,rows,placeholder }
 *   · 列表描述符 list   { id,path,tag,noun,create,min,minMessage,confirm,
 *                         fields,lists,leaf,emptyHint,tagOf }
 *   · 板块类型 def      register({ type,label,create,lists })
 *   · 寻址统一走点分路径：控件带 data-path / data-spath，
 *     列表操作带 data-list / data-listid / data-idx，
 *     不再有 data-iidx / data-gidx / data-pidx / data-cidx / data-tidx 五套索引。
 *
 * 于是「新增一种板块类型」= 调一次 register()，其余全自动；
 * 任何一层列表都自动获得 ＋ 新增 / × 删除 / ↑↓ 排序 / 空态提示。
 *
 * 纯数据 + 纯函数：不碰 DOM、不读全局 data（root 一律由调用方传入）。
 * 挂 window.ResumeEditorSchema，由 js/render/resume-render.js 消费。
 * ⚠️ 加载顺序：本文件必须在 js/render/resume-render.js 之前（后者从这里取
 *    esc / T / S / z / objify / blank* 等基础件，保持单一实现）。
 * ============================================================= */
(function (global) {
  "use strict";

  /* ============================================================
   * 一、基础件（与文件头说明一致：本项目所有地方共用这一份实现）
   * ============================================================ */
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  /* 取文本：兼容「对象 {text}」与「纯字符串」两种数据形态（迁移过渡用） */
  function T(x) { return (x && typeof x === 'object' && 'text' in x) ? (x.text || '') : (x || ''); }
  /* 取行内间距对象：兼容两种形态 */
  function S(x) { return (x && typeof x === 'object' && 'spacing' in x) ? x.spacing : (x || {}); }
  /* 数值化：空 / 非法一律 0（间距与尺寸都靠它兜底） */
  function z(v) { return (v == null || v === '' || Number.isNaN(Number(v))) ? 0 : Number(v); }
  /* 行对象工厂：列表里的「一行文本 + 该行独立间距」统一形态 */
  function line(text) { return { text: text == null ? '' : String(text), spacing: { mt: 0, mb: 0 } }; }
  /* 把「旧形态」升级为行对象（保留原有 text 与 spacing；纯字符串也接受） */
  function objify(x, text) {
    const sp = (x && typeof x === 'object' && x.spacing) ? x.spacing : { mt: 0, mb: 0 };
    return { text: text == null ? '' : text, spacing: sp };
  }

  /* ============================================================
   * 二、点分路径寻址
   *   路径都是「对象自身」的路径，如 contact.0 / sections.2.items.1；
   *   要写对象里的哪个键由 data-field 决定（空 = 整行就是那个值，见 leaf 列表）。
   * ============================================================ */
  function pathJoin(base, seg) { return base ? (base + '.' + seg) : String(seg); }
  function pathSegs(pathStr) {
    return String(pathStr == null ? '' : pathStr).split('.').filter(function (s) { return s !== ''; });
  }
  /* 解析到「父对象 + 键 + 值」；空路径 → 根对象自身 */
  function resolve(root, pathStr) {
    const segs = pathSegs(pathStr);
    if (!segs.length) return { owner: null, key: '', value: root, segs: segs };
    let cur = root, owner = null, key = '';
    for (let i = 0; i < segs.length; i++) {
      if (cur == null) return null;
      owner = cur; key = segs[i]; cur = cur[key];
    }
    return { owner: owner, key: key, value: cur, segs: segs };
  }
  /* 取路径指向的对象（写字段 / 写间距都用它） */
  function objAt(root, pathStr) { const r = resolve(root, pathStr); return r ? r.value : null; }
  /* 写对象上的字段 */
  function writeField(root, objPath, fieldKey, value) {
    const o = objAt(root, objPath);
    if (!o || typeof o !== 'object' || !fieldKey) return false;
    o[fieldKey] = value;
    return true;
  }
  /* 写「整行就是值」的 leaf 行（如标签芯片是纯字符串数组） */
  function writeLeaf(root, itemPath, value) {
    const r = resolve(root, itemPath);
    if (!r || !r.owner || !r.key) return false;
    r.owner[r.key] = value;
    return true;
  }
  /* 写行内间距微调：对象路径 + 间距属性名（spacing / companySpacing / nameSpacing…） */
  function writeSpacing(root, objPath, prop, pos, value) {
    if (pos !== 'mt' && pos !== 'mb') return false;
    const base = objAt(root, objPath);
    if (!base || typeof base !== 'object') return false;
    if (!base[prop] || typeof base[prop] !== 'object') base[prop] = { mt: 0, mb: 0 };
    base[prop][pos] = z(value);
    return true;
  }
  /* 控件值 → 模型值（类型归一，纯函数，便于测试） */
  function coerceInput(type, value, checked) {
    if (type === 'checkbox') return !!checked;
    if (type === 'number') return value === '' ? '' : Number(value);
    return value;
  }

  /* ============================================================
   * 三、模型工厂（板块 / 条目 / 项目 / 阶段）
   *   这些是「数据结构」的唯一来源：新增板块、导入兜底、测试都走这里。
   * ============================================================ */
  function newSectionId() { return 's_' + Math.random().toString(36).slice(2, 9); }
  function sp() { return { mt: 0, mb: 0 }; }

  function blankItem(type) {
    if (type === 'advantages') return { label: '', text: '', labelBold: true, spacing: sp() };
    if (type === 'career') return {
      company: '', role: '', date: '', summary: '', summaryQuote: true, summaryColor: '#888888',
      pageBreak: false, projects: [], spacing: sp(),
      companySpacing: sp(), roleSpacing: sp(), dateSpacing: sp(), summarySpacing: sp(),
      logoSpacing: sp(), logoSizeSpacing: sp(), logoWidthSpacing: sp(), logoGapSpacing: sp()
    };
    if (type === 'projects') return blankProject();
    if (type === 'kpi-band') return blankKpiItem();
    if (type === 'project-cards') return blankProjectCard();
    return {};
  }
  function blankProject() {
    return {
      name: '', stack: '', desc: '', results: [], descQuote: true, descColor: '#888888', pageBreak: false,
      spacing: sp(), nameSpacing: sp(), stackSpacing: sp(), descSpacing: sp()
    };
  }
  function blankPhase() {
    return {
      label: 'PHASE', date: '', title: '', desc: '',
      spacing: sp(), labelSpacing: sp(), dateSpacing: sp(), titleSpacing: sp(), descSpacing: sp()
    };
  }
  function blankSkillGroup() {
    return { name: '', keywords: '', detail: '', items: [], spacing: sp(), nameSpacing: sp(), keywordsSpacing: sp(), detailSpacing: sp() };
  }
  /* N9 官网专属板块：大数字带的一项（数字 + 说明） */
  function blankKpiItem() {
    return { value: '', label: '', spacing: sp(), valueSpacing: sp(), labelSpacing: sp() };
  }
  /* N9 官网专属板块：项目卡片墙的一张卡。
     before / after / approach 是「优化前 → 优化后 → 手段」证据链，纯增量字段，
     A4 预览里折叠成一行小字，不干扰 PDF 版式。 */
  function blankProjectCard() {
    return {
      name: '', desc: '', cover: '', stack: '', metrics: [],
      before: '', after: '', approach: '',
      spacing: sp(), nameSpacing: sp(), descSpacing: sp(), coverSpacing: sp(),
      stackSpacing: sp(), evidenceSpacing: sp()
    };
  }

  /* ============================================================
   * 四、字段描述符 → 控件 HTML
   * ============================================================ */
  /* 间距微调行：data-spath 指「挂间距的对象」，data-sp 指该对象上的间距属性名。
     两者都在渲染期算好，写回时不需要任何字符串编码解析。 */
  function spacingRow(objPath, prop, obj) {
    const spc = (obj && typeof obj === 'object' && obj[prop] && typeof obj[prop] === 'object') ? obj[prop] : null;
    const mt = spc ? z(spc.mt) : 0, mb = spc ? z(spc.mb) : 0;
    const base = ' data-spath="' + esc(objPath) + '" data-sp="' + esc(prop) + '"';
    return '<span class="spacing-row">'
      + '<label>上间距 <input type="number" step="1"' + base + ' data-pos="mt" value="' + mt + '"></label>'
      + '<label>下间距 <input type="number" step="1"' + base + ' data-pos="mb" value="' + mb + '"></label>'
      + '</span>';
  }

  /* 一个字段 → 一段 HTML。
     objPath 是「该字段所属对象」的路径；leaf 列表里对象本身就是值（key 为空）。 */
  function fieldHtml(f, objPath, obj) {
    const val = f.key ? (obj ? obj[f.key] : undefined) : obj;
    const attrs = ' data-path="' + esc(objPath) + '" data-field="' + esc(f.key || '') + '"';
    if (f.kind === 'checkbox') {
      const on = (val === undefined || val === null) ? !!f.def : !!val;
      return '<div class="field field-inline"><label class="check">'
        + '<input type="checkbox"' + attrs + (on ? ' checked' : '') + '> ' + f.label + '</label></div>';
    }
    if (f.kind === 'color') {
      const c = (val === '' || val == null) ? (f.def || '#888888') : val;
      return '<div class="field field-inline"><label class="check">' + f.label
        + ' <input type="color"' + attrs + ' value="' + esc(c) + '"></label></div>';
    }
    let ctl;
    if (f.kind === 'number') {
      const shown = (val === '' || val == null) ? (f.def == null ? '' : f.def) : val;
      ctl = '<input type="number"' + attrs
        + (f.min != null ? ' min="' + f.min + '"' : '')
        + (f.max != null ? ' max="' + f.max + '"' : '')
        + ' step="' + (f.step || 1) + '" value="' + esc(shown) + '">';
    } else if (f.kind === 'textarea') {
      ctl = '<textarea' + attrs + ' rows="' + (f.rows || 2) + '"'
        + (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') + '>'
        + esc(T(val)) + '</textarea>';
    } else {
      ctl = '<input' + attrs + (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '')
        + ' value="' + esc(T(val)) + '">';
    }
    return '<div class="field">' + (f.label ? '<label>' + f.label + '</label>' : '') + ctl
      + (f.spacing ? spacingRow(objPath, f.spacing, obj) : '') + '</div>';
  }

  /* ============================================================
   * 五、列表描述符 → 行 + 增删移按钮（任意层嵌套递归）
   * ============================================================ */
  /* 上移 / 下移 / 删除：三个按钮共用同一套寻址（listid 决定用哪个描述符的规则） */
  function miniBtns(list, arrPath, idx) {
    const b = function (act, txt, title, extra) {
      return '<button class="mini-btn' + (extra ? ' ' + extra : '') + '"'
        + ' data-act="' + act + '" data-listid="' + esc(list.id) + '"'
        + ' data-list="' + esc(arrPath) + '" data-idx="' + idx + '"'
        + ' title="' + title + '">' + txt + '</button>';
    };
    return b('up', '↑', '上移') + b('down', '↓', '下移') + b('del', '×', '删除', 'del');
  }
  function rowHead(list, arrPath, idx, tagText) {
    return '<div class="item-head"><span class="tag">' + esc(tagText) + '</span>'
      + miniBtns(list, arrPath, idx) + '</div>';
  }
  function addBtn(list, arrPath, depth) {
    return '<button class="add-btn' + (depth ? ' sub' : '') + '"'
      + ' data-act="add" data-listid="' + esc(list.id) + '" data-list="' + esc(arrPath) + '">'
      + '＋ 添加' + esc(list.noun || '条目') + '</button>';
  }

  /* 渲染一个列表：basePath 是「持有该数组的对象」的路径 */
  function listHtml(list, basePath, arr, depth) {
    const arrPath = pathJoin(basePath, list.path);
    const items = Array.isArray(arr) ? arr : [];
    let h = '';
    if (!items.length && list.emptyHint) h += '<div class="list-empty">' + esc(list.emptyHint) + '</div>';
    items.forEach(function (it, i) {
      const itemPath = pathJoin(arrPath, i);
      const tag = list.tagOf ? list.tagOf(it, i) : ((list.tag || '条目') + ' ' + (i + 1));
      if (list.leaf) {
        /* leaf 行：整行就是一个值（标签芯片这类纯字符串数组） */
        h += '<div class="line-row">' + rowHead(list, arrPath, i, tag)
          + fieldHtml(list.fields[0], itemPath, it) + '</div>';
        return;
      }
      const rowCls = (depth === 0) ? 'item-row' : (depth === 1 ? 'sub-row' : 'line-row');
      h += '<div class="' + rowCls + '">' + rowHead(list, arrPath, i, tag);
      (list.fields || []).forEach(function (f) { h += fieldHtml(f, itemPath, it); });
      (list.lists || []).forEach(function (sub) { h += listHtml(sub, itemPath, it[sub.path], depth + 1); });
      h += '</div>';
    });
    if (list.create) h += addBtn(list, arrPath, depth);
    return h;
  }

  /* ============================================================
   * 六、板块类型注册表
   * ============================================================ */
  const TYPES = {};          // type → 描述符
  const TYPE_ORDER = [];     // 保持「添加板块」按钮顺序
  const LIST_INDEX = {};     // listId → 列表描述符（增删移的规则来源）

  function register(def) {
    TYPES[def.type] = def;
    TYPE_ORDER.push(def.type);
    (def.lists || []).forEach(indexList);
    return def;
  }
  function indexList(list) {
    if (list.id) LIST_INDEX[list.id] = list;
    (list.lists || []).forEach(indexList);
    return list;
  }
  function getType(type) { return TYPES[type] || null; }
  function allTypes() { return TYPE_ORDER.map(function (t) { return TYPES[t]; }); }
  function getList(id) { return LIST_INDEX[id] || null; }
  function createSection(type) {
    const def = TYPES[type] || TYPES.advantages;
    return def.create();
  }

  /* 板块级「伪列表」：让板块的上移 / 下移 / 删除 / 新增也能走同一套通用操作 */
  const SECTIONS_LIST = {
    id: 'sections', path: 'sections', tag: '板块', noun: '板块',
    min: 1, minMessage: '至少保留一个板块，无法删除。',
    confirm: '确定删除整个「{title}」板块吗？此操作可用「撤销」恢复。',
    titleOf: function (sec) { return sec.title; },
    create: null   /* 新增走「添加板块」按钮（带 type），不在这里造空板块 */
  };
  LIST_INDEX.sections = SECTIONS_LIST;

  /* ---- 列表描述符：可复用的积木 ---- */
  /* 量化成果 / 技能点这类「一行文本 + 该行间距」的叶子列表 */
  function lineList(id, path, tag, noun, hint) {
    return {
      id: id, path: path, tag: tag, noun: noun,
      create: function () { return line(''); },
      min: 0,
      emptyHint: hint || '',
      fields: [{ key: 'text', label: '内容', kind: 'textarea', rows: 2, spacing: 'spacing' }]
    };
  }
  /* 项目：项目名 / 技术栈 / 简介 + 引用样式 + 独立分页 + 嵌套的量化成果 */
  function projectList(id, path, tag, projectNoun, resultNoun) {
    return {
      id: id, path: path, tag: tag, noun: projectNoun,
      create: blankProject, min: 0,
      fields: [
        { key: 'name', label: '项目名', kind: 'text', spacing: 'nameSpacing' },
        { key: 'stack', label: '技术栈', kind: 'text', spacing: 'stackSpacing' },
        { key: 'desc', label: '简介', kind: 'textarea', rows: 2, spacing: 'descSpacing' },
        { key: 'descQuote', label: '项目描述引用样式', kind: 'checkbox' },
        { key: 'pageBreak', label: '强制该项目从新一页开始', kind: 'checkbox' },
        { key: 'descColor', label: '引用颜色', kind: 'color', def: '#888888' }
      ],
      lists: [lineList(id + '.results', 'results', '量化成果', resultNoun)]
    };
  }

  register({
    type: 'advantages', label: '个人优势',
    create: function () {
      return { id: newSectionId(), type: 'advantages', title: '个人优势', pageBreak: false, items: [blankItem('advantages')], spacing: sp() };
    },
    lists: [{
      id: 'advantages.items', path: 'items', tag: '优势', noun: '优势条目',
      create: function () { return blankItem('advantages'); }, min: 0,
      fields: [
        { key: 'label', label: '小标题', kind: 'text' },
        { key: 'labelBold', label: '小标题加粗', kind: 'checkbox', def: true },
        /* 行内间距挂在「内容」上（整行共用一份，避免同一行出现两组相同控件） */
        { key: 'text', label: '内容', kind: 'textarea', rows: 2, spacing: 'spacing' }
      ]
    }]
  });

  register({
    type: 'career', label: '职业履历',
    create: function () {
      return { id: newSectionId(), type: 'career', title: '职业履历', pageBreak: false, items: [blankItem('career')], spacing: sp() };
    },
    lists: [{
      id: 'career.items', path: 'items', tag: '公司', noun: '公司',
      create: function () { return blankItem('career'); }, min: 0,
      fields: [
        { key: 'company', label: '公司', kind: 'text', spacing: 'companySpacing' },
        { key: 'role', label: '岗位', kind: 'text', spacing: 'roleSpacing' },
        { key: 'date', label: '时间', kind: 'text', spacing: 'dateSpacing' },
        { key: 'logo', label: 'Logo（图片 URL / DataURI，可留空）', kind: 'textarea', rows: 2, spacing: 'logoSpacing' },
        { key: 'logoSize', label: 'Logo 高度（px，留空则默认 28）', kind: 'number', min: 8, max: 120, def: 28, spacing: 'logoSizeSpacing' },
        { key: 'logoWidth', label: 'Logo 宽度（px，留空则按原始比例）', kind: 'number', min: 8, max: 320, spacing: 'logoWidthSpacing' },
        { key: 'logoGap', label: 'Logo 与名称间距（px，留空则默认 9）', kind: 'number', min: 0, max: 60, spacing: 'logoGapSpacing' },
        { key: 'summary', label: '公司概述（纯文本段落）', kind: 'textarea', rows: 4, spacing: 'summarySpacing' },
        { key: 'summaryQuote', label: '公司概述引用样式', kind: 'checkbox', def: true },
        { key: 'pageBreak', label: '强制该公司从新一页开始', kind: 'checkbox' },
        { key: 'summaryColor', label: '引用颜色', kind: 'color', def: '#888888' }
      ],
      lists: [projectList('career.items.projects', 'projects', '项目', '项目', '量化成果条目')]
    }]
  });

  register({
    type: 'skills', label: '核心技能',
    create: function () {
      return { id: newSectionId(), type: 'skills', title: '核心技能', pageBreak: false, groups: [blankSkillGroup()], spacing: sp() };
    },
    lists: [{
      id: 'skills.groups', path: 'groups', tag: '技能分组', noun: '技能分组',
      create: blankSkillGroup, min: 0,
      fields: [
        { key: 'name', label: '分组名（左列）', kind: 'text', spacing: 'nameSpacing' },
        { key: 'keywords', label: '关键词行（· 分隔，**重点** 高亮）', kind: 'textarea', rows: 2,
          spacing: 'keywordsSpacing', placeholder: 'Multi-Agent 协作编排 · RAG 增强检索 · MCP 协议' },
        { key: 'detail', label: '补充说明行（掌握程度 / 成果，可留空）', kind: 'textarea', rows: 2,
          spacing: 'detailSpacing', placeholder: 'LangChain / LangGraph · 多 Agent 协作设计 · Few-Shot 自学习框架' }
      ],
      lists: [lineList('skills.groups.items', 'items', '逐条技能点（旧版样式，留空则用上面两行）', '技能点')]
    }]
  });

  register({
    type: 'projects', label: '项目经历',
    create: function () {
      return { id: newSectionId(), type: 'projects', title: '项目经历', pageBreak: false, items: [blankProject()], spacing: sp() };
    },
    lists: [projectList('projects.items', 'items', '项目', '项目', '量化成果条目')]
  });

  register({
    type: 'highlights', label: '关键印记',
    create: function () {
      return {
        id: newSectionId(), type: 'highlights', title: '关键印记', pageBreak: false,
        cards: [{ text: '', spacing: sp() }, { text: '', spacing: sp() }],
        tags: ['', '', ''], spacing: sp()
      };
    },
    lists: [{
      id: 'highlights.cards', path: 'cards', tag: '高亮卡', noun: '高亮卡',
      create: function () { return { text: '', spacing: sp() }; }, min: 0,
      emptyHint: '还没有高亮卡 —— 点下方「＋ 添加高亮卡」，一句话讲清最值得 HR 记住的成果。',
      fields: [{ key: 'text', label: '高亮卡正文（**xxx** 标记加粗）', kind: 'textarea', rows: 3, spacing: 'spacing' }]
    }, {
      /* 标签芯片是纯字符串数组（数据形态不动，保持与导入 / 飞书历史兼容）：
         leaf 行 + 单独一行文本输入；芯片在 flex 换行里布局，上下间距无意义，故不提供 */
      id: 'highlights.tags', path: 'tags', tag: '标签', noun: '标签',
      leaf: true, create: function () { return ''; }, min: 0,
      emptyHint: '还没有标签芯片 —— 点下方「＋ 添加标签」，用 2~6 个关键词覆盖技能面。',
      fields: [{ key: '', label: '', kind: 'text', placeholder: '关键词（如 RAG / Multi-Agent）' }]
    }]
  });

  register({
    type: 'growth', label: '技术成长路径',
    create: function () {
      return { id: newSectionId(), type: 'growth', title: '技术成长路径', pageBreak: false, phases: [blankPhase(), blankPhase(), blankPhase()], spacing: sp() };
    },
    lists: [{
      id: 'growth.phases', path: 'phases', tag: '阶段', noun: '阶段',
      create: blankPhase, min: 0,
      fields: [
        { key: 'label', label: '阶段标签（如 PHASE 1）', kind: 'text', spacing: 'labelSpacing' },
        { key: 'date', label: '时间段', kind: 'text', spacing: 'dateSpacing' },
        { key: 'title', label: '主题（如 Java 架构 · 工程基石）', kind: 'text', spacing: 'titleSpacing' },
        { key: 'desc', label: '描述', kind: 'textarea', rows: 3, spacing: 'descSpacing' }
      ]
    }]
  });

  /* ---- N9 个人求职官网专属板块（纯增量，向后兼容：老数据没有这两个 type 也不受影响）----
     为什么做成独立 type 而不是复用 highlights / projects：
       highlights 是长句高亮卡，官网首屏要的是「大数字 + 小标签」；
       projects 是时间线列表，官网要的是「封面 + 指标 + 技术栈」的卡片墙。
     强行复用会让 PDF 版式被官网需求带偏，所以宁可加两个新 type，
     并在 A4 预览里给出**降级渲染**（见 js/render/resume-render.js），保证 PDF 不被带跑。 */
  register({
    type: 'kpi-band', label: '关键数据带（官网首屏）',
    create: function () {
      return {
        id: newSectionId(), type: 'kpi-band', title: '关键数据', pageBreak: false,
        items: [blankKpiItem(), blankKpiItem(), blankKpiItem()], spacing: sp()
      };
    },
    lists: [{
      id: 'kpi-band.items', path: 'items', tag: '数据', noun: '数据项',
      create: blankKpiItem, min: 0,
      emptyHint: '还没有数据项 —— 点下方「＋ 添加数据项」，一行一个「数字 + 说明」，如「1200+ / GitHub Stars」。',
      tagOf: function (it, i) {
        const v = T(it && it.value).trim();
        return '数据 ' + (i + 1) + (v ? ' · ' + v : '');
      },
      fields: [
        { key: 'value', label: '数字（如 1200+ / 4 / 2 段）', kind: 'text', spacing: 'valueSpacing' },
        { key: 'label', label: '说明（如 GitHub Stars）', kind: 'text', spacing: 'labelSpacing' }
      ]
    }]
  });

  register({
    type: 'project-cards', label: '项目卡片墙（官网）',
    create: function () {
      return {
        id: newSectionId(), type: 'project-cards', title: '项目作品', pageBreak: false,
        cards: [blankProjectCard()], spacing: sp()
      };
    },
    lists: [{
      id: 'project-cards.cards', path: 'cards', tag: '项目卡', noun: '项目卡',
      create: blankProjectCard, min: 0,
      emptyHint: '还没有项目卡 —— 点下方「＋ 添加项目卡」，配上封面图、指标与技术栈，官网会排成卡片墙。',
      fields: [
        { key: 'name', label: '项目名', kind: 'text', spacing: 'nameSpacing' },
        { key: 'desc', label: '一句话简介', kind: 'textarea', rows: 2, spacing: 'descSpacing' },
        { key: 'cover', label: '封面图（图片 URL / DataURI，可留空）', kind: 'textarea', rows: 2, spacing: 'coverSpacing' },
        { key: 'stack', label: '技术栈（· 或 , 分隔，官网自动变芯片）', kind: 'text', spacing: 'stackSpacing' },
        { key: 'before', label: '优化前（选填，如 首屏加载 4.2s）', kind: 'text' },
        { key: 'after', label: '优化后（选填，如 首屏加载 1.1s）', kind: 'text' },
        { key: 'approach', label: '手段（选填，如 图片分片 + 接口预取）', kind: 'text', spacing: 'evidenceSpacing' }
      ],
      lists: [{
        id: 'project-cards.cards.metrics', path: 'metrics', tag: '指标', noun: '指标',
        create: function () { return line(''); }, min: 0,
        emptyHint: '（可留空）点下方「＋ 添加指标」，如「留存 +21%」。',
        fields: [{ key: 'text', label: '指标', kind: 'text', spacing: 'spacing' }]
      }]
    }]
  });

  register({
    type: 'custom', label: '自定义板块',
    /* F5：标题 + 自由内容（**加粗** / 换行）。不引入任意 CSS 注入，守住护城河。 */
    create: function () {
      return { id: newSectionId(), type: 'custom', title: '自定义', headingVisible: true, pageBreak: false, html: '', spacing: sp() };
    },
    sectionFields: [
      { key: 'html', label: '内容（支持 **加粗** 与换行，纯文本，不写代码）', kind: 'textarea', rows: 5, spacing: 'spacing' }
    ],
    lists: []
  });

  /* ============================================================
   * 七、基本信息卡片（根级字段 + 联系方式列表）
   * ============================================================ */
  /* 联系方式行类型识别：只用来给行标题加一个「手机号 / 邮箱」的提示，不改变数据 */
  function contactKind(text) {
    const s = String(text || '').trim();
    if (!s) return '';
    if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(s)) return '邮箱';
    if (/(?:^|\D)1[3-9]\d{9}(?:\D|$)/.test(s.replace(/[\s-]/g, ''))) return '手机号';
    if (/^https?:\/\//i.test(s) || /(?:github|gitee|zhihu|linkedin|juejin)\./i.test(s)) return '主页链接';
    if (/\d{4}/.test(s)) return '时间 / 学历';
    return '';
  }

  const BASIC = {
    fields: [
      { key: 'name', label: '姓名', kind: 'text', spacing: 'nameSpacing' },
      { key: 'subtitle', label: '核心头衔（用 “·” 分隔）', kind: 'text', spacing: 'subtitleSpacing' },
      { key: 'subtitleBold', label: '加粗显示核心头衔', kind: 'checkbox' },
      { key: 'meta', label: '顶部标签（年龄 / 年限 / 方向）', kind: 'text', spacing: 'metaSpacing' },
      { key: 'metaBold', label: '加粗显示顶部标签', kind: 'checkbox' }
    ],
    lists: [{
      id: 'contact', path: 'contact', tag: '联系方式', noun: '联系方式',
      create: function () { return line(''); }, min: 0,
      emptyHint: '还没有联系方式 —— 点下方「＋ 添加联系方式」：建议第一行手机号、第二行邮箱，再补学校 / 专业。',
      tagOf: function (it, i) {
        const k = contactKind(T(it));
        return '联系方式 ' + (i + 1) + (k ? ' · ' + k : '');
      },
      fields: [{
        key: 'text', label: '内容', kind: 'textarea', rows: 2, spacing: 'spacing',
        placeholder: '手机号 / 邮箱 / 学校 · 届别 / 专业 · 荣誉…'
      }]
    }]
  };
  /* BUG-01 修复：BASIC 是独立定义、只被 renderEditorHTML 直接渲染，
     从未走 register()，导致其 lists（contact）没进 LIST_INDEX，
     「＋ 添加联系方式」的 add 操作在 checkAction 里查不到规则而静默失败。
     这里在模块初始化时对 BASIC.lists 逐个 indexList，补齐注册。 */
  (BASIC.lists || []).forEach(indexList);

  /* ============================================================
   * 八、整块编辑区 HTML
   * ============================================================ */
  const SECTION_FIELDS = [
    { key: 'title', label: '板块标题', kind: 'text', spacing: 'spacing' },
    { key: 'headingVisible', label: '显示板块标题', kind: 'checkbox', def: true },
    { key: 'pageBreak', label: '强制本板块从新一页开始', kind: 'checkbox' }
  ];

  function sectionCardHtml(sec, idx) {
    const secPath = pathJoin('sections', idx);
    const def = getType(sec.type);
    let h = '<div class="card"><div class="card-head"><span class="grow">' + esc(sec.title) + '</span>'
      + miniBtns(SECTIONS_LIST, 'sections', idx) + '</div><div class="card-body">';
    SECTION_FIELDS.forEach(function (f) { h += fieldHtml(f, secPath, sec); });
    if (!def) {
      /* 未知类型不再静默空白：至少告诉用户发生了什么，且仍可改标题 / 位移 / 删除 */
      h += '<div class="list-empty">未知板块类型「' + esc(sec.type) + '」，当前只支持编辑标题、调整位置与删除。</div>';
    } else {
      /* 板块级专属字段（如 custom 的「内容」文本域），在通用字段之后、列表之前渲染 */
      (def.sectionFields || []).forEach(function (f) { h += fieldHtml(f, secPath, sec); });
      (def.lists || []).forEach(function (l) { h += listHtml(l, secPath, sec[l.path], 0); });
    }
    return h + '</div></div>';
  }

  function addSectionCardHtml() {
    let h = '<div class="card add-section-card"><div class="card-head">添加板块</div>'
      + '<div class="card-body add-section-body">';
    allTypes().forEach(function (def) {
      h += '<button class="add-btn" data-act="add" data-listid="sections" data-list="sections"'
        + ' data-type="' + esc(def.type) + '">＋ ' + esc(def.label) + '</button>';
    });
    return h + '</div></div>';
  }

  /* 整个编辑面板的 HTML（原 renderEditor 的全部职责） */
  function renderEditorHTML(root) {
    let h = '<div class="card"><div class="card-head">基本信息</div><div class="card-body">';
    BASIC.fields.forEach(function (f) { h += fieldHtml(f, '', root); });
    BASIC.lists.forEach(function (l) { h += listHtml(l, '', root[l.path], 0); });
    h += '</div></div>';
    const sections = Array.isArray(root.sections) ? root.sections : [];
    sections.forEach(function (sec, i) { h += sectionCardHtml(sec, i); });
    h += addSectionCardHtml();
    return h;
  }

  /* ============================================================
   * 九、写回（字段 / 间距 / 列表操作）
   * ============================================================ */
  /* 字段与间距：dataset 直接来自控件元素 */
  function writeInput(root, ds, value) {
    const field = ds.field || '';
    if (!field) return writeLeaf(root, ds.path, value);
    return writeField(root, ds.path, field, value);
  }
  function writeSpacingInput(root, ds, value) {
    return writeSpacing(root, ds.spath, ds.sp || 'spacing', ds.pos, value);
  }

  /* 列表操作：先定位，再校验（校验不改数据，便于调用方「先记历史再落库」） */
  function locate(root, ds) {
    const list = LIST_INDEX[ds.listid];
    if (!list) return null;
    const r = resolve(root, ds.list);
    const arr = r ? r.value : null;
    if (!Array.isArray(arr)) return null;
    const hasIdx = ds.idx !== undefined && ds.idx !== null && ds.idx !== '';
    const idx = hasIdx ? Number(ds.idx) : null;
    return { list: list, arr: arr, idx: idx, item: idx == null ? null : arr[idx] };
  }
  /* 返回 { ok, message?, confirm?, noop? }：ok=false 表示非法操作（不改数据） */
  function checkAction(root, ds) {
    const L = locate(root, ds);
    if (!L) return { ok: false };
    const list = L.list;
    if (ds.act === 'add') {
      if (ds.type) return getType(ds.type) ? { ok: true } : { ok: false };   /* 添加板块 */
      return list.create ? { ok: true } : { ok: false };                     /* 添加条目 */
    }
    if (L.idx == null || L.item == null || L.idx < 0 || L.idx >= L.arr.length) return { ok: false };
    if (ds.act === 'del') {
      if (typeof list.min === 'number' && L.arr.length <= list.min) {
        return { ok: false, message: list.minMessage || '至少保留一项，无法删除。' };
      }
      if (list.confirm) {
        const title = list.titleOf ? list.titleOf(L.item) : '';
        return { ok: true, confirm: String(list.confirm).replace('{title}', title) };
      }
      return { ok: true };
    }
    if (ds.act === 'up' && L.idx === 0) return { ok: true, noop: true };
    if (ds.act === 'down' && L.idx === L.arr.length - 1) return { ok: true, noop: true };
    if (ds.act === 'up' || ds.act === 'down') return { ok: true };
    return { ok: false };
  }
  /* 真正改数据（调用前应先 checkAction 校验 + 记撤销历史） */
  function applyAction(root, ds) {
    const L = locate(root, ds);
    if (!L) return false;
    const arr = L.arr;
    if (ds.act === 'add') {
      const item = ds.type ? createSection(ds.type) : L.list.create();
      if (item === null || item === undefined) return false;
      arr.push(item);
      return true;
    }
    const i = L.idx;
    if (i == null || i < 0 || i >= arr.length) return false;
    if (ds.act === 'del') { arr.splice(i, 1); return true; }
    const j = i + (ds.act === 'up' ? -1 : 1);
    if (j < 0 || j >= arr.length) return false;
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    return true;
  }

  global.ResumeEditorSchema = {
    /* 基础件（resume-render.js 从这里取，保持单一实现） */
    esc: esc, T: T, S: S, z: z, line: line, objify: objify,
    /* 模型工厂 */
    blankItem: blankItem, blankProject: blankProject, blankPhase: blankPhase,
    blankSkillGroup: blankSkillGroup, blankKpiItem: blankKpiItem, blankProjectCard: blankProjectCard,
    createSection: createSection, newSectionId: newSectionId,
    /* 注册表 */
    register: register, getType: getType, allTypes: allTypes, getList: getList,
    BASIC: BASIC, SECTIONS_LIST: SECTIONS_LIST,
    /* 路径寻址 */
    pathJoin: pathJoin, resolve: resolve, objAt: objAt,
    writeField: writeField, writeLeaf: writeLeaf, writeSpacing: writeSpacing, coerceInput: coerceInput,
    /* 渲染 */
    fieldHtml: fieldHtml, listHtml: listHtml, sectionCardHtml: sectionCardHtml,
    renderEditorHTML: renderEditorHTML,
    /* 写回 */
    writeInput: writeInput, writeSpacingInput: writeSpacingInput,
    checkAction: checkAction, applyAction: applyAction,
    /* 杂项 */
    contactKind: contactKind, sp: sp
  };
})(typeof window !== "undefined" ? window : globalThis);
