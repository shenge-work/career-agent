/* 公司调研数据层（js/store/company-store.js）纯函数用例。
   company-store.js 是 IIFE + CommonJS 双环境模块，Node 侧 require 安全、不触发 fetch / localStorage。 */
module.exports = [
  {
    name: 'PLATFORMS 含常用调研平台',
    fn: (c) => {
      const P = c.Store.PLATFORMS;
      c.assert(Array.isArray(P) && P.indexOf('BOSS直聘') >= 0 && P.indexOf('企查查') >= 0 && P.indexOf('官网') >= 0,
        'PLATFORMS 含 BOSS直聘 / 企查查 / 官网');
    }
  },
  {
    name: 'normalizeCompany 补全缺省字段',
    fn: (c) => {
      const n = c.Store.normalizeCompany({ name: ' 字节  ' });
      c.assert(n.name === '字节', 'name 去首尾空白');
      c.assert(n.applied === false, 'applied 默认 false');
      c.assert(!('inPool' in n) && !('locked' in n) && !('appliedAt' in n), '投递相关字段已剥离（纯档案）');
      c.assert(Array.isArray(n.research) && n.research.length === 0, 'research 默认空数组');
      c.assert(typeof n.id === 'string' && n.id.length > 0, '自动生成 id');
      c.assert(typeof n.createdAt === 'number' && typeof n.updatedAt === 'number', '时间戳补全');
    }
  },
  {
    name: 'normalizeCompany 规整 research 条目并去空白',
    fn: (c) => {
      const n = c.Store.normalizeCompany({ name: 'X', research: [{ platform: 'BOSS直聘', content: ' 不错 ' }] });
      c.assert(n.research.length === 1, 'research 条目保留');
      c.assert(n.research[0].platform === 'BOSS直聘' && n.research[0].content === '不错', 'research 内容去空白、字段补全');
      c.assert(typeof n.research[0].id === 'string' && n.research[0].id.length > 0, 'research 条目 id 补全');
    }
  },
  {
    name: 'DIMS / DIM_ORDER 维度定义存在且顺序固定',
    fn: (c) => {
      const D = c.Store.DIMS, O = c.Store.DIM_ORDER;
      c.assert(Array.isArray(D) && D.indexOf('公司简介') >= 0 && D.indexOf('风险与挑战') >= 0 && D.indexOf('其他') >= 0,
        'DIMS 含 6 业务维度 + 其他');
      c.assert(O[0] === '公司简介' && O[O.length - 1] === '其他', 'DIM_ORDER 以 公司简介 开头、其他 结尾');
    }
  },
  {
    name: 'normalizeCompany 给 research 补 dim 并校验取值',
    fn: (c) => {
      const n = c.Store.normalizeCompany({
        name: 'X',
        research: [
          { platform: '官网', dim: '融资情况', content: 'C' },
          { platform: '其他', dim: '乱写的维度', content: 'D' },
          { platform: '脉脉', content: 'E' }
        ]
      });
      c.assert(n.research[0].dim === '融资情况', '合法 dim 原样保留');
      c.assert(n.research[1].dim === '其他', '非法 dim 归 其他');
      c.assert(n.research[2].dim === '其他', '缺省 dim 归 其他');
    }
  },
  {
    name: 'normalizeCompany 剥离旧版投递字段、保留 applied',
    fn: (c) => {
      const n = c.Store.normalizeCompany({ name: 'Y', applied: true, appliedAt: 1700000000000, inPool: true, locked: true });
      c.assert(n.applied === true, 'applied 透传');
      c.assert(!('appliedAt' in n) && !('inPool' in n) && !('locked' in n), 'appliedAt/inPool/locked 被剥离');
    }
  },
  {
    name: 'computeStats 只统计总数与曾投递数',
    fn: (c) => {
      const list = [
        c.Store.normalizeCompany({ name: 'A', applied: true }),
        c.Store.normalizeCompany({ name: 'B', applied: false }),
        c.Store.normalizeCompany({ name: 'C' })
      ];
      const s = c.Store.computeStats(list);
      c.assert(s.total === 3 && s.applied === 1, '总数 3 / 曾投递 1');
      c.assert(s.inPool === undefined && s.locked === undefined, '不再返回 inPool/locked');
    }
  },
  {
    name: 'computeStats 空 / 非数组安全返回全 0',
    fn: (c) => {
      const s = c.Store.computeStats(null);
      c.assert(s.total === 0 && s.applied === 0, 'null 安全返回 0/0');
    }
  },
  {
    name: '日期函数 toDateInput / fmtDate / fromDateInput 往返',
    fn: (c) => {
      const ts = c.Store.fromDateInput('2026-03-15');
      c.assert(c.Store.toDateInput(ts) === '2026-03-15', 'toDateInput 还原 YYYY-MM-DD');
      c.assert(c.Store.fmtDate(ts) === '03-15', 'fmtDate 输出 MM-DD');
      c.assert(c.Store.fmtDate(null) === '' && c.Store.toDateInput(null) === '' && c.Store.fromDateInput('') === null,
        '空值一律返回空串 / null');
    }
  },
  {
    name: 'toDateTimeLocal / fromDateTimeLocal 保留投递时刻',
    fn: (c) => {
      const v = '2026-11-03T16:11';
      const ts = c.Store.fromDateTimeLocal(v);
      c.assert(c.Store.toDateTimeLocal(ts) === v, 'toDateTimeLocal 还原 含时刻 的串');
      c.assert(c.Store.fromDateTimeLocal('') === null && c.Store.toDateTimeLocal(null) === '', '空值返回 null / 空串');
    }
  },
  {
    name: 'normalizeJd 规整 JD 字段：数组拆分 + 补全 id + 时间戳',
    fn: (c) => {
      const j = c.Store.normalizeJd({
        title: '  Agent研发  ', salary: '30-60K',
        skills: 'Java, Python, MySQL', benefits: '节日福利，餐补',
        duties: 'a\nb\n', requirements: 'x、y',
        appliedAt: 1700000000000
      });
      c.assert(j.title === 'Agent研发', 'title 去首尾空白');
      c.assert(j.salary === '30-60K', 'salary 保留');
      c.assert(Array.isArray(j.skills) && j.skills.length === 3 && j.skills[0] === 'Java', '逗号分隔 skills → 数组');
      c.assert(Array.isArray(j.benefits) && j.benefits.length === 2, '中文逗号 benefits → 数组');
      c.assert(Array.isArray(j.duties) && j.duties.length === 2, '换行 duties → 数组');
      c.assert(Array.isArray(j.requirements) && j.requirements.length === 2, '顿号 requirements → 数组');
      c.assert(j.appliedAt === 1700000000000, '数字时间戳保留');
      c.assert(typeof j.id === 'string' && j.id.length > 0, '自动生成 jd id');
    }
  },
  {
    name: 'normalizeCompany 透传 jds 并逐条规整',
    fn: (c) => {
      const n = c.Store.normalizeCompany({
        name: 'X',
        jds: [{ title: 'P', skills: 'Go, Java' }, { title: 'Q' }]
      });
      c.assert(Array.isArray(n.jds) && n.jds.length === 2, 'jds 数组保留');
      c.assert(n.jds[0].title === 'P' && n.jds[0].skills.length === 2, 'jd[0] skills 拆为 2');
      c.assert(typeof n.jds[1].id === 'string', 'jd[1] 自动补 id');
    }
  }
];
