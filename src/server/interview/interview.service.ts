import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { TenantDb } from '../tenant/tenant-db';
import type { InterviewKbPatch, InterviewNotePatch } from '../tenant/tenant-db';

const newId = (prefix: string) => prefix + '_' + randomBytes(9).toString('hex');

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});

/**
 * 面试复盘 + 面经知识库服务（N12 S2）。
 * 纯 CRUD 数据访问 + 字段白名单收窄，跨用户一律 404。
 * AI 复盘 / 问答走 AgentService（review-interview / kb-ask），这里只做落库与检索。
 */
@Injectable()
export class InterviewService {
  constructor(@Inject(TenantDb) private readonly tenant: TenantDb) {}

  private t(userId: string) {
    return this.tenant.forUser(userId);
  }

  private optId(v: unknown): string | null {
    return v == null || v === '' ? null : String(v);
  }
  private optStr(v: unknown): string | null {
    return v == null ? null : String(v).trim();
  }
  private optDate(v: unknown): Date | null {
    if (v == null || v === '') return null;
    const d = new Date(String(v));
    return isNaN(d.getTime()) ? null : d;
  }
  private strArr(v: unknown): string[] {
    return Array.isArray(v) ? v.slice(0, 40).map((x) => String(x).trim()).filter(Boolean) : [];
  }

  private async requireNote(userId: string, id: string) {
    const rows = await this.t(userId).getInterviewNote(id);
    if (!rows.length) throw new NotFoundException('面试记录不存在');
    return rows[0];
  }

  // ---------------------------------------------------------- 面试复盘

  listNotes(userId: string, applicationId?: string) {
    return this.t(userId).listInterviewNotes(applicationId || undefined);
  }

  getNote(userId: string, id: string) {
    return this.requireNote(userId, id);
  }

  async createNote(
    userId: string,
    input: {
      applicationId?: unknown;
      company?: unknown;
      position?: unknown;
      round?: unknown;
      interviewAt?: unknown;
      payload?: unknown;
    }
  ) {
    const applicationId = this.optId(input.applicationId);
    if (applicationId) {
      const apps = await this.t(userId).getApplication(applicationId);
      if (!apps.length) throw new NotFoundException('关联岗位不存在');
    }
    const id = newId('in');
    const payload = obj(input.payload);
    const rows = await this.t(userId).createInterviewNote({
      id,
      applicationId,
      company: this.optStr(input.company),
      position: this.optStr(input.position),
      round: this.optStr(input.round),
      interviewAt: this.optDate(input.interviewAt),
      payload,
    });
    return rows[0];
  }

  async updateNote(
    userId: string,
    id: string,
    input: {
      applicationId?: unknown;
      company?: unknown;
      position?: unknown;
      round?: unknown;
      interviewAt?: unknown;
      payload?: unknown;
    }
  ) {
    await this.requireNote(userId, id);
    const patch: InterviewNotePatch = {};

    if (input.applicationId !== undefined) {
      const applicationId = this.optId(input.applicationId);
      if (applicationId) {
        const apps = await this.t(userId).getApplication(applicationId);
        if (!apps.length) throw new NotFoundException('关联岗位不存在');
      }
      patch.applicationId = applicationId;
    }
    if (input.company !== undefined) patch.company = this.optStr(input.company);
    if (input.position !== undefined) patch.position = this.optStr(input.position);
    if (input.round !== undefined) patch.round = this.optStr(input.round);
    if (input.interviewAt !== undefined) patch.interviewAt = this.optDate(input.interviewAt);
    if (input.payload !== undefined) patch.payload = obj(input.payload);

    const rows = await this.t(userId).updateInterviewNote(id, patch);
    return rows[0];
  }

  async deleteNote(userId: string, id: string) {
    await this.requireNote(userId, id);
    return this.t(userId).deleteInterviewNote(id);
  }

  // ---------------------------------------------------------- 面经知识库

  listKb(userId: string) {
    return this.t(userId).listKb();
  }

  getKb(userId: string, id: string) {
    return this.requireKb(userId, id);
  }

  private async requireKb(userId: string, id: string) {
    const rows = await this.t(userId).getKb(id);
    if (!rows.length) throw new NotFoundException('面经条目不存在');
    return rows[0];
  }

  async createKb(
    userId: string,
    input: { title?: unknown; category?: unknown; tags?: unknown; content?: unknown }
  ) {
    const title = String(input.title ?? '').trim();
    if (!title) throw new BadRequestException('标题必填');
    const content = String(input.content ?? '').trim();
    if (!content) throw new BadRequestException('内容必填');

    const id = newId('kb');
    const rows = await this.t(userId).createKb({
      id,
      title,
      category: this.optStr(input.category),
      tags: this.strArr(input.tags),
      content,
    });
    return rows[0];
  }

  async updateKb(
    userId: string,
    id: string,
    input: { title?: unknown; category?: unknown; tags?: unknown; content?: unknown }
  ) {
    await this.requireKb(userId, id);
    const patch: InterviewKbPatch = {};

    if (input.title !== undefined) {
      const title = String(input.title).trim();
      if (!title) throw new BadRequestException('标题不能为空');
      patch.title = title;
    }
    if (input.category !== undefined) patch.category = this.optStr(input.category);
    if (input.tags !== undefined) patch.tags = this.strArr(input.tags);
    if (input.content !== undefined) {
      const content = String(input.content).trim();
      if (!content) throw new BadRequestException('内容不能为空');
      patch.content = content;
    }

    const rows = await this.t(userId).updateKb(id, patch);
    return rows[0];
  }

  async deleteKb(userId: string, id: string) {
    await this.requireKb(userId, id);
    return this.t(userId).deleteKb(id);
  }

  searchKb(userId: string, query: string, limit?: number) {
    return this.t(userId).searchKb(query, limit || 10);
  }
}
