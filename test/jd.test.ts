import { describe, expect, it } from 'vitest';
import {
  analyze,
  buildDerivedPayload,
  countHits,
  deriveTitle,
  extractTerms,
} from '../src/server/business/jd.service';

const JD = `Agent 开发工程师：负责大模型 Agent 应用研发与工程化落地，要求熟悉 Multi-Agent 编排、RAG、Tool Calling / MCP 协议、LLM 评测体系，有通用 Agent 基座二次开发、云沙箱与 Skill 工具生态建设经验者优先。`;

const payload = {
  data: {
    name: '张三',
    sections: [
      { type: 'skills', title: '专业技能', groups: [{ name: 'AI', keywords: 'Multi-Agent 编排 · RAG · Tool Calling', detail: '' }] },
      { type: 'career', title: '职业履历', items: [] },
    ],
  },
};

describe('JD 匹配分析（移植自 v1 jd-match.js）', () => {
  it('extractTerms 抽取英文短语（Multi-Agent 合并不拆词）', () => {
    const terms = extractTerms(JD);
    const keys = terms.map((t) => t.term);
    expect(keys).toContain('Multi-Agent');
    expect(keys.some((k) => k.toLowerCase().includes('mcp'))).toBe(true);
    expect(keys.some((k) => k.toLowerCase().includes('rag'))).toBe(true);
  });

  it('countHits 英文按词边界（Java 不命中 JavaScript）', () => {
    expect(countHits('Java', 'I know Java and JavaScript')).toBe(1);
    expect(countHits('Java', 'Java,Java')).toBe(2);
  });

  it('analyze 正确区分覆盖/缺失', () => {
    const r = analyze(payload, JD);
    // 简历里明确有 Multi-Agent / RAG / Tool Calling
    expect(r.stats.total).toBeGreaterThan(0);
    const coveredTerms = r.groups.covered.map((x) => x.term.toLowerCase());
    // Multi-Agent 在技能里出现一次 => 弱覆盖（hits>=2 才 covered）
    // RAG 也一次 => weak；未出现的 => missing
    expect(r.groups.missing.length).toBeGreaterThan(0);
    expect(r.stats.score).toBeGreaterThanOrEqual(0);
    expect(r.stats.score).toBeLessThanOrEqual(100);
  });

  it('analyze 对空 JD 返回 total 0', () => {
    const r = analyze(payload, '');
    expect(r.stats.total).toBe(0);
    expect(r.stats.score).toBe(0);
  });
});

describe('派生简历（移植自 v1 jd-derive.js）', () => {
  it('buildDerivedPayload 不修改入参，插入待补分组', () => {
    const before = JSON.stringify(payload);
    const r = analyze(payload, JD);
    const derived = buildDerivedPayload(payload, r);
    expect(JSON.stringify(payload)).toBe(before); // 入参未被改动

    const skills = derived.data.sections.find((s: any) => s.type === 'skills');
    expect(skills).toBeTruthy();
    // 有缺失/弱覆盖时，追加「JD 定制待补」分组
    const fillGroup = skills.groups.find((g: any) => g.name && g.name.includes('待补'));
    expect(fillGroup).toBeTruthy();
    expect(fillGroup.items.length).toBeGreaterThan(0);
  });

  it('deriveTitle 从 JD 提炼岗位名', () => {
    const title = deriveTitle('满血', JD);
    expect(title).toContain('Agent');
    expect(title).toContain('定制');
  });

  it('deriveTitle 空 JD 时回退', () => {
    expect(deriveTitle('主简历', '')).toBe('主简历 · JD 定制版');
  });

  it('deriveTitle 处理「岗位+薪资+城市」长串', () => {
    const t = deriveTitle('主简历', '全栈开发工程师 20-35K·13薪（杭州·3-5年·本科）。核心职责：1、负责…');
    expect(t).toContain('全栈');
    expect(t).toContain('杭州');
  });
});
