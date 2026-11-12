import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { TenantDb, type SnippetPatch } from '../tenant/tenant-db';

const newId = () => 'sn_' + randomBytes(9).toString('hex');

/** STAR 四要素的字段键，用于批量收敛校验与合并。 */
const STAR_KEYS = ['situation', 'task', 'action', 'result'] as const;
type StarKey = (typeof STAR_KEYS)[number];

/** 规范化 tags：去空白、去空、去重。 */
function normTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of v) {
    const s = String(t).trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/**
 * STAR 经历素材（Snippet）服务。
 *
 * 素材库是「跨简历复用的经历片段」，不是简历本身。字段白名单收窄：
 * 只允许改 title / category / tags / situation / task / action / result，
 * 同步三元组与时间戳由 DB 触发器与租户层统一维护。
 */
@Injectable()
export class SnippetService {
  constructor(@Inject(TenantDb) private readonly tenant: TenantDb) {}

  private t(userId: string) {
    return this.tenant.forUser(userId);
  }

  private async requireSnippet(userId: string, id: string) {
    const rows = await this.t(userId).getSnippet(id);
    if (!rows.length) throw new NotFoundException('素材不存在');
    return rows[0];
  }

  list(userId: string) {
    return this.t(userId).listSnippets();
  }

  get(userId: string, id: string) {
    return this.requireSnippet(userId, id);
  }

  async create(userId: string, body: any) {
    const title = String(body?.title ?? '').trim();
    if (!title) throw new BadRequestException('素材标题不能为空');

    // STAR 四要素至少填一个，否则没有复用价值。
    const anyStar = STAR_KEYS.some((k) => String(body?.[k] ?? '').trim());
    if (!anyStar) throw new BadRequestException('STAR 四要素至少填写一项');

    const id = newId();
    const rows = await this.t(userId).createSnippet({
      id,
      title,
      category: body?.category ? String(body.category).trim() : null,
      tags: normTags(body?.tags),
      situation: body?.situation ? String(body.situation).trim() : null,
      task: body?.task ? String(body.task).trim() : null,
      action: body?.action ? String(body.action).trim() : null,
      result: body?.result ? String(body.result).trim() : null,
    });
    return rows[0];
  }

  async update(userId: string, id: string, body: any) {
    await this.requireSnippet(userId, id);
    const patch: SnippetPatch = {};

    if (body?.title !== undefined) {
      const title = String(body.title).trim();
      if (!title) throw new BadRequestException('素材标题不能为空');
      patch.title = title;
    }
    if (body?.category !== undefined) patch.category = body.category ? String(body.category).trim() : null;
    if (body?.tags !== undefined) patch.tags = normTags(body.tags);
    for (const k of STAR_KEYS) {
      if (body?.[k] !== undefined) patch[k] = body[k] ? String(body[k]).trim() : null;
    }

    const rows = await this.t(userId).updateSnippet(id, patch);
    if (!rows.length) throw new NotFoundException('素材不存在');
    return rows[0];
  }

  async remove(userId: string, id: string) {
    await this.requireSnippet(userId, id);
    await this.t(userId).deleteSnippet(id);
    return { ok: true };
  }
}
