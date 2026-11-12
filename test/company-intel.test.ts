import { describe, expect, it } from 'vitest';
import {
  buildBrief,
  briefFilter,
  buildBriefHtml,
  buildCompareTable,
  companyCompareRow,
  COMPARE_DIMS,
  dimensionCoverage,
  expandIndustryQuery,
  inferIndustryCategory,
  matchCompany,
  normalizeCompany,
  normalizeFundingRounds,
  normalizeSalaries,
  RESEARCH_DIMS,
} from '../src/web/company-intel';

const FIXTURE = {
  name: 'Flowtica',
  industry: 'AI 应用',
  scale: '50-150人',
  location: '新加坡',
  website: 'https://flowtica.example.com',
  research: [
    { id: 'r1', platform: '官网', dim: '公司简介', content: 'AI Agent 硬件与软件生态，首款产品 Scribe 为 AI 录音笔。', date: '2026-11-01' },
    { id: 'r2', platform: '脉脉', dim: '团队情况', content: '创始人港科大背景。' },
  ],
  jds: [{ title: 'Agent 工程师', salary: '30-50K', city: '深圳', skills: 'LLM, Agent' }],
};

describe('D7 第一批 · 行业分类与检索（company-intel）', () => {
  it('inferIndustryCategory：自由文本推断标准类目，空/未知落未分类', () => {
    expect(inferIndustryCategory('AI 应用')).toBe('ai-app');
    expect(inferIndustryCategory('大模型')).toBe('ai-llm');
    expect(inferIndustryCategory('芯片设计')).toBe('semi-chip');
    expect(inferIndustryCategory('银行')).toBe('fin-bank');
    expect(inferIndustryCategory('AR 眼镜')).toBe('hw-xr');
    expect(inferIndustryCategory('金融科技')).toBe('fin-credit');
    expect(inferIndustryCategory('')).toBe('other-none');
    expect(inferIndustryCategory('完全没听过的赛道')).toBe('other-none');
  });

  it('expandIndustryQuery：查询词扩展出别名与类目', () => {
    const e = expandIndustryQuery('大模型');
    expect(e.terms[0]).toBe('大模型');
    expect(e.categories).toContain('ai-llm');
    expect(expandIndustryQuery('')).toEqual({ terms: [], categories: [] });
    const bank = expandIndustryQuery('银行');
    expect(bank.categories).toContain('fin-bank');
  });

  it('matchCompany：字面命中优先；行业词命中并标注 viaIndustry', () => {
    const c = { name: '某半导体制程公司', industry: '半导体' };
    expect(matchCompany(c, '某半导体').hit).toBe(true); // 字面
    const ai = { name: '未来智能', industry: 'AI 应用', research: [] };
    const m = matchCompany(ai, '大模型'); // 正文没有「大模型」，但类目命中 ai-app? 不——大模型是 ai-llm
    expect(m.hit).toBe(false); // AI 应用类目(ai-app) 与 大模型(ai-llm) 不同类，不误命中
    const llm = { name: '通用智能', industry: '', industryCategory: 'ai-llm', research: [] };
    const m2 = matchCompany(llm, '大模型');
    expect(m2.hit).toBe(true);
    expect(m2.viaIndustry).toBe('大模型');
  });

  it('matchCompany：正文含赛道词也算命中（即使类目未设）', () => {
    const c = { name: 'X 实验室', research: [{ dim: '公司简介', content: '我们做大模型训练平台' }] };
    const m = matchCompany(c, 'llm');
    expect(m.hit).toBe(true); // 类目 other-none，但正文「大模型」命中别名
  });

  it('normalizeCompany：新字段缺省补全，旧数据零迁移', () => {
    const n = normalizeCompany(FIXTURE);
    expect(n.summary).toBe('');
    expect(n.tags).toEqual([]);
    expect(n.industryCategory).toBe('ai-app'); // 由 industry 推断
    expect(n.industryAliases).toEqual([]);
    expect(n.rumors).toEqual([]);
    expect(normalizeCompany(null).name).toBe('未命名公司');
    // 已有类目不覆盖
    expect(normalizeCompany({ industry: '银行', industryCategory: 'fin-pay' }).industryCategory).toBe('fin-pay');
  });

  it('dimensionCoverage：六维按有正文的调研计数', () => {
    const cov = dimensionCoverage(FIXTURE);
    expect(cov.covered).toEqual(['公司简介', '团队情况']);
    expect(cov.missing).toEqual(['盈利情况', '融资情况', '竞品分析', '风险与挑战']);
    expect(cov.ratio).toBeCloseTo(2 / 6);
  });
});

