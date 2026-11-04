import { describe, expect, it } from 'vitest';
import {
  buildBrief,
  briefFilter,
  dimensionCoverage,
  expandIndustryQuery,
  inferIndustryCategory,
  matchCompany,
  normalizeCompany,
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
});
