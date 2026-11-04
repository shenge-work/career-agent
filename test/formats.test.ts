import { describe, expect, it } from 'vitest';
import { resumeToFormats } from '../src/server/render/formats.service';

/** 最小但覆盖各 section type 的 payload.data */
const data = {
  name: '张三',
  subtitle: '**全栈**工程师',
  meta: '',
  contact: [{ text: 'github.com/zhang' }, { text: '13800000000 | zhang@test.com' }],
  sections: [
    {
      type: 'highlights',
      title: '个人优势',
      cards: [{ text: '**5年**全栈经验，主导多套系统从 0 到 1。' }],
    },
    {
      type: 'growth',
      title: '技术成长路径',
      phases: [
        { label: '阶段 1', date: '2021-2023', title: '工程基石', desc: '深耕后端。' },
      ],
    },
    {
      type: 'skills',
      title: '专业技能',
      groups: [
        { name: '后端', keywords: '**Java** · Spring Boot', detail: '5 年深耕。' },
      ],
    },
    {
      type: 'career',
      title: '职业履历',
      items: [
        {
          company: '某科技公司',
          role: '全栈工程师',
          date: '2024.01 - 至今',
          summary: '负责核心系统研发。',
          projects: [
            {
              name: 'X 平台',
              desc: '一个平台。',
              results: [{ text: '性能提升 30%。' }],
            },
          ],
        },
      ],
    },
  ],
};

describe('resumeToFormats 多格式导出', () => {
  const { txt, md, html } = resumeToFormats(data);

  it('txt 去掉 ** 标记', () => {
    expect(txt).not.toContain('**');
    expect(txt).toContain('张三');
    expect(txt).toContain('个人优势');
    expect(txt).toContain('5年全栈经验');
    expect(txt).toContain('性能提升 30%。');
  });

  it('md 保留 ** 加粗与标题层级', () => {
    expect(md).toContain('**5年**');
    expect(md).toContain('## 职业履历');
    expect(md).toContain('- 性能提升 30%。');
    expect(md).toContain('### X 平台');
  });

  it('doc/html 把 ** 转成 <strong> 并含标题', () => {
    expect(html).toContain('<strong>5年</strong>');
    expect(html).toContain('<h2>职业履历</h2>');
    expect(html).toContain('<strong>X 平台</strong>');
    expect(html).toContain('张三');
  });

  it('三种格式都不丢任何 section 内容', () => {
    for (const s of [txt, md]) {
      expect(s).toContain('个人优势');
      expect(s).toContain('技术成长路径');
      expect(s).toContain('专业技能');
      expect(s).toContain('职业履历');
    }
  });
});
