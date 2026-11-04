import { describe, expect, it } from 'vitest';
import { allThemes, applyThemeToPayload, getTheme, themeList } from '../src/server/business/theme.service';

describe('主题模板系统', () => {
  it('内置 5 套主题，classic 为默认', () => {
    expect(allThemes().length).toBe(5);
    expect(getTheme('classic').name).toBe('经典');
    expect(getTheme('不存在').id).toBe('classic'); // 未知 id 回退 classic
  });

  it('themeList 返回轻量描述', () => {
    const list = themeList();
    expect(list.length).toBe(5);
    expect(list[0]).toHaveProperty('id');
    expect(list[0]).toHaveProperty('name');
    expect(list[0]).not.toHaveProperty('color'); // 不暴露颜色细节
  });

  it('applyThemeToPayload 不修改入参，物化字体/间距/边距/主题', () => {
    const payload = {
      data: { name: '张三', pageMargins: { top: 14, right: 14, bottom: 14, left: 14 } },
      fonts: { name: { label: '姓名', val: 28, min: 16, max: 48 } },
      spacing: { section: { label: '章节标题', mt: 10, mb: 6 } },
      v: 8,
    };
    const before = JSON.stringify(payload);
    const out = applyThemeToPayload(payload, 'modern');
    expect(JSON.stringify(payload)).toBe(before); // 入参未改

    // 字体 val 被覆盖
    expect(out.fonts.name.val).toBe(32);
    // 间距被覆盖
    expect(out.spacing.section.mt).toBe(8);
    expect(out.spacing.section.mb).toBe(5);
    // 边距被覆盖
    expect(out.data.pageMargins.top).toBe(16);
    // 主题标识 + 强调色写入
    expect(out.data.theme.id).toBe('modern');
    expect(out.data.theme.overrides.color.rule).toBe('#2563eb');
  });

  it('classic 主题无颜色 overrides', () => {
    const out = applyThemeToPayload({ data: {} }, 'classic');
    expect(out.data.theme.id).toBe('classic');
    expect(out.data.theme.overrides.color).toEqual({});
  });
});