describe('D7 第一批 · Markdown 简报与脱敏', () => {
  it('briefFilter：风闻与私人判断默认排除（脱敏白名单）', () => {
    expect(briefFilter({}).includeRumors).toBe(false);
    expect(briefFilter({}).includeVerdict).toBe(false);
    expect(briefFilter({ includeRumors: true, includeVerdict: true }).includeRumors).toBe(true);
    expect(briefFilter({ includeJds: false }).includeJds).toBe(false);
  });

  it('buildBrief：按维度生成 Markdown，含来源与引用计数', () => {
    const md = buildBrief(FIXTURE, FIXTURE.jds, {});
    expect(md).toContain('# Flowtica · 公司简报');
    expect(md).toContain('## 公司简介');
    expect(md).toContain('AI 录音笔');
    expect(md).toContain('岗位 / JD');
    expect(md).toContain('Agent 工程师');
    expect(md).toContain('本简报引用 2 条调研');
  });

  it('buildBrief：风闻 / 判断默认不进简报，勾选后进入且带内部标注', () => {
    const c = {
      ...FIXTURE,
      rumors: [{ id: 'x', content: '据说要裁员', credibility: '未证实' }],
      verdict: { recommendation: '观望', concerns: '现金流存疑' },
    };
    const md = buildBrief(c, [], {});
    expect(md).not.toContain('裁员');
    expect(md).not.toContain('观望');
    const md2 = buildBrief(c, [], { includeRumors: true, includeVerdict: true });
    expect(md2).toContain('裁员');
    expect(md2).toContain('内部参考 · 请勿外传');
    expect(md2).toContain('观望');
  });

  it('buildBrief：勾选 section 子集只输出选中维度', () => {
    const md = buildBrief(FIXTURE, [], { sections: ['团队情况'] });
    expect(md).toContain('## 团队情况');
    expect(md).not.toContain('## 公司简介');
    expect(RESEARCH_DIMS).toHaveLength(6);
  });

  it('buildBrief：我的判断默认不进简报，勾选后输出完整决策字段', () => {
    const c = {
      ...FIXTURE,
      verdict: {
        recommendation: '优先投',
        expectedSalary: '30K×14，底线 28K',
        resumeFor: 'AI 工程师主简历',
        concerns: '现金流存疑',
        redline: '不接受大小周',
      },
    };
    expect(buildBrief(c, [], {})).not.toContain('优先投');
    const md = buildBrief(c, [], { includeVerdict: true });
    expect(md).toContain('## 我的判断（内部）');
    expect(md).toContain('优先投');
    expect(md).toContain('30K×14');
    expect(md).toContain('AI 工程师主简历');
    expect(md).toContain('不接受大小周');
  });

  it('buildBrief：面试与面经默认不进简报，勾选后输出真题与反馈', () => {
    const c = {
      ...FIXTURE,
      interviews: [
        { round: '一面', form: '视频', date: '2026-11', duration: '60 分钟', questions: '问了系统设计', style: '追问细节', feedback: '算法偏弱' },
      ],
    };
    expect(buildBrief(c, [], {})).not.toContain('一面');
    const md = buildBrief(c, [], { includeInterviews: true });
    expect(md).toContain('## 面试与面经');
    expect(md).toContain('一面 · 视频 · 2026-11');
    expect(md).toContain('问了系统设计');
    expect(md).toContain('算法偏弱');
  });

  it('buildBrief：待核实问题默认不进简报，勾选后输出并标注状态', () => {
    const c = { ...FIXTURE, questions: [{ text: 'B 轮是否到账？', status: '待核实' }] };
    expect(buildBrief(c, [], {})).not.toContain('B 轮');
    const md = buildBrief(c, [], { includeQuestions: true });
    expect(md).toContain('## 待核实问题清单');
    expect(md).toContain('B 轮是否到账？');
  });

  it('briefFilter：面试与待核实问题默认排除，可显式开启', () => {
    expect(briefFilter({}).includeInterviews).toBe(false);
    expect(briefFilter({}).includeQuestions).toBe(false);
    expect(briefFilter({ includeInterviews: true, includeQuestions: true }).includeInterviews).toBe(true);
    expect(briefFilter({ includeInterviews: true }).includeQuestions).toBe(false);
  });
});

