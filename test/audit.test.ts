import { describe, expect, it } from 'vitest';
import { auditResume } from '../src/server/business/audit.service';

const fullPayload = {
  data: {
    name: '张三',
    subtitle: 'AI 工程师',
    meta: '5 年经验 · 深圳',
    contact: [
      { text: '13800138000' },
      { text: 'zhangsan@example.com' },
    ],
    sections: [
      {
        type: 'career',
        title: '职业履历',
        items: [
          {
            company: '某科技',
            role: '后端工程师',
            date: '2021-2024',
            summary: '负责核心系统',
            projects: [
              {
                name: 'AI 平台',
                desc: '搭建平台',
                results: [
                  { text: '接口性能提升 60%，QPS 从 100 提升到 800' },
                  { text: '覆盖 50 万用户，月活 20 万' },
                ],
              },
            ],
          },
        ],
      },
      { type: 'skills', title: '专业技能', groups: [{ name: 'AI', keywords: 'Java · Python', detail: '' }] },
    ],
  },
};

describe('投递体检（audit.service）', () => {
  it('信息完整 + 量化充分 + 无敏感 → 高分', () => {
    const r = auditResume(fullPayload);
    expect(r.summary.fail).toBe(0);
    expect(r.score).toBeGreaterThanOrEqual(80);
    const basics = r.items.find((i) => i.key === 'basics');
    expect(basics?.level).toBe('ok');
  });

  it('缺少姓名与联系方式 → basics fail', () => {
    const r = auditResume({ data: { name: '', contact: [], sections: [] } });
    const basics = r.items.find((i) => i.key === 'basics');
    expect(basics?.level).toBe('fail');
    expect(basics?.detail).toContain('姓名');
    expect(basics?.detail).toContain('联系方式（电话或邮箱）');
  });

  it('检测身份证号 → sensitive fail', () => {
    const r = auditResume({
      data: {
        name: '张三',
        contact: [{ text: '13800138000' }],
        sections: [{ type: 'custom', title: '其他', text: '身份证 110101199001011234' }],
      },
    });
    const s = r.items.find((i) => i.key === 'sensitive');
    expect(s?.level).toBe('fail');
    expect(s?.detail).toContain('身份证号');
  });

  it('空简历 → 多项告警但结构完整', () => {
    const r = auditResume({ data: {} });
    expect(r.items).toHaveLength(5);
    expect(r.summary.ok + r.summary.warn + r.summary.fail).toBe(5);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it('** 加粗残留 → ATS warn', () => {
    const r = auditResume({
      data: {
        name: '张三',
        contact: [{ text: '13800138000' }],
        sections: [{ type: 'career', title: '履历', items: [{ company: 'A', summary: '负责**核心**系统' }] }],
      },
    });
    const ats = r.items.find((i) => i.key === 'ats');
    expect(ats?.level).toBe('warn');
    expect(ats?.detail?.join('')).toContain('加粗');
  });
});
