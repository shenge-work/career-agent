/* JD 匹配分析（js/jd-match.js）测试。
   与其它 cases-*.js 同构（CommonJS + ctx.assert + 可返回 Promise）。

   这一组要防的是「看起来在工作、实际给错答案」：
     · 英文短语被拆词 —— "Spring Boot" 拆成 Spring / Boot 会让只写了 Spring 的简历
       白拿两个「已覆盖」，把匹配度刷高（本次实现前实测就有这个问题）；
     · 词边界 —— Java 不能命中 JavaScript，否则写 JS 的人看起来懂 Java；
     · JD 里的结构性词（任职要求 / 岗位职责）与硬性门槛（本科 / 3 年）不能算技能；
     · 只读性 —— 分析绝不改动简历数据（它和体检一样挂在同一份 payload 上，写脏就是静默改稿）；
     · JD 原文只进 localStorage，绝不混进简历数据（否则会随飞书同步上传出去）；
     · 五个接线点齐全（index.html 面板 / script 顺序 / CSS / 构建白名单 / 模块 API），
       漏任何一处都是「静默缺功能」—— 与 verify:assets 防的是同一类失效。 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* 覆盖各种坑的样张 JD：门槛词（本科 / 3 年）、英文短语（Spring Boot）、
   加分小句（者优先 / 加分）、中文技能词（并发编程）。 */
const JD = [
  '任职要求：',
  '1. 本科及以上学历，3 年以上 Java 开发经验；',
  '2. 熟悉 Spring Boot、MySQL、Redis，精通并发编程；',
  '3. 了解 Kubernetes、Docker 者优先；',
  '4. 有 LLM 评测体系搭建经验加分。'
].join('\n');

const PAYLOAD = {
  data: {
    name: '测试者',
    contact: [{ label: '电话', value: '13800000000' }],
    sections: [
      {
        id: 's1', type: 'skills', title: '专业技能',
        items: [{ label: '后端', text: 'Java · Spring Boot · MySQL' }]
      },
      {
        id: 's2', type: 'career', title: '工作经历',
        items: [{
          company: '某公司', role: '工程师', summary: 'Java 后端',
          projects: [{ name: 'X', stack: 'Redis', desc: '并发编程', results: ['提升 30%'] }]
        }]
      }
    ]
  }
};

const keysOf = (list) => list.map((t) => String(t.term).toLowerCase());
const has = (list, term) => keysOf(list).indexOf(term) !== -1;

/* analyzeNow() 走的是 ResumeEditor.getData()（真实当前简历）。沙箱里的真实数据是
   template / data.js，与用例样张无关 —— 直接用它会让渲染用例的结果随仓库数据漂移。
   这里临时把「当前简历」换成样张，跑完还原。 */
function withPayload(ctx, fn) {
  const g = ctx.vmGlobal;
  const ed = g.ResumeEditor;
  const origData = ed.getData;
  const origGet = g.document.getElementById;
  ed.getData = () => PAYLOAD;
  g.document.getElementById = (id) => (id === 'jdInput' ? { value: JD } : origGet(id));
  try { return fn(); } finally { ed.getData = origData; g.document.getElementById = origGet; }
}