describe('D7 多公司横向对比（companyCompareRow / buildCompareTable）', () => {
  const A = {
    name: '甲公司',
    industry: 'AI 应用',
    scale: '500-999人',
    location: '深圳',
    verdict: { recommendation: '优先投', expectedSalary: '30K×14', concerns: '现金流好', redline: '无' },
    questions: [{ text: 'B 轮到账？', status: '待核实' }, { text: '已证伪的', status: '已证伪' }],
  };
  const B = {
    name: '乙公司',
    industry: '金融科技',
    scale: '50-150人',
    location: '北京',
    // 无 verdict，无 questions
  };

  it('companyCompareRow：基础维度正确填充', () => {
    const row = companyCompareRow(A, { referralCount: 3 });
    expect(row.industry.text).toContain('AI 应用');
    expect(row.scale.text).toBe('500-999人');
    expect(row.location.text).toBe('深圳');
    expect(row.recommendation.text).toBe('优先投');
    expect(row.expectedSalary.text).toBe('30K×14');
    expect(row.referral.text).toBe('3');
  });

  it('companyCompareRow：缺失维度标 empty，待核实问题只计未核实的', () => {
    const rowB = companyCompareRow(B, {});
    expect(rowB.recommendation.empty).toBe(true);
    expect(rowB.recommendation.text).toBe('—');
    expect(rowB.concerns.empty).toBe(true);

    const rowA = companyCompareRow(A, {});
    // 待核实问题：A 有 1 条「待核实」+ 1 条「已证伪」，只算未核实 → 1
    expect(rowA.questions.text).toBe('1');
    expect(rowA.questions.empty).toBe(false);
  });

  it('companyCompareRow：完整度按六维覆盖率渲染', () => {
    const c = {
      name: '丙公司',
      research: [
        { dim: '公司简介', content: 'x' },
        { dim: '团队情况', content: 'x' },
        { dim: '盈利情况', content: 'x' },
      ],
    };
    const row = companyCompareRow(c, {});
    expect(row.coverage.text).toBe('3/6 维（50%）');
  });

  it('buildCompareTable：维度为行、公司为列，行数与维度一致', () => {
    const rows = [
      { name: '甲', row: companyCompareRow(A, {}) },
      { name: '乙', row: companyCompareRow(B, {}) },
    ];
    const table = buildCompareTable(rows);
    expect(table).toHaveLength(Object.keys(COMPARE_DIMS).length);
    expect(table[0].cells).toHaveLength(2);
    // 维度顺序按 COMPARE_DIMS 定义
    expect(table[0].dim).toBe('industry');
    expect(table[0].label).toBe('行业');
  });

  it('companyCompareRow：薪资区间与融资摘要正确生成', () => {
    const c = {
      name: '丁公司',
      salaries: [{ role: '算法', low: 25, high: 40, months: 14, period: '月薪' }],
      fundingRounds: [
        { round: 'A', amount: 1, amountUnit: '亿', date: '2024' },
        { round: 'B', amount: 2, amountUnit: '亿', date: '2026-05' },
      ],
    };
    const row = companyCompareRow(c, {});
    expect(row.salaryRange.text).toBe('25–40K/月×14 · 算法');
    expect(row.salaryRange.empty).toBe(false);
    expect(row.funding.text).toContain('B轮');
    expect(row.funding.text).toContain('累计约3');
    expect(row.funding.text).toContain('2026-05');
  });

  it('companyCompareRow：无薪资/融资时标空态', () => {
    const row = companyCompareRow({ name: '戊公司' }, {});
    expect(row.salaryRange.empty).toBe(true);
    expect(row.funding.empty).toBe(true);
  });

  it('normalizeSalaries：缺省币种/周期补全，数值转 number', () => {
    const s = normalizeSalaries([{ role: '后端', low: '20', high: '30' }]);
    expect(s[0].currency).toBe('CNY');
    expect(s[0].period).toBe('月薪');
    expect(s[0].low).toBe(20);
    expect(s[0].high).toBe(30);
    expect(s[0].avg).toBeUndefined();
    expect(normalizeSalaries(undefined)).toEqual([]);
  });

  it('normalizeFundingRounds：缺省币种/单位补全，investors 规整为数组，金额可空', () => {
    const r = normalizeFundingRounds([{ round: 'A', amount: '5000', amountUnit: '万', investors: ['红杉', '高瓴'] }]);
    expect(r[0].currency).toBe('CNY');
    expect(r[0].amountUnit).toBe('万');
    expect(r[0].amount).toBe(5000);
    expect(r[0].investors).toEqual(['红杉', '高瓴']);
    const noAmt = normalizeFundingRounds([{ round: '未披露' }]);
    expect(noAmt[0].amount).toBeUndefined();
    expect(noAmt[0].investors).toEqual([]);
  });
});

