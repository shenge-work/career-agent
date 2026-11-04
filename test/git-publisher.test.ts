import { describe, expect, it } from 'vitest';
import { normalizeRepo, validateRepo } from '../src/server/portfolio/git-publisher';

describe('git-publisher · 仓库地址归一化与校验', () => {
  it('解析 owner/repo 简写', () => {
    expect(normalizeRepo('shenge-work/my-portfolio')).toEqual({
      owner: 'shenge-work',
      repo: 'my-portfolio',
      url: 'https://shenge-work.github.io/my-portfolio/',
    });
  });

  it('解析完整 https git 地址', () => {
    const r = normalizeRepo('https://github.com/shenge-work/my-portfolio.git');
    expect(r.owner).toBe('shenge-work');
    expect(r.repo).toBe('my-portfolio');
    expect(r.url).toBe('https://shenge-work.github.io/my-portfolio/');
  });

  it('解析 ssh git 地址', () => {
    const r = normalizeRepo('git@github.com:shenge-work/my-portfolio.git');
    expect(r.owner).toBe('shenge-work');
    expect(r.repo).toBe('my-portfolio');
  });

  it('用户站点 <user>.github.io 映射到根 URL', () => {
    const r = normalizeRepo('shenge-work/shenge-work.github.io');
    expect(r.owner).toBe('shenge-work');
    expect(r.repo).toBe('shenge-work.github.io');
    expect(r.url).toBe('https://shenge-work.github.io/');
  });

  it('空仓库地址抛错', () => {
    expect(() => normalizeRepo('')).toThrow();
    expect(() => normalizeRepo('   ')).toThrow();
  });

  it('非法格式抛错（缺 owner 或 repo）', () => {
    expect(() => normalizeRepo('onlyowner')).toThrow();
    expect(() => normalizeRepo('/no-owner')).toThrow();
    expect(() => normalizeRepo('https://github.com/solo')).toThrow();
  });

  it('validateRepo 拒绝含空白/反斜杠的仓库名（防路径穿越）', () => {
    expect(() => validateRepo('owner/repo with space')).toThrow();
    expect(() => validateRepo('owner/repo\\evil')).toThrow();
  });

  it('validateRepo 通过正常仓库并返回 URL', () => {
    const r = validateRepo('shenge-work/my-portfolio');
    expect(r.url).toBe('https://shenge-work.github.io/my-portfolio/');
  });
});