module.exports = [
  /* ---------- 一、术语抽取 ---------- */
  {
    name: '英文短语合并为整体，不再拆成单词',
    fn: (ctx) => {
      const J = ctx.ResumeJd;
      const keys = keysOf(J.extractTerms(JD));
      ctx.assert(keys.indexOf('spring boot') !== -1, '"Spring Boot" 作为一个整体术语');
      ctx.assert(keys.indexOf('spring') === -1, '不再单独产出 "Spring"');
      ctx.assert(keys.indexOf('boot') === -1, '不再单独产出 "Boot"（否则只写 Spring 也算覆盖）');
      ctx.assert(keys.indexOf('mysql') !== -1 && keys.indexOf('redis') !== -1, '单词型技术词照常抽出');
    }
  },
  {
    name: 'JD 结构性词与硬性门槛不算技能关键词',
    fn: (ctx) => {
      const J = ctx.ResumeJd;
      const keys = keysOf(J.extractTerms(JD));
      ['任职', '岗位', '职责', '学历', '本科', '要求', '经验', '开发'].forEach((w) => {
        ctx.assert(keys.indexOf(w) === -1, '「' + w + '」未被当成技能关键词');
      });
      ctx.assert(keys.indexOf('java') !== -1, '同句中的真实技能词 Java 仍被抽出');
    }
  },
  {
    name: '编号列表与「中英混血」词不污染关键词',
    fn: (ctx) => {
      const J = ctx.ResumeJd;
      const keys = keysOf(J.extractTerms(
        '3. 与产品、算法协作\n4. 熟悉 Docker 者优先\n5. 有 Prompt 工程实践经验加分'));
      ctx.assert(keys.every((k) => !/^\d/.test(k)), '没有数字开头的术语（编号「3.」不会粘进关键词）');
      ctx.assert(keys.every((k) => !(/[\u4e00-\u9fa5]/.test(k) && /[a-z]/i.test(k))),
        '没有中英混血术语（「Prompt 工程实践」这类交给英文侧，不重复计数）');
      ctx.assert(keys.indexOf('与产品') === -1, '连词前缀被剥掉（不是「与产品」）');
      ctx.assert(keys.indexOf('产品') !== -1, '剥掉连词后留下「产品」');
      ctx.assert(keys.indexOf('算法') !== -1, '「算法协作」剥掉动词尾巴后留下「算法」');
      ctx.assert(keys.indexOf('docker') !== -1 && keys.indexOf('prompt') !== -1,
        '英文侧照常抽出 Docker / Prompt');
    }
  },
  {
    name: '「者优先 / 加分」小句标记为加分项（沉到清单末尾）',
    fn: (ctx) => {
      const J = ctx.ResumeJd;
      const map = {};
      J.extractTerms(JD).forEach((t) => { map[t.term.toLowerCase()] = t; });
      ctx.assert(map['kubernetes'] && map['kubernetes'].bonus === true, 'Kubernetes 是加分项');
      ctx.assert(map['docker'] && map['docker'].bonus === true, 'Docker 是加分项');
      ctx.assert(map['llm'] && map['llm'].bonus === true, 'LLM 是加分项');
      ctx.assert(map['java'] && map['java'].bonus === false, 'Java 不是加分项（是硬性要求）');
    }
  },
  {
    name: '空 JD / 纯噪音 JD 不产出术语',
    fn: (ctx) => {
      const J = ctx.ResumeJd;
      ctx.assert(J.extractTerms('').length === 0, '空串无术语');
      ctx.assert(J.extractTerms('   \n  ').length === 0, '纯空白无术语');
      ctx.assert(J.extractTerms(null).length === 0, 'null 不抛错、无术语');
      const noise = J.extractTerms('本科及以上学历，3 年以上工作经验，沟通能力强');
      ctx.assert(noise.length === 0, '纯门槛 / 软素质 JD 不产出术语（实测 ' + noise.length + '）');
    }
  },

  /* ---------- 二、匹配计数（这是最容易给错答案的地方） ---------- */
  {
    name: '英文按词边界匹配：Java 不命中 JavaScript',
    fn: (ctx) => {
      const J = ctx.ResumeJd;
      ctx.assert(J.countHits('Java', '熟悉 JavaScript 与 Java') === 1, 'Java 只命中外层那一次');
      ctx.assert(J.countHits('JavaScript', '熟悉 JavaScript 与 Java') === 1, 'JavaScript 正常命中');
      ctx.assert(J.countHits('Java', 'JavaScript JavaScript') === 0, '只有 JavaScript 时 Java 命中 0');
      ctx.assert(J.countHits('C', 'C/C++ 与 C#') === 1, 'C 不被 C++ / C# 吞掉（+# 属于词内字符）');
    }
  },
  {
    name: '相邻重复各计一次（前瞻而非消费字符）',
    fn: (ctx) => {
      const J = ctx.ResumeJd;
      ctx.assert(J.countHits('Java', 'Java,Java') === 2, '逗号分隔的两次都计入');
      ctx.assert(J.countHits('Java', 'Java Java') === 2, '空格分隔的两次都计入');
      ctx.assert(J.countHits('Java', 'Java') === 1, '句首单次命中为 1');
    }
  },
  {
    name: '中文按子串计次，不要求整词',
    fn: (ctx) => {
      const J = ctx.ResumeJd;
      ctx.assert(J.countHits('并发', '并发编程，并发控制') === 2, '两处各计一次');
      ctx.assert(J.countHits('并发', '高并发场景') === 1, '"高并发" 中的并发命中');
      ctx.assert(J.countHits('并发', '') === 0, '空文本命中 0');
      ctx.assert(J.countHits('', '任意文本') === 0, '空术语命中 0');
    }
  },
  {
    name: '短语术语按原文整体匹配',
    fn: (ctx) => {
      const J = ctx.ResumeJd;
      ctx.assert(J.countHits('Spring Boot', '熟悉 Spring Boot') === 1, '短语整体命中');
      ctx.assert(J.countHits('Spring Boot', '只用 Spring') === 0, '只写 Spring 不算覆盖 Spring Boot');
    }
  },

  /* ---------- 三、分析（纯函数） ---------- */
  {
    name: '三档分桶 + 覆盖分自洽',
    fn: (ctx) => {
      const J = ctx.ResumeJd;
      const r = J.analyze(PAYLOAD, JD);
      ctx.assert(r.stats.total > 0, '抽出到关键词（' + r.stats.total + '）');
      ctx.assert(r.stats.covered + r.stats.weak + r.stats.missing === r.stats.total,
        '已覆盖 + 弱覆盖 + 缺失 === 总数（不重不漏）');
      ctx.assert(r.stats.score === Math.round(100 * (r.stats.covered + 0.5 * r.stats.weak) / r.stats.total),
        '覆盖分 = (已覆盖 + 0.5×弱覆盖) / 总数');
      ctx.assert(has(r.groups.covered, 'java'), 'Java 出现多处 → 已覆盖');
      ctx.assert(has(r.groups.weak, 'spring boot'), 'Spring Boot 只出现 1 次 → 弱覆盖');
      ctx.assert(has(r.groups.missing, 'kubernetes') && has(r.groups.missing, 'docker'),
        'Kubernetes / Docker 简历里没有 → 缺失');
    }
  },
  {
    name: '弱覆盖项带命中板块，可定位去补',
    fn: (ctx) => {
      const J = ctx.ResumeJd;
      const r = J.analyze(PAYLOAD, JD);
      const sb = r.groups.weak.filter((x) => String(x.term).toLowerCase() === 'spring boot')[0];
      ctx.assert(sb && sb.inSections.indexOf('专业技能') !== -1, 'Spring Boot 定位到「专业技能」');
      const rd = r.groups.weak.filter((x) => String(x.term).toLowerCase() === 'redis')[0];
      ctx.assert(rd && rd.inSections.indexOf('工作经历') !== -1, 'Redis 定位到「工作经历」');
      ctx.assert(r.groups.missing.every((x) => x.inSections.length === 0), '缺失项没有命中板块');
    }
  },
  {
    name: '加分项沉到各档末尾（不是必须项）',
    fn: (ctx) => {
      const J = ctx.ResumeJd;
      const r = J.analyze(PAYLOAD, JD);
      const m = r.groups.missing;
      const idx = (t) => keysOf(m).indexOf(t);
      const firstBonus = m.findIndex((x) => x.bonus);
      ctx.assert(firstBonus !== -1, '缺失档里存在加分项');
      ctx.assert(m.slice(firstBonus).every((x) => x.bonus), '加分项全部排在末尾');
      ctx.assert(idx('kubernetes') !== -1, 'Kubernetes 在缺失档内');
    }
  },
  {
    name: '空 JD 分析结果为空且不抛错',
    fn: (ctx) => {
      const J = ctx.ResumeJd;
      const r = J.analyze(PAYLOAD, '');
      ctx.assert(r.stats.total === 0 && r.stats.score === 0, '空 JD：总数与分为 0（不是 NaN）');
      ctx.assert(r.groups.covered.length === 0 && r.groups.missing.length === 0, '空 JD：三档皆空');
    }
  },
  {
    name: '板块文本收集排除 id / type / logo 等非内容字段',
    fn: (ctx) => {
      const J = ctx.ResumeJd;
      const payload = {
        data: {
          name: '测试者', logo: 'data:image/png;base64,SECRET',
          contact: [{ label: '电话', value: '13800000000' }],
          sections: [{
            id: 'sec-1', type: 'career', title: '工作经历',
            items: [{ company: '某公司', logo: 'data:image/png;base64,SECRET2' }]
          }]
        }
      };
      const secs = J.sectionsOf(payload);
      const all = secs.map((s) => s.text).join('\n');
      ctx.assert(secs.length >= 2, '至少收集到「基本信息 + 工作经历」（' + secs.length + '）');
      ctx.assert(all.indexOf('SECRET') === -1, '不把 logo 的 base64 当正文（否则图片数据会污染匹配）');
      ctx.assert(all.indexOf('sec-1') === -1, '不把 id 当正文');
      ctx.assert(all.indexOf('career') === -1, '不把板块 type 当正文');
      ctx.assert(all.indexOf('某公司') !== -1, '真实正文被收集');
    }
  },

  /* ---------- 四、只读性与隐私 ---------- */
  {
    name: 'analyze 不改动简历数据（与体检共用 payload，写脏就是静默改稿）',
    fn: (ctx) => {
      const J = ctx.ResumeJd;
      const before = JSON.stringify(PAYLOAD);
      J.analyze(PAYLOAD, JD);
      ctx.assert(JSON.stringify(PAYLOAD) === before, '分析前后 payload 完全一致');
    }
  },
  {
    name: 'JD 原文只进 localStorage，绝不混入简历数据',
    fn: (ctx) => {
      const J = ctx.ResumeJd;
      J.setJd(JD);
      ctx.assert(J.getJd() === JD, 'JD 写入后可读回');
      ctx.assert(JSON.stringify(PAYLOAD).indexOf('Kubernetes') === -1, 'JD 内容没有进入简历数据');
      ctx.assert(JSON.stringify(PAYLOAD).indexOf('resume_jd_text_v1') === -1, 'JD 存储键没有进入简历数据');
      J.setJd('');
      ctx.assert(J.getJd() === '', '清空后读回空串');
    }
  },
  {
    name: 'copyMissing 产出可直接带走的缺失清单',
    fn: (ctx) => {
      const J = ctx.ResumeJd;
      withPayload(ctx, () => {
        J.analyzeNow();
        const text = J.copyMissing();
        ctx.assert(/Kubernetes/.test(text), '清单含缺失项 Kubernetes');
        ctx.assert(/目标岗位 JD/.test(text), '清单带说明抬头（复制出去仍知道这是什么）');
        const r = J.last();
        ctx.assert(r && r.groups.missing.length > 0, 'last() 拿到最近一次结果');
      });
    }
  },

  /* ---------- 五、渲染 ---------- */
  {
    name: '渲染三档 chips 与统计条',
    fn: (ctx) => {
      const J = ctx.ResumeJd;
      const box = { innerHTML: '' };
      withPayload(ctx, () => {
        J.analyzeNow();
        J.render(box);
      });
      {
        const h = box.innerHTML;
        ctx.assert(/jd-chip missing/.test(h), '缺失项渲染为 .jd-chip.missing');
        ctx.assert(/jd-chip weak/.test(h), '弱覆盖项渲染为 .jd-chip.weak');
        ctx.assert(/jd-chip covered/.test(h), '已覆盖项渲染为 .jd-chip.covered');
        ctx.assert(/audit-stats/.test(h), '复用体检的统计条样式');
        ctx.assert(/复制缺失清单/.test(h), '底部含「复制缺失清单」');
      }
    }
  },
  {
    name: '无结果时给出引导文案而不是空白',
    fn: (ctx) => {
      const J = ctx.ResumeJd;
      J.clearJd();
      const box = { innerHTML: '' };
      J.render(box);
      ctx.assert(/粘贴目标岗位的 JD/.test(box.innerHTML), '空态提示「粘贴 JD」');
      ctx.assert(box.innerHTML.indexOf('jd-chip') === -1, '空态不渲染任何 chip');
    }
  },

  /* ---------- 六、接线断言（漏一处即静默缺功能） ---------- */
  {
    name: 'index.html 面板与脚本齐全，且脚本在 app.js / audit.js 之后',
    fn: (ctx) => {
      const html = read('index.html');
      ctx.assert(/id="panel-jd"/.test(html), '含 JD 面板 #panel-jd');
      ctx.assert(/id="jdInput"/.test(html), '含 JD 输入框 #jdInput');
      ctx.assert(/id="jdBody"/.test(html), '含结果容器 #jdBody');
      ctx.assert(/<textarea id="jdInput"/.test(html), '输入框是 textarea（JD 是多行文本）');
      ctx.assert(/ResumeJd\.analyzeNow\(\)/.test(html), '含「分析匹配度」按钮');
      ctx.assert(/ResumeJd\.clearJd\(\)/.test(html), '含「清空」按钮');
      ctx.assert(/ResumeJd\.toggle\(\)/.test(html), '面板标题可点开收起');
      ctx.assert(/<script src="js\/jd-match\.js"><\/script>/.test(html), '引入 js/jd-match.js');
      // 用完整 script 标签定位：注释里也会出现同名字符串，裸 indexOf 会命中注释而误判
      const tag = (f) => html.indexOf('<script src="' + f + '"></script>');
      ctx.assert(tag('js/jd-match.js') !== -1, 'jd-match.js 以 script 标签引入');
      ctx.assert(tag('js/app.js') < tag('js/jd-match.js'),
        'jd-match.js 在 app.js 之后加载（它要读 ResumeEditor.getData()）');
      ctx.assert(tag('js/audit.js') < tag('js/jd-match.js'),
        'jd-match.js 在 audit.js 之后加载（同属只读消费层，顺序固定便于共用视觉词汇）');
    }
  },
  {
    name: '入口在工具菜单与手机聚合页都可见',
    fn: (ctx) => {
      const html = read('index.html');
      /* 入口清单由 js/ui/menu-actions.js 渲染，index.html 里已无静态按钮 —— 问渲染结果 */
      ctx.assert(/id="jdBtn"/.test(ctx.ResumeMenu.htmlFor('desktop')), '桌面入口清单渲染出 #jdBtn');
      // 两端菜单都由 js/ui/menu-actions.js 的 ACTIONS 渲染 —— JD 入口必须两端都在，
      // 这正是「入口收敛」要消除的「一边有、一边没有」。
      const M = ctx.ResumeMenu;
      const jd = M.ACTIONS.filter((a) => a.run === 'ResumeJd.toggle()');
      ctx.assert(jd.length === 1, 'JD 入口在清单里只定义一次（实际 ' + jd.length + '）');
      ctx.assert(jd[0] && jd[0].d === '投递准备' && jd[0].m === '投递准备', 'JD 入口在桌面与手机都归到「投递准备」组');
    }
  },
  {
    name: 'CSS 含三档 chip 样式且走 --ui-* 灰阶变量',
    fn: (ctx) => {
      const css = read('css/style.css');
      ctx.assert(/\.jd-chip\.missing/.test(css), '含 .jd-chip.missing');
      ctx.assert(/\.jd-chip\.weak/.test(css), '含 .jd-chip.weak');
      ctx.assert(/\.jd-chip\.covered/.test(css), '含 .jd-chip.covered');
      ctx.assert(/\.jd-input/.test(css), '含 JD 输入框样式');
      const start = css.indexOf('.jd-input-wrap');
      const end = css.indexOf('N3 分享与权限控制', start);
      const block = css.slice(start, end === -1 ? undefined : end);
      ctx.assert(block.indexOf('#fff') === -1 && block.indexOf('rgb(') === -1,
        'JD 样式不写死颜色（随主题适配，与体检面板同一套灰阶约束）');
      ctx.assert(/var\(--ui-/.test(block), 'JD 样式走 --ui-* 变量');
    }
  },
  {
    name: 'build-single.js 白名单已登记（否则单文件版静默缺功能）',
    fn: (ctx) => {
      const build = read('tools/build-single.js');
      ctx.assert(/js\/jd-match\.js/.test(build), '白名单含 js/jd-match.js');
    }
  },
  {
    name: '模块暴露的 API 完整',
    fn: (ctx) => {
      const J = ctx.ResumeJd;
      ['extractTerms', 'countHits', 'analyze', 'sectionsOf', 'getJd', 'setJd',
        'render', 'analyzeNow', 'toggle', 'clearJd', 'copyMissing', 'last']
        .forEach((k) => ctx.assert(typeof J[k] === 'function', '暴露 ' + k + '()'));
    }
  }
];