describe('D7 简报图片版（buildBriefHtml）', () => {
  const md = [
    '# 甲公司 · 公司简报',
    '> AI 应用 · 500-999人 · 深圳',
    '',
    '**摘要**：做 AI Agent 硬件。',
    '',
    '## 公司简介',
    '- 首款产品是 AI 录音笔。',
    '',
    '## 我的判断（内部）',
    '- 推荐度：优先投',
  ].join('\n');

  it('buildBriefHtml：标题/引用/列表转成 HTML，且转义 HTML 特殊字符', () => {
    const html = buildBriefHtml(md);
    expect(html).toContain('<h1>甲公司 · 公司简报</h1>');
    expect(html).toContain('<p class="meta">AI 应用 · 500-999人 · 深圳</p>');
    expect(html).toContain('<h2>公司简介</h2>');
    expect(html).toContain('<li>首款产品是 AI 录音笔。</li>');
    expect(html).toContain('<strong>摘要</strong>');
  });

  it('buildBriefHtml：默认无「请勿外传」水印，勾选后带水印', () => {
    expect(buildBriefHtml(md)).not.toContain('请勿外传');
    expect(buildBriefHtml(md, { watermark: true })).toContain('内部参考 · 请勿外传');
  });

  it('buildBriefHtml：强制浅色底 + 固定 720px 宽，字体走系统栈', () => {
    const html = buildBriefHtml(md);
    expect(html).toContain('width: 720px');
    expect(html).toContain('background: #ffffff');
    expect(html).toContain('color-scheme: light');
    expect(html).toContain('-apple-system');
  });

  it('buildBriefHtml：HTML 特殊字符被转义，避免注入', () => {
    const evil = buildBriefHtml('# <script>alert(1)</script>');
    expect(evil).not.toContain('<script>');
    expect(evil).toContain('&lt;script&gt;');
  });
});
