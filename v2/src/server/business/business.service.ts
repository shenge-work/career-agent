import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { TenantDb, type ResumePatch } from '../tenant/tenant-db';

type Json = Record<string, unknown>;

const newId = (prefix: string) => prefix + '_' + randomBytes(9).toString('hex');

function obj(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
}

/**
 * P2 业务数据统一服务。
 *
 * 所有读写都必须先 forUser(userId)，再调用返回对象里的方法；
 * 这里不持有裸 db，也不允许拼不带 user_id 的 where。
 * 跨用户的账号视图属于 UsersService（RolesGuard admin），不在这里。
 */
@Injectable()
export class BusinessService {
  constructor(@Inject(TenantDb) private readonly tenant: TenantDb) {}

  private t(userId: string) {
    return this.tenant.forUser(userId);
  }

  private async requireResume(userId: string, id: string) {
    const rows = await this.t(userId).getResume(id);
    if (!rows.length) throw new NotFoundException('简历不存在');
    return rows[0];
  }

  private async requireCompany(userId: string, id: string) {
    const rows = await this.t(userId).getCompany(id);
    if (!rows.length) throw new NotFoundException('公司不存在');
    return rows[0];
  }

  // ------------------------------------------------------------ 简历
  async setMaster(userId: string, id: string) {
    const rows = await this.t(userId).setMasterResume(id);
    if (!rows.length) throw new NotFoundException('简历不存在');
    return rows[0];
  }

  async patchResume(userId: string, id: string, patch: ResumePatch) {
    const rows = await this.t(userId).updateResume(id, patch);
    if (!rows.length) throw new NotFoundException('简历不存在');
    return rows[0];
  }

  async removeResume(userId: string, id: string) {
    await this.requireResume(userId, id);
    await this.t(userId).deleteVersionsForResume(id);
    const rows = await this.t(userId).deleteResume(id);
    if (!rows.length) throw new NotFoundException('简历不存在');
    return { ok: true };
  }

  // ------------------------------------------------------ 版本历史
  async listVersions(userId: string, resumeId: string) {
    await this.requireResume(userId, resumeId);
    return this.t(userId).listVersions(resumeId);
  }

  async addVersion(
    userId: string,
    resumeId: string,
    input: { kind?: unknown; label?: unknown; snapshot?: unknown }
  ) {
    await this.requireResume(userId, resumeId);
    const kind = typeof input.kind === 'string' && input.kind.trim() ? input.kind.trim() : 'manual';
    const label = input.label == null ? null : String(input.label);
    const snapshot = obj(input.snapshot);
    const rows = await this.t(userId).addVersion({ resumeId, kind, label, snapshot });
    return rows[0];
  }

  // ---------------------------------------------------------- 公司档案
  listCompanies(userId: string) {
    return this.t(userId).listCompanies();
  }

  async getCompany(userId: string, id: string) {
    return this.requireCompany(userId, id);
  }

  async createCompany(userId: string, input: { name?: unknown; payload?: unknown }) {
    const payload = obj(input.payload);
    const name = String(input.name ?? payload.name ?? '').trim();
    if (!name) throw new BadRequestException('公司名必填');
    const id = newId('co');
    const rows = await this.t(userId).createCompany({ id, name, payload: { ...payload, id, name } });
    return rows[0];
  }

  async updateCompany(userId: string, id: string, input: { name?: unknown; payload?: unknown }) {
    await this.requireCompany(userId, id);
    const patch: { name?: string; payload?: Json } = {};
    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (!name) throw new BadRequestException('公司名不能为空');
      patch.name = name;
    }
    if (input.payload !== undefined) {
      const payload = obj(input.payload);
      patch.payload = { ...payload, id, ...(patch.name ? { name: patch.name } : {}) };
      if (!patch.name && payload.name !== undefined) patch.name = String(payload.name);
    }
    const rows = await this.t(userId).updateCompany(id, patch);
    if (!rows.length) throw new NotFoundException('公司不存在');
    return rows[0];
  }

  async deleteCompany(userId: string, id: string) {
    await this.requireCompany(userId, id);
    await this.t(userId).deleteCompanyJdsForCompany(id);
    const rows = await this.t(userId).deleteCompany(id);
    if (!rows.length) throw new NotFoundException('公司不存在');
    return { ok: true };
  }

  // ------------------------------------------------------ 公司岗位 JD
  async listCompanyJds(userId: string, companyId: string) {
    await this.requireCompany(userId, companyId);
    return this.t(userId).listCompanyJds(companyId);
  }

  async createCompanyJd(userId: string, companyId: string, input: { payload?: unknown }) {
    await this.requireCompany(userId, companyId);
    const id = newId('jd');
    const payload = obj(input.payload);
    const rows = await this.t(userId).createCompanyJd({
      id,
      companyId,
      payload: { ...payload, id, companyId },
    });
    return rows[0];
  }

  async deleteCompanyJd(userId: string, companyId: string, jdId: string) {
    await this.requireCompany(userId, companyId);
    const rows = await this.t(userId).getCompanyJd(jdId);
    if (!rows.length || rows[0].companyId !== companyId) throw new NotFoundException('岗位不存在');
    await this.t(userId).deleteCompanyJd(jdId);
    return { ok: true };
  }

  // ---------------------------------------------------------- 投递管理
  listTracker(userId: string) {
    return this.t(userId).listTracker();
  }

  async getTracker(userId: string, id: string) {
    const rows = await this.t(userId).getTracker(id);
    if (!rows.length) throw new NotFoundException('投递记录不存在');
    return rows[0];
  }

  async createTracker(userId: string, input: { companyId?: unknown; payload?: unknown }) {
    const companyId = input.companyId == null || input.companyId === '' ? null : String(input.companyId);
    if (companyId) await this.requireCompany(userId, companyId);
    const id = newId('trk');
    const payload = obj(input.payload);
    const rows = await this.t(userId).createTracker({
      id,
      companyId,
      payload: { ...payload, id, companyId },
    });
    return rows[0];
  }

  async updateTracker(userId: string, id: string, input: { companyId?: unknown; payload?: unknown }) {
    await this.getTracker(userId, id);
    const patch: { companyId?: string | null; payload?: Json } = {};
    if (input.companyId !== undefined) {
      patch.companyId = input.companyId == null || input.companyId === '' ? null : String(input.companyId);
      if (patch.companyId) await this.requireCompany(userId, patch.companyId);
    }
    if (input.payload !== undefined) {
      const payload = obj(input.payload);
      patch.payload = { ...payload, id, ...(patch.companyId !== undefined ? { companyId: patch.companyId } : {}) };
    }
    const rows = await this.t(userId).updateTracker(id, patch);
    if (!rows.length) throw new NotFoundException('投递记录不存在');
    return rows[0];
  }

  async deleteTracker(userId: string, id: string) {
    await this.getTracker(userId, id);
    const rows = await this.t(userId).deleteTracker(id);
    if (!rows.length) throw new NotFoundException('投递记录不存在');
    return { ok: true };
  }

  // -------------------------------------------------------------- 设置
  async getSettings(userId: string) {
    const rows = await this.t(userId).getSettings();
    return { payload: rows.length ? rows[0].payload : {} };
  }

  async mergeSettings(userId: string, input: unknown) {
    const patch = obj(input);
    if (!Object.keys(patch).length) throw new BadRequestException('设置内容不能为空');
    const rows = await this.t(userId).mergeSettings(patch);
    return { payload: rows[0].payload };
  }
}
