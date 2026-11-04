import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { TenantDb, type ResumeInput, type ResumePatch } from '../tenant/tenant-db';

const KINDS = ['master', 'derived', 'blank'] as const;
const PATCH_KEYS = ['title', 'payload', 'tags', 'kind', 'parentId', 'jobId', 'jdText'] as const;

@Injectable()
export class ResumesService {
  constructor(@Inject(TenantDb) private readonly tenant: TenantDb) {}

  list(userId: string) {
    return this.tenant.forUser(userId).listResumes();
  }

  async get(userId: string, id: string) {
    const rows = await this.tenant.forUser(userId).getResume(id);
    if (!rows.length) throw new NotFoundException('简历不存在');
    return rows[0];
  }

  async create(userId: string, input: Omit<ResumeInput, 'id'>) {
    const id = 'res_' + randomBytes(9).toString('hex');
    const rows = await this.tenant.forUser(userId).createResume({ ...input, id });
    return rows[0];
  }

  async update(userId: string, id: string, patch: any) {
    const allowed: ResumePatch = {};
    for (const k of PATCH_KEYS) {
      if (patch && patch[k] !== undefined) (allowed as any)[k] = patch[k];
    }
    if (allowed.kind !== undefined && !KINDS.includes(allowed.kind as any)) {
      throw new BadRequestException('kind 只能是 master / derived / blank');
    }
    if (allowed.tags !== undefined && !Array.isArray(allowed.tags)) {
      throw new BadRequestException('tags 必须是数组');
    }
    const rows = await this.tenant.forUser(userId).updateResume(id, allowed);
    if (!rows.length) throw new NotFoundException('简历不存在');
    return rows[0];
  }

  /** 删除简历时一并清掉它的版本快照，避免留下悬空历史。 */
  async remove(userId: string, id: string) {
    const t = this.tenant.forUser(userId);
    const found = await t.getResume(id);
    if (!found.length) throw new NotFoundException('简历不存在');
    await t.deleteVersionsForResume(id);
    const rows = await t.deleteResume(id);
    if (!rows.length) throw new NotFoundException('简历不存在');
    return { ok: true };
  }

  /** 主简历互斥：事务内先清旧主再设新主，目标不存在时零副作用。 */
  async setMaster(userId: string, id: string) {
    const rows = await this.tenant.forUser(userId).setMasterResume(id);
    if (!rows.length) throw new NotFoundException('简历不存在');
    return rows[0];
  }
}
