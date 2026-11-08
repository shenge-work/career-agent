import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { TenantDb, type ResumePatch } from '../tenant/tenant-db';
import type { ApplicationInput, ApplicationPatch, ApplicationStatus } from '../tenant/tenant-db';
import { selectVersionIdsToKeep } from './version-policy';
import { analyze, buildDerivedPayload, deriveTitle, extractTerms } from './jd.service';
import { allThemes, applyThemeToPayload, getTheme, themeList } from './theme.service';

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
    // 保留策略失败不影响留痕主流程（与 v1 一致：降采样静默降级）
    this.pruneVersions(userId, resumeId).catch(() => undefined);
    return rows[0];
  }

  /**
   * 恢复某个历史版本到简历正文 —— 版本功能重新设计后的核心闭环（取代 v1 飞书版本恢复）：
   * 1. 目标版本必须属于当前用户 + 该简历（别人的快照一律 404，不泄露存在性）；
   * 2. 恢复是可逆的：当前内容先自动存为新版本（kind=auto），再写回目标快照；
   * 3. 写回后 savedAt / updatedAt 同步刷新，编辑器重新拉取即可看到恢复结果。
   */
  async restoreVersion(userId: string, resumeId: string, versionId: string) {
    const resume = await this.requireResume(userId, resumeId);
    const rows = await this.t(userId).getVersionById(resumeId, versionId);
    const version = rows[0];
    if (!version) throw new NotFoundException('版本不存在');
    if (!version.snapshot || typeof version.snapshot !== 'object') {
      throw new BadRequestException('该版本缺少可恢复的内容快照');
    }
    await this.t(userId).addVersion({
      resumeId,
      kind: 'auto',
      label: `恢复前自动快照（${new Date().toLocaleString('zh-CN')}）`,
      snapshot: resume.payload as Json,
    });
    const updated = await this.t(userId).updateResume(resumeId, {
      payload: version.snapshot as Json,
    });
    return { resumed: updated[0], restoredFrom: version };
  }

  /** 保留策略执行：manual 永保；auto 按最近 50 条 + 每天首尾 2 条 + 30 天窗口降采样。 */
  private async pruneVersions(userId: string, resumeId: string) {
    const all = await this.t(userId).listVersions(resumeId);
    const keep = selectVersionIdsToKeep(
      all.map((v) => ({ id: v.id, kind: v.kind, createdAt: v.createdAt }))
    );
    const dropIds = all.filter((v) => !keep.has(v.id)).map((v) => v.id);
    if (dropIds.length) {
      await this.t(userId).deleteVersionsNotIn(
        resumeId,
        all.filter((v) => keep.has(v.id)).map((v) => v.id)
      );
    }
    return dropIds.length;
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
    // 内推信息随公司一起软删除：它挂的是 companyId，留着会变成无主记录。
    await this.t(userId).deleteReferralsForCompany(id);
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

  /** 就地更新 JD 载荷（补录发布时间/职责/技能等），不换 id，避免打断 applications.jdId 关联。 */
  async updateCompanyJd(userId: string, companyId: string, jdId: string, input: { payload?: unknown }) {
    await this.requireCompany(userId, companyId);
    const rows = await this.t(userId).getCompanyJd(jdId);
    if (!rows.length || rows[0].companyId !== companyId) throw new NotFoundException('岗位不存在');
    const prev = obj(rows[0].payload);
    const payload = { ...prev, ...obj(input.payload), id: jdId, companyId };
    const updated = await this.t(userId).updateCompanyJd(jdId, payload);
    if (!updated.length) throw new NotFoundException('岗位不存在');
    return updated[0];
  }

  async deleteCompanyJd(userId: string, companyId: string, jdId: string) {
    await this.requireCompany(userId, companyId);
    const rows = await this.t(userId).getCompanyJd(jdId);
    if (!rows.length || rows[0].companyId !== companyId) throw new NotFoundException('岗位不存在');
    await this.t(userId).deleteCompanyJd(jdId);
    return { ok: true };
  }

  // ---------------------------------------------------------- 主题模板
  listThemes() {
    return themeList();
  }

  /** 应用主题：物化字体/间距/边距/强调色到 payload，并写回简历。 */
  async applyTheme(userId: string, resumeId: string, themeId: string) {
    const resume = await this.requireResume(userId, resumeId);
    const th = getTheme(String(themeId || 'classic'));
    const payload = applyThemeToPayload(resume.payload, th.id);
    const rows = await this.t(userId).updateResume(resumeId, { payload });
    if (!rows.length) throw new NotFoundException('简历不存在');
    return { ...rows[0], theme: th.id };
  }

  // ------------------------------------------------------ JD 匹配与派生
  /** 对某份简历 + 一段 JD 文本做只读匹配分析（纯规则，不联网）。 */
  async analyzeJd(userId: string, resumeId: string, jdText: string) {
    const resume = await this.requireResume(userId, resumeId);
    const text = String(jdText || '').trim();
    if (!text) throw new BadRequestException('JD 内容不能为空');
    const result = analyze(resume.payload, text);
    const terms = extractTerms(text);
    return { ...result, termCount: terms.length, resumeId, jdText: text };
  }

  /**
   * 从「主简历 + JD」生成一份派生简历（kind=derived）。
   * 不覆盖主简历；缺失/弱覆盖关键词作为「待补」提示插入派生副本。
   * 返回新建的简历行（title 由 deriveTitle 生成，tags[0] 用公司简称，可传覆盖）。
   */
  async deriveResumeFromJd(
    userId: string,
    parentResumeId: string,
    input: { jdText?: unknown; jobId?: unknown; tags?: unknown }
  ) {
    const parent = await this.requireResume(userId, parentResumeId);
    const jdText = String(input.jdText || parent.jdText || '').trim();
    if (!jdText) throw new BadRequestException('缺少 JD 文本，无法派生');
    const analysis = analyze(parent.payload, jdText);
    const payload = buildDerivedPayload(parent.payload, analysis);
    const title = deriveTitle(String(parent.title || '简历'), jdText);
    const id = newId('res');
    const tags = Array.isArray(input.tags) ? input.tags.map(String) : null;
    const rows = await this.t(userId).createResume({
      id,
      title,
      kind: 'derived',
      parentId: parentResumeId,
      jobId: input.jobId == null || input.jobId === '' ? null : String(input.jobId),
      jdText,
      tags,
      payload,
    });
    return { ...rows[0], analysis };
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

  // ------------------------------------------------------ 岗位/申请（聚合根）
  private async requireApplication(userId: string, id: string) {
    const rows = await this.t(userId).getApplication(id);
    if (!rows.length) throw new NotFoundException('岗位不存在');
    return rows[0];
  }

  listApplications(userId: string) {
    return this.t(userId).listApplications();
  }

  async getApplication(userId: string, id: string) {
    return this.requireApplication(userId, id);
  }

  async createApplication(userId: string, input: {
    position?: unknown;
    companyId?: unknown;
    jdId?: unknown;
    resumeId?: unknown;
    trackerId?: unknown;
    status?: unknown;
    stage?: unknown;
    followUpAfterDays?: unknown;
    payload?: unknown;
  }) {
    const position = String(input.position ?? '').trim();
    if (!position) throw new BadRequestException('岗位名必填');

    const companyId = this.optId(input.companyId);
    const resumeId = this.optId(input.resumeId);
    const trackerId = this.optId(input.trackerId);
    const jdId = this.optId(input.jdId);

    if (companyId) await this.requireCompany(userId, companyId);
    if (resumeId) await this.requireResume(userId, resumeId);
    if (trackerId) await this.getTracker(userId, trackerId);

    const status = this.normalizeStatus(input.status);
    const id = newId('app');
    const payload = obj(input.payload);

    const rows = await this.t(userId).createApplication({
      id,
      position,
      companyId,
      jdId,
      resumeId,
      trackerId,
      status,
      stage: input.stage == null ? null : String(input.stage),
      followUpAfterDays: this.optInt(input.followUpAfterDays),
      payload: { ...payload, id, position },
    });

    // 旅程起点事件
    await this.t(userId).addApplicationEvent({
      applicationId: id,
      fromStatus: null,
      toStatus: status,
    });

    return rows[0];
  }

  async updateApplication(userId: string, id: string, input: {
    position?: unknown;
    companyId?: unknown;
    jdId?: unknown;
    resumeId?: unknown;
    trackerId?: unknown;
    status?: unknown;
    stage?: unknown;
    followUpAfterDays?: unknown;
    payload?: unknown;
  }) {
    const current = await this.requireApplication(userId, id);
    const patch: ApplicationPatch = {};

    if (input.position !== undefined) {
      const position = String(input.position).trim();
      if (!position) throw new BadRequestException('岗位名不能为空');
      patch.position = position;
    }
    if (input.companyId !== undefined) {
      const companyId = this.optId(input.companyId);
      if (companyId) await this.requireCompany(userId, companyId);
      patch.companyId = companyId;
    }
    if (input.resumeId !== undefined) {
      const resumeId = this.optId(input.resumeId);
      if (resumeId) await this.requireResume(userId, resumeId);
      patch.resumeId = resumeId;
    }
    if (input.trackerId !== undefined) {
      const trackerId = this.optId(input.trackerId);
      if (trackerId) await this.getTracker(userId, trackerId);
      patch.trackerId = trackerId;
    }
    if (input.jdId !== undefined) patch.jdId = this.optId(input.jdId);
    if (input.stage !== undefined) patch.stage = input.stage == null ? null : String(input.stage);
    if (input.followUpAfterDays !== undefined) patch.followUpAfterDays = this.optInt(input.followUpAfterDays);
    if (input.payload !== undefined) patch.payload = { ...obj(input.payload), id };

    // 状态变更：写一条流水（fromStatus 取变更前的状态），并顺带更新 appliedAt。
    const nextStatus = input.status !== undefined ? this.normalizeStatus(input.status) : undefined;
    if (nextStatus && nextStatus !== current.status) {
      patch.status = nextStatus;
      if (nextStatus === 'applied' && !current.appliedAt) {
        patch.appliedAt = new Date();
      }
    }

    const rows = await this.t(userId).updateApplication(id, patch);
    if (!rows.length) throw new NotFoundException('岗位不存在');

    if (nextStatus && nextStatus !== current.status) {
      await this.t(userId).addApplicationEvent({
        applicationId: id,
        fromStatus: current.status,
        toStatus: nextStatus,
      });
    }

    return rows[0];
  }

  async deleteApplication(userId: string, id: string) {
    await this.requireApplication(userId, id);
    await this.t(userId).deleteApplicationEvents(id);
    const rows = await this.t(userId).deleteApplication(id);
    if (!rows.length) throw new NotFoundException('岗位不存在');
    return { ok: true };
  }

  async listApplicationEvents(userId: string, applicationId: string) {
    await this.requireApplication(userId, applicationId);
    return this.t(userId).listApplicationEvents(applicationId);
  }

  // ---------------------------------------------------- 岗位工具方法
  private optId(v: unknown): string | null {
    return v == null || v === '' ? null : String(v);
  }

  private optInt(v: unknown): number | null {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  private normalizeStatus(v: unknown): ApplicationStatus {
    const s = v == null || v === '' ? 'interested' : String(v);
    const valid: ApplicationStatus[] = ['interested', 'applied', 'interviewing', 'offered', 'rejected', 'withdrawn'];
    return valid.includes(s as ApplicationStatus) ? (s as ApplicationStatus) : 'interested';
  }

  // ------------------------------------------------------ 面试逐字稿（N7，AI 留桩）
  /**
   * 面试逐字稿分析（AI 占位）：
   *  · 未配置 AI Key → 返回 configured:false + 明确提示（不假装成功）；
   *  · 已配置 → 预留调用 AI 的入口（当前返回占位说明，待接入真实 prompt）。
   * 逐字稿本身存投递记录 payload.interview.transcript（走既有 PUT /api/tracker/:id）。
   */
  async analyzeInterview(userId: string, trackerId: string, transcript: string) {
    await this.getTracker(userId, trackerId);
    const text = String(transcript || '').trim();
    if (!text) throw new BadRequestException('逐字稿内容不能为空');

    const cfg = await this.t(userId).getAiConfig();
    const row = cfg[0];
    const configured = !!(row && row.baseUrl && row.apiKey);
    if (!configured) {
      return {
        configured: false,
        hint: '尚未配置 AI 模型。请先在「账号与设置 → AI 模型配置」保存 baseUrl、apiKey 与 models.fast，即可对逐字稿做结构化复盘。',
      };
    }
    // 已配置 Key：预留真实 AI 调用（后续接入 prompt 后替换此占位）
    return {
      configured: true,
      analysis: null,
      hint: 'AI 已配置，逐字稿分析能力待接入（本批为框架搭建，AI 调用留待下一期）。',
    };
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
