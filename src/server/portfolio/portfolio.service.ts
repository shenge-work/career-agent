import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { TenantDb } from '../tenant/tenant-db';
import { publishSite, validateRepo } from './git-publisher';
import { getTemplate, listTemplates } from './templates';
import { isTemplateId } from './types';
import type { PortfolioContent, PortfolioLayout } from './types';

type Json = Record<string, unknown>;

const newId = (prefix: string) => prefix + '_' + randomBytes(9).toString('hex');

function obj(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
}

/**
 * N13 · 个人作品集站点服务。
 *
 * 内容独立维护、布局与模板解耦：
 *   - CRUD 走 TenantDb.forUser（行级隔离铁律）；
 *   - 生成：取 payload（内容）+ layout（布局）+ templateId（模板）→ 渲染静态 HTML；
 *   - 预览：返回 HTML 字符串供前端 iframe 展示；
 *   - 发布（S2）：本地生成 → git CLI 推送，本轮不接。
 */
@Injectable()
export class PortfolioService {
  constructor(@Inject(TenantDb) private readonly tenant: TenantDb) {}

  private t(userId: string) {
    return this.tenant.forUser(userId);
  }

  list(userId: string) {
    return this.t(userId).listPortfolios();
  }

  async get(userId: string, id: string) {
    const rows = await this.t(userId).getPortfolio(id);
    if (!rows.length) throw new NotFoundException('作品集不存在');
    return rows[0];
  }

  async create(userId: string, input: { title: string; templateId: string }) {
    const title = String(input?.title ?? '').trim();
    if (!title) throw new BadRequestException('标题不能为空');
    const templateId = String(input?.templateId || 'minimal');
    if (!isTemplateId(templateId)) throw new BadRequestException('模板不存在');
    const rows = await this.t(userId).createPortfolio({
      id: newId('pf'),
      title,
      templateId,
      layout: {},
      payload: {},
    });
    return rows[0];
  }

  async update(
    userId: string,
    id: string,
    patch: { title?: unknown; templateId?: unknown; layout?: unknown; payload?: unknown }
  ) {
    const existing = await this.get(userId, id);
    const out: { title?: string; templateId?: string; layout?: Json; payload?: Json } = {};
    if (patch.title !== undefined) {
      const title = String(patch.title).trim();
      if (!title) throw new BadRequestException('标题不能为空');
      out.title = title;
    }
    if (patch.templateId !== undefined) {
      const templateId = String(patch.templateId);
      if (!isTemplateId(templateId)) throw new BadRequestException('模板不存在');
      out.templateId = templateId;
    }
    if (patch.layout !== undefined) out.layout = obj(patch.layout);
    if (patch.payload !== undefined) out.payload = obj(patch.payload);
    const rows = await this.t(userId).updatePortfolio(id, out);
    if (!rows.length) throw new NotFoundException('作品集不存在');
    void existing;
    return rows[0];
  }

  async remove(userId: string, id: string) {
    await this.get(userId, id);
    const rows = await this.t(userId).deletePortfolio(id);
    if (!rows.length) throw new NotFoundException('作品集不存在');
    return { ok: true };
  }

  /** 模板画廊：返回内置模板元信息。 */
  templates() {
    return listTemplates();
  }

  /** 生成静态 HTML（预览 / 发布共用）。 */
  async render(userId: string, id: string) {
    const row = await this.get(userId, id);
    const template = getTemplate(row.templateId);
    if (!template) throw new BadRequestException('模板不存在');
    const content = row.payload as unknown as PortfolioContent;
    const layout = (row.layout as unknown as PortfolioLayout) || {};
    const html = template.render(content, layout);
    return { id: row.id, templateId: row.templateId, html };
  }

  /** 返回渲染出的完整 HTML 字符串（发布内部复用）。 */
  private async renderHtml(userId: string, id: string): Promise<string> {
    const { html } = await this.render(userId, id);
    return html;
  }

  /**
   * S2 · 一键发布到 GitHub Pages（git CLI 方案）。
   * 凭证走本机 credential helper，令牌不落盘；支持任意 owner/repo + 分支。
   */
  async deploy(userId: string, id: string, input: { repo?: unknown; branch?: unknown; message?: unknown }) {
    const row = await this.get(userId, id);
    const repo = String(input?.repo ?? '').trim();
    if (!repo) throw new BadRequestException('请填写目标仓库地址（如 owner/repo 或完整 git 地址）');
    let norm;
    try {
      norm = validateRepo(repo);
    } catch (e: any) {
      throw new BadRequestException(e?.message || '仓库地址格式无效');
    }
    const branch = String(input?.branch || 'main').trim();
    const message = String(input?.message || `发布作品集「${row.title}」`);

    const html = await this.renderHtml(userId, id);
    const result = await publishSite({ repo, branch, message }, html);

    // 发布成功 → 更新 deploy 字段（仓库/分支/时间/URL，不存任何凭证）。
    const deploy = {
      repo: result.repo,
      branch: result.branch,
      lastPublishedAt: Date.now(),
      lastUrl: result.url,
      lastCommit: result.commit,
    };
    await this.t(userId).updatePortfolio(id, { deploy });

    return { id: row.id, ...result, publishedAt: deploy.lastPublishedAt };
  }
}
