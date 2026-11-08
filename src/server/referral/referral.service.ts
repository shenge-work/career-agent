import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { TenantDb, type ReferralPatch } from '../tenant/tenant-db';

const newId = (prefix: string) => prefix + '_' + randomBytes(9).toString('hex');

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});

/**
 * 内推信息（Referral）服务。
 *
 * 内推记录是「求职资源」，不是投递状态：它独立于 applications / tracker 存在，
 * 只通过 companyId 与公司档案关联。字段绝大多数落 payload，这里只做三件事：
 *   1. 校验 companyId 指向的公司确实属于当前用户（跨用户一律 404，不泄露存在性）；
 *   2. 把公司名快照写进 payload.companyName，公司档案被删后列表仍可读；
 *   3. 字段白名单收窄（只允许改 companyId / payload）。
 */
@Injectable()
export class ReferralService {
  constructor(@Inject(TenantDb) private readonly tenant: TenantDb) {}

  private t(userId: string) {
    return this.tenant.forUser(userId);
  }

  private optId(v: unknown): string | null {
    return v == null || v === '' ? null : String(v);
  }

  private async requireReferral(userId: string, id: string) {
    const rows = await this.t(userId).getReferral(id);
    if (!rows.length) throw new NotFoundException('内推信息不存在');
    return rows[0];
  }

  /** 校验并返回关联公司（含名称快照）；未关联公司返回 null。 */
  private async resolveCompany(userId: string, companyId: string | null) {
    if (!companyId) return null;
    const rows = await this.t(userId).getCompany(companyId);
    if (!rows.length) throw new NotFoundException('关联公司不存在');
    return rows[0];
  }

  list(userId: string, companyId?: string) {
    return companyId
      ? this.t(userId).listReferralsForCompany(companyId)
      : this.t(userId).listReferrals();
  }

  get(userId: string, id: string) {
    return this.requireReferral(userId, id);
  }

  async create(
    userId: string,
    input: { companyId?: unknown; payload?: unknown; companyName?: unknown }
  ) {
    const companyId = this.optId(input.companyId);
    const company = await this.resolveCompany(userId, companyId);
    const payload = obj(input.payload);
    // 内推人 / 岗位是这条记录的核心，缺一个就没有管理价值。
    const referrer = String(payload.referrer ?? '').trim();
    const position = String(payload.position ?? '').trim();
    if (!referrer && !position) throw new BadRequestException('至少填写内推人或岗位');

    const id = newId('rf');
    const rows = await this.t(userId).createReferral({
      id,
      companyId,
      payload: {
        ...payload,
        id,
        companyId,
        companyName:
          company?.name ?? (String(input.companyName ?? payload.companyName ?? '').trim() || ''),
      },
    });
    return rows[0];
  }

  async update(
    userId: string,
    id: string,
    input: { companyId?: unknown; payload?: unknown }
  ) {
    const current = await this.requireReferral(userId, id);
    const patch: ReferralPatch = {};

    let companyId = current.companyId;
    if (input.companyId !== undefined) {
      companyId = this.optId(input.companyId);
      await this.resolveCompany(userId, companyId);
      patch.companyId = companyId;
    }

    if (input.payload !== undefined) {
      const payload = obj(input.payload);
      const company = await this.resolveCompany(userId, companyId);
      // 合并而不是整块替换：payload 里可能还有旧版/扩展字段，覆盖式写入会静默丢数据。
      patch.payload = {
        ...obj(current.payload),
        ...payload,
        id,
        companyId,
        companyName:
          company?.name ?? (String(payload.companyName ?? obj(current.payload).companyName ?? '').trim() || ''),
      };
    }

    const rows = await this.t(userId).updateReferral(id, patch);
    if (!rows.length) throw new NotFoundException('内推信息不存在');
    return rows[0];
  }

  async remove(userId: string, id: string) {
    await this.requireReferral(userId, id);
    await this.t(userId).deleteReferral(id);
    return { ok: true };
  }
}
