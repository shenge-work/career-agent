import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, gt, ilike, isNull, notInArray, or, sql } from 'drizzle-orm';
import { DB_TOKEN } from '../../shared/constants';
import type { Database } from '../db/client';
import {
  aiConfigs,
  aiUsage,
  aiUsageEvents,
  applicationEvents,
  applications,
  attachments,
  changeLog,
  companies,
  companyJds,
  conflictSnapshots,
  interviewKb,
  interviewNotes,
  portfolios,
  practiceAnswers,
  practiceEvaluations,
  practiceQuestions,
  practiceSessions,
  practiceWeaknesses,
  referrals,
  resumes,
  settings,
  snippets,
  tracker,
  trackerChatEvents,
  versions,
} from '../db/schema';
import { recordChange, type ChangeInput } from '../sync/change-log';
import { buildRestoreRow, restorableTable, rowToSnapshotJson } from '../sync/restore';

/** 冲突恢复结果（tagged union）：controller 据此映射 404 / 409 / 400，本层不依赖 Nest。 */
export type ConflictRestoreResult =
  | {
      ok: true;
      entity: string;
      entityId: string;
      hlc: string;
      deviceId: string;
      backupSnapshotId: string | null;
      restoredTitle: string | null;
    }
  | {
      ok: false;
      reason: 'not_found' | 'already_resolved' | 'unsupported_entity' | 'invalid_snapshot';
      status?: string;
    };

export type ConflictDismissResult =
  | { ok: true; status: 'dismissed' }
  | { ok: false; reason: 'not_found' | 'already_resolved'; status?: string };

/** 附件写入参数；userId 由 forUser 注入，调用方不可能传别人的 id。 */
export interface AttachmentInsert {
  id: string;
  sha256: string;
  mime: string;
  bytes: number;
  originalName: string;
  ownerType?: string | null;
  ownerId?: string | null;
  syncState?: 'local' | 'pending' | 'synced' | 'remote_only';
  remoteKey?: string | null;
  hlc: string;
  deviceId: string;
}

export interface ResumeInput {
  id: string;
  title: string;
  payload: Record<string, unknown>;
  kind?: 'master' | 'derived' | 'blank';
  parentId?: string | null;
  jobId?: string | null;
  jdText?: string | null;
  tags?: string[];
  isMaster?: boolean;
  savedAt?: number;
}

/** 允许更新的简历字段白名单（与 controller 的 patch 收窄保持一致）。 */
export type ResumePatch = Partial<
  Pick<ResumeInput, 'title' | 'payload' | 'tags' | 'kind' | 'parentId' | 'jobId' | 'jdText'>
>;

/** 岗位/申请（聚合根）状态。 */
export type ApplicationStatus =
  | 'interested'
  | 'applied'
  | 'interviewing'
  | 'offered'
  | 'rejected'
  | 'withdrawn';

export interface ApplicationInput {
  id: string;
  position: string;
  companyId?: string | null;
  jdId?: string | null;
  resumeId?: string | null;
  trackerId?: string | null;
  status?: ApplicationStatus;
  stage?: string | null;
  appliedAt?: Date | null;
  followUpAfterDays?: number | null;
  payload?: Record<string, unknown>;
}

/** 允许更新的岗位字段白名单。 */
export type ApplicationPatch = Partial<
  Pick<
    ApplicationInput,
    | 'position'
    | 'companyId'
    | 'jdId'
    | 'resumeId'
    | 'trackerId'
    | 'status'
    | 'stage'
    | 'appliedAt'
    | 'followUpAfterDays'
    | 'payload'
  >
>;

/** 面试复盘（N12 S2）输入。 */
export interface InterviewNoteInput {
  id: string;
  applicationId?: string | null;
  company?: string | null;
  position?: string | null;
  round?: string | null;
  interviewAt?: Date | null;
  payload?: Record<string, unknown>;
}

/** 面试复盘允许更新的字段白名单。 */
export type InterviewNotePatch = Partial<
  Pick<
    InterviewNoteInput,
    'applicationId' | 'company' | 'position' | 'round' | 'interviewAt' | 'payload'
  >
>;

/** 面经知识库（N12 S2）输入。 */
export interface InterviewKbInput {
  id: string;
  title: string;
  category?: string | null;
  tags?: string[];
  content: string;
}

/** 面经知识库允许更新的字段白名单。 */
export type InterviewKbPatch = Partial<Pick<InterviewKbInput, 'title' | 'category' | 'tags' | 'content'>>;

/** 内推信息输入：公司 + 自由载荷（内推人 / 岗位 / 渠道 / 状态 / 链接 / 跟进日期）。 */
export interface ReferralInput {
  id: string;
  companyId?: string | null;
  payload?: Record<string, unknown>;
}

/** 内推信息允许更新的字段白名单。 */
export type ReferralPatch = Partial<Pick<ReferralInput, 'companyId' | 'payload'>>;

/** N14 · 练习会话状态。 */
export type PracticeSessionStatus = 'configuring' | 'active' | 'paused' | 'completed';

export interface PracticeSessionInput {
  id: string;
  status?: PracticeSessionStatus;
  applicationId?: string | null;
  resumeId?: string | null;
  goal?: Record<string, unknown>;
  currentQuestionOrder?: number;
  usage?: Record<string, unknown>;
  startedAt?: Date | null;
  completedAt?: Date | null;
}

export type PracticeSessionPatch = Partial<
  Pick<
    PracticeSessionInput,
    | 'status'
    | 'applicationId'
    | 'resumeId'
    | 'goal'
    | 'currentQuestionOrder'
    | 'usage'
    | 'startedAt'
    | 'completedAt'
  >
>;

export interface PracticeQuestionInput {
  id: string;
  sessionId: string;
  order?: number;
  questionKey: string;
  question: string;
  type: 'behavioral' | 'project' | 'hr' | 'system_design';
  dimension?: string | null;
  difficulty?: 'standard' | 'easy' | 'hard';
  basis?: Record<string, unknown>;
  maxFollowUps?: number;
  skipped?: boolean;
  regeneratedFrom?: string | null;
  weaknessId?: string | null;
}

export type PracticeQuestionPatch = Partial<
  Pick<
    PracticeQuestionInput,
    | 'sessionId'
    | 'order'
    | 'questionKey'
    | 'question'
    | 'type'
    | 'dimension'
    | 'difficulty'
    | 'basis'
    | 'maxFollowUps'
    | 'skipped'
    | 'regeneratedFrom'
    | 'weaknessId'
  >
>;

export interface PracticeAnswerInput {
  id: string;
  sessionId: string;
  questionId: string;
  turn?: number;
  prompt: string;
  answer?: string;
  isDraft?: boolean;
  wordCount?: number;
  paraCount?: number;
  submittedAt?: Date | null;
}

export type PracticeAnswerPatch = Partial<
  Pick<
    PracticeAnswerInput,
    'sessionId' | 'questionId' | 'turn' | 'prompt' | 'answer' | 'isDraft' | 'wordCount' | 'paraCount' | 'submittedAt'
  >
>;

export interface PracticeEvaluationInput {
  id: string;
  answerId: string;
  questionId: string;
  source?: 'ai' | 'self';
  status?: 'generated' | 'pending_retry' | 'not_generated';
  rubricVersion: string;
  promptVersion: string;
  modelId?: string | null;
  dimensions?: unknown[];
  strengths?: string[];
  actions?: string[];
  sampleAnswer?: string | null;
  summary?: string | null;
  includeInProfile?: boolean;
  calibration?: Record<string, unknown> | null;
}

export type PracticeEvaluationPatch = Partial<
  Pick<
    PracticeEvaluationInput,
    | 'source'
    | 'status'
    | 'rubricVersion'
    | 'promptVersion'
    | 'modelId'
    | 'dimensions'
    | 'strengths'
    | 'actions'
    | 'sampleAnswer'
    | 'summary'
    | 'includeInProfile'
    | 'calibration'
  >
>;

export interface PracticeWeaknessInput {
  id: string;
  source: 'dimension' | 'question' | 'interview_note';
  dimension?: string | null;
  questionId?: string | null;
  interviewNoteId?: string | null;
  reason: string;
  status?: 'pending' | 'practiced' | 'resolved';
  lastPracticeAt?: Date | null;
  lastLevel?: number | null;
}

export type PracticeWeaknessPatch = Partial<
  Pick<
    PracticeWeaknessInput,
    'source' | 'dimension' | 'questionId' | 'interviewNoteId' | 'reason' | 'status' | 'lastPracticeAt' | 'lastLevel'
  >
>;

/** N15 · STAR 经历素材输入。 */
export interface SnippetInput {
  id: string;
  title: string;
  category?: string | null;
  tags?: string[];
  situation?: string | null;
  task?: string | null;
  action?: string | null;
  result?: string | null;
}

/** STAR 经历素材允许更新的字段白名单。 */
export type SnippetPatch = Partial<
  Pick<SnippetInput, 'title' | 'category' | 'tags' | 'situation' | 'task' | 'action' | 'result'>
>;

/**
 * 行级隔离的唯一入口。
 *
 * 设计铁律：这个对象里**没有任何**不带 userId 的查询方法。
 * controller 拿到的只能是 forUser(currentUser.id) 的返回值，
 * 因此「忘了加 where user_id」在结构上就不可能发生。
 * 账号一律平等：不存在任何跨用户视图，也没有管理员角色；UsersService 只提供自助建号。
 *
 * 0011 起，9 张可变实体表一律：读走 active()（自动过滤软删除墓碑）、
 * 删走 softDelete()（UPDATE 设 deleted_at）、创建走 revive()（支持同 id 复活）。
 * hlc / device_id 由数据库 BEFORE 触发器统一填，应用层绝不自己写时钟。
 * versions / application_events / settings / ai_configs 是「只增不删」的流水与单例，
 * 不套 active()，它们的降采样与级联清理仍是物理删除。
 */
@Injectable()
export class TenantDb {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  forUser(userId: string) {
    if (!userId) throw new Error('TenantDb.forUser 必须传入 userId');
    const db = this.db;

    // 这里用 any 承载 drizzle 的 Table 泛型：8 张表的形状不同，但 user_id /
    // deleted_at / id 三列完全一致。隔离仍由 forUser 闭包锁死，调用方无法传 userId。
    const active = (table: any, ...conds: any[]) =>
      and(eq(table.userId, userId), isNull(table.deletedAt), ...conds);

    const softDelete = (table: any, idCol: any, id: string) =>
      db
        .update(table)
        .set({ deletedAt: new Date() })
        .where(active(table, eq(idCol, id)))
        .returning({ id: idCol });

    const softDeleteWhere = (table: any, idCol: any, ...conds: any[]) =>
      db
        .update(table)
        .set({ deletedAt: new Date() })
        .where(active(table, ...conds))
        .returning({ id: idCol });

    /** 同 id 复活：软删除后重建不能撞 (user_id,id)，远端「撤销删除」也走这条路径。 */
    const revive = (table: any, values: any) =>
      db
        .insert(table)
        .values(values)
        .onConflictDoUpdate({
          target: [table.userId, table.id],
          set: { ...values, deletedAt: null },
        })
        .returning();

    return {
      // ---------------------------------------------------------- 简历
      listResumes: () =>
        db.select().from(resumes).where(active(resumes)).orderBy(desc(resumes.savedAt)),

      getResume: (id: string) =>
        db
          .select()
          .from(resumes)
          .where(active(resumes, eq(resumes.id, id)))
          .limit(1),

      createResume: (input: ResumeInput) =>
        revive(resumes, {
          id: input.id,
          userId,
          title: input.title,
          payload: input.payload,
          kind: input.kind || 'master',
          parentId: input.parentId ?? null,
          jobId: input.jobId ?? null,
          jdText: input.jdText ?? null,
          tags: input.tags || [],
          isMaster: input.isMaster ?? false,
          savedAt: input.savedAt ?? Date.now(),
        }),

      updateResume: (id: string, patch: ResumePatch) =>
        db
          .update(resumes)
          .set({ ...patch, updatedAt: new Date(), savedAt: Date.now() })
          .where(active(resumes, eq(resumes.id, id)))
          .returning(),

      deleteResume: (id: string) => softDelete(resumes, resumes.id, id),

      /** 主简历互斥：先确认目标属于本人且未删，再在同一事务里清旧主、设新主。 */
      setMasterResume: (id: string) =>
        db.transaction(async (tx) => {
          const found = await tx
            .select({ id: resumes.id })
            .from(resumes)
            .where(active(resumes, eq(resumes.id, id)))
            .limit(1);
          if (!found.length) return [];
          await tx
            .update(resumes)
            .set({ isMaster: false, updatedAt: new Date() })
            .where(active(resumes, eq(resumes.isMaster, true)));
          return tx
            .update(resumes)
            .set({ isMaster: true, updatedAt: new Date() })
            .where(active(resumes, eq(resumes.id, id)))
            .returning();
        }),

      // ------------------------------------------------------ 版本历史
      // append-only：不套 active()，降采样/级联清理保持物理删除。
      listVersions: (resumeId: string) =>
        db
          .select()
          .from(versions)
          .where(and(eq(versions.userId, userId), eq(versions.resumeId, resumeId)))
          .orderBy(desc(versions.createdAt)),

      addVersion: (v: {
        resumeId: string;
        kind: string;
        label?: string | null;
        snapshot: Record<string, unknown>;
      }) =>
        db
          .insert(versions)
          .values({
            userId,
            resumeId: v.resumeId,
            kind: v.kind,
            label: v.label ?? null,
            snapshot: v.snapshot,
          })
          .returning(),

      /** 版本恢复用：按 (user, resume, version) 精确取一条，别人的快照一律查不到。 */
      getVersionById: (resumeId: string, versionId: string) =>
        db
          .select()
          .from(versions)
          .where(and(eq(versions.userId, userId), eq(versions.resumeId, resumeId), eq(versions.id, versionId)))
          .limit(1),

      /** 版本降采样：删除该简历不在保留集内的版本。keepIds 为空时删除全部。 */
      deleteVersionsNotIn: (resumeId: string, keepIds: string[]) =>
        keepIds.length
          ? db
              .delete(versions)
              .where(and(eq(versions.userId, userId), eq(versions.resumeId, resumeId), notInArray(versions.id, keepIds)))
              .returning({ id: versions.id })
          : db
              .delete(versions)
              .where(and(eq(versions.userId, userId), eq(versions.resumeId, resumeId)))
              .returning({ id: versions.id }),

      deleteVersionsForResume: (resumeId: string) =>
        db
          .delete(versions)
          .where(and(eq(versions.userId, userId), eq(versions.resumeId, resumeId)))
          .returning({ id: versions.id }),

      // -------------------------------------------------------- 公司档案
      listCompanies: () =>
        db.select().from(companies).where(active(companies)).orderBy(desc(companies.updatedAt)),

      getCompany: (id: string) =>
        db
          .select()
          .from(companies)
          .where(active(companies, eq(companies.id, id)))
          .limit(1),

      createCompany: (input: { id: string; name: string; payload: Record<string, unknown> }) =>
        revive(companies, { id: input.id, userId, name: input.name, payload: input.payload }),

      updateCompany: (id: string, patch: { name?: string; payload?: Record<string, unknown> }) =>
        db
          .update(companies)
          .set({ ...patch, updatedAt: new Date() })
          .where(active(companies, eq(companies.id, id)))
          .returning(),

      deleteCompany: (id: string) => softDelete(companies, companies.id, id),

      // ------------------------------------------------------ 公司岗位 JD
      listCompanyJds: (companyId: string) =>
        db
          .select()
          .from(companyJds)
          .where(active(companyJds, eq(companyJds.companyId, companyId))),

      getCompanyJd: (id: string) =>
        db
          .select()
          .from(companyJds)
          .where(active(companyJds, eq(companyJds.id, id)))
          .limit(1),

      createCompanyJd: (input: { id: string; companyId: string; payload: Record<string, unknown> }) =>
        revive(companyJds, { id: input.id, userId, companyId: input.companyId, payload: input.payload }),

      updateCompanyJd: (id: string, payload: Record<string, unknown>) =>
        db
          .update(companyJds)
          // company_jds 没有 updated_at 列（只增不删的轻量记录），改动靠触发器维护 hlc。
          .set({ payload })
          .where(active(companyJds, eq(companyJds.id, id)))
          .returning(),

      deleteCompanyJd: (id: string) => softDelete(companyJds, companyJds.id, id),

      deleteCompanyJdsForCompany: (companyId: string) =>
        softDeleteWhere(companyJds, companyJds.id, eq(companyJds.companyId, companyId)),

      // -------------------------------------------------------- 内推信息
      listReferrals: () =>
        db.select().from(referrals).where(active(referrals)).orderBy(desc(referrals.updatedAt)),

      listReferralsForCompany: (companyId: string) =>
        db
          .select()
          .from(referrals)
          .where(active(referrals, eq(referrals.companyId, companyId)))
          .orderBy(desc(referrals.updatedAt)),

      getReferral: (id: string) =>
        db
          .select()
          .from(referrals)
          .where(active(referrals, eq(referrals.id, id)))
          .limit(1),

      createReferral: (input: { id: string; companyId: string | null; payload: Record<string, unknown> }) =>
        revive(referrals, {
          id: input.id,
          userId,
          companyId: input.companyId,
          payload: input.payload,
        }),

      updateReferral: (id: string, patch: ReferralPatch) =>
        db
          .update(referrals)
          .set({ ...patch, updatedAt: new Date() })
          .where(active(referrals, eq(referrals.id, id)))
          .returning(),

      deleteReferral: (id: string) => softDelete(referrals, referrals.id, id),

      deleteReferralsForCompany: (companyId: string) =>
        softDeleteWhere(referrals, referrals.id, eq(referrals.companyId, companyId)),

      // -------------------------------------------------------- 投递管理
      listTracker: () =>
        db.select().from(tracker).where(active(tracker)).orderBy(desc(tracker.updatedAt)),

      getTracker: (id: string) =>
        db
          .select()
          .from(tracker)
          .where(active(tracker, eq(tracker.id, id)))
          .limit(1),

      createTracker: (input: { id: string; companyId: string | null; payload: Record<string, unknown> }) =>
        revive(tracker, { id: input.id, userId, companyId: input.companyId, payload: input.payload }),

      updateTracker: (id: string, patch: { companyId?: string | null; payload?: Record<string, unknown> }) =>
        db
          .update(tracker)
          .set({ ...patch, updatedAt: new Date() })
          .where(active(tracker, eq(tracker.id, id)))
          .returning(),

      deleteTracker: (id: string) => softDelete(tracker, tracker.id, id),

      // ------------------------------------------------------ 岗位/申请（聚合根）
      listApplications: () =>
        db
          .select()
          .from(applications)
          .where(active(applications))
          .orderBy(desc(applications.updatedAt)),

      getApplication: (id: string) =>
        db
          .select()
          .from(applications)
          .where(active(applications, eq(applications.id, id)))
          .limit(1),

      createApplication: (input: ApplicationInput) =>
        revive(applications, {
          id: input.id,
          userId,
          position: input.position,
          companyId: input.companyId ?? null,
          jdId: input.jdId ?? null,
          resumeId: input.resumeId ?? null,
          trackerId: input.trackerId ?? null,
          status: input.status ?? 'interested',
          stage: input.stage ?? null,
          appliedAt: input.appliedAt ?? null,
          followUpAfterDays: input.followUpAfterDays ?? null,
          payload: input.payload ?? {},
        }),

      updateApplication: (id: string, patch: ApplicationPatch) =>
        db
          .update(applications)
          .set({ ...patch, updatedAt: new Date() })
          .where(active(applications, eq(applications.id, id)))
          .returning(),

      deleteApplication: (id: string) => softDelete(applications, applications.id, id),

      /** 状态流水是 append-only，清理由物理删除完成（不是软删除）。 */
      deleteApplicationEvents: (applicationId: string) =>
        db
          .delete(applicationEvents)
          .where(and(eq(applicationEvents.userId, userId), eq(applicationEvents.applicationId, applicationId)))
          .returning({ id: applicationEvents.id }),

      // ------------------------------------------------------ 个人作品集
      listPortfolios: () =>
        db.select().from(portfolios).where(active(portfolios)).orderBy(desc(portfolios.updatedAt)),

      getPortfolio: (id: string) =>
        db
          .select()
          .from(portfolios)
          .where(active(portfolios, eq(portfolios.id, id)))
          .limit(1),

      createPortfolio: (input: {
        id: string;
        title: string;
        templateId: string;
        layout?: Record<string, unknown>;
        deploy?: Record<string, unknown> | null;
        payload?: Record<string, unknown>;
      }) =>
        revive(portfolios, {
          id: input.id,
          userId,
          title: input.title,
          templateId: input.templateId,
          layout: input.layout ?? {},
          deploy: input.deploy ?? null,
          payload: input.payload ?? {},
        }),

      updatePortfolio: (
        id: string,
        patch: {
          title?: string;
          templateId?: string;
          layout?: Record<string, unknown>;
          deploy?: Record<string, unknown> | null;
          payload?: Record<string, unknown>;
        }
      ) =>
        db
          .update(portfolios)
          .set({ ...patch, updatedAt: new Date() })
          .where(active(portfolios, eq(portfolios.id, id)))
          .returning(),

      deletePortfolio: (id: string) => softDelete(portfolios, portfolios.id, id),

      // ------------------------------------------------------ 岗位状态流水
      listApplicationEvents: (applicationId: string) =>
        db
          .select()
          .from(applicationEvents)
          .where(and(eq(applicationEvents.userId, userId), eq(applicationEvents.applicationId, applicationId)))
          .orderBy(desc(applicationEvents.createdAt)),

      addApplicationEvent: (input: {
        applicationId: string;
        fromStatus: string | null;
        toStatus: string;
        note?: string | null;
      }) =>
        db
          .insert(applicationEvents)
          .values({
            userId,
            applicationId: input.applicationId,
            fromStatus: input.fromStatus ?? null,
            toStatus: input.toStatus,
            note: input.note ?? null,
          })
          .returning(),

      // ------------------------------------------------------ 面试复盘
      listInterviewNotes: (applicationId?: string) =>
        db
          .select()
          .from(interviewNotes)
          .where(active(interviewNotes, ...(applicationId ? [eq(interviewNotes.applicationId, applicationId)] : [])))
          .orderBy(desc(interviewNotes.interviewAt), desc(interviewNotes.updatedAt)),

      getInterviewNote: (id: string) =>
        db
          .select()
          .from(interviewNotes)
          .where(active(interviewNotes, eq(interviewNotes.id, id)))
          .limit(1),

      createInterviewNote: (input: InterviewNoteInput) =>
        revive(interviewNotes, {
          id: input.id,
          userId,
          applicationId: input.applicationId ?? null,
          company: input.company ?? null,
          position: input.position ?? null,
          round: input.round ?? null,
          interviewAt: input.interviewAt ?? null,
          payload: input.payload ?? {},
        }),

      updateInterviewNote: (id: string, patch: InterviewNotePatch) =>
        db
          .update(interviewNotes)
          .set({ ...patch, updatedAt: new Date() })
          .where(active(interviewNotes, eq(interviewNotes.id, id)))
          .returning(),

      deleteInterviewNote: (id: string) => softDelete(interviewNotes, interviewNotes.id, id),

      // ------------------------------------------------------ 面经知识库
      listKb: () =>
        db.select().from(interviewKb).where(active(interviewKb)).orderBy(desc(interviewKb.updatedAt)),

      getKb: (id: string) =>
        db
          .select()
          .from(interviewKb)
          .where(active(interviewKb, eq(interviewKb.id, id)))
          .limit(1),

      createKb: (input: InterviewKbInput) =>
        revive(interviewKb, {
          id: input.id,
          userId,
          title: input.title,
          category: input.category ?? null,
          tags: input.tags ?? [],
          content: input.content,
        }),

      updateKb: (id: string, patch: InterviewKbPatch) =>
        db
          .update(interviewKb)
          .set({ ...patch, updatedAt: new Date() })
          .where(active(interviewKb, eq(interviewKb.id, id)))
          .returning(),

      deleteKb: (id: string) => softDelete(interviewKb, interviewKb.id, id),

      /** 本地检索：把 query 拆成词（按空白/标点），任一词在 title/category/content 命中即返回（OR 语义）。 */
      searchKb: (query: string, limit = 10) => {
        const q = String(query || '').trim();
        const limitN = Math.max(1, Math.min(limit || 10, 50));
        if (!q) {
          return db.select().from(interviewKb).where(active(interviewKb)).orderBy(desc(interviewKb.updatedAt)).limit(limitN);
        }
        // 分词：按空白 + 中文常见分隔符切，过滤掉纯虚词/过短片段。
        const STOP = new Set(['是什么', '怎么', '为什么', '什么', '如何', '怎么样', '哪些', '吗', '呢', '啊', '的', '了', '这个', '那个']);
        const terms = q
          .split(/[\s,，。.!！?？、;；:：()（）【】\[\]"']+/)
          .map((t) => t.trim())
          .filter((t) => t.length >= 2 && !STOP.has(t));
        // 中文连续串补充双字 bigram（覆盖「事件循环是什么」这类整句），
        // 让「循环」「事件」等关键片段也能命中。
        const bigrams = new Set<string>();
        if (/[\u4e00-\u9fa5]/.test(q)) {
          for (let i = 0; i < q.length - 1; i++) {
            const g = q.slice(i, i + 2);
            if (/^[\u4e00-\u9fa5]{2}$/.test(g) && !STOP.has(g)) bigrams.add(g);
          }
        }
        const words = Array.from(new Set([...terms, ...bigrams]));
        // 上限保护：超长 query（如整段 JD / 大段文本）会产生「词数 × 3 列」个
        // `%..%` OR 全表扫描条件，必须截断，否则查询会爆炸式膨胀。
        // 注：中文检索不做 pg_trgm（对双字词几乎无加速）也不做 FTS（PGlite WASM 无 zhparser），
        // 待切真 PG 后引入 zhparser + to_tsvector 才是正解，这里先保证查询规模有界。
        const wordsLimited = words.slice(0, 20);
        const conds = wordsLimited.flatMap((w) => {
          const like = `%${w}%`;
          return [ilike(interviewKb.title, like), ilike(interviewKb.category, like), ilike(interviewKb.content, like)];
        });
        return db
          .select()
          .from(interviewKb)
          .where(active(interviewKb, or(...conds)))
          .orderBy(desc(interviewKb.updatedAt))
          .limit(limitN);
      },

      // ------------------------------------------------------ 练习会话
      listPracticeSessions: () =>
        db
          .select()
          .from(practiceSessions)
          .where(active(practiceSessions))
          .orderBy(desc(practiceSessions.updatedAt)),

      getPracticeSession: (id: string) =>
        db
          .select()
          .from(practiceSessions)
          .where(active(practiceSessions, eq(practiceSessions.id, id)))
          .limit(1),

      createPracticeSession: (input: PracticeSessionInput) =>
        revive(practiceSessions, {
          id: input.id,
          userId,
          status: input.status || 'configuring',
          applicationId: input.applicationId ?? null,
          resumeId: input.resumeId ?? null,
          goal: input.goal ?? {},
          currentQuestionOrder: input.currentQuestionOrder ?? 0,
          usage: input.usage ?? {},
          startedAt: input.startedAt ?? null,
          completedAt: input.completedAt ?? null,
        }),

      updatePracticeSession: (id: string, patch: PracticeSessionPatch) =>
        db
          .update(practiceSessions)
          .set({ ...patch, updatedAt: new Date() })
          .where(active(practiceSessions, eq(practiceSessions.id, id)))
          .returning(),

      deletePracticeSession: (id: string) => softDelete(practiceSessions, practiceSessions.id, id),

      // ------------------------------------------------------ 练习题目
      listPracticeQuestions: (sessionId: string) =>
        db
          .select()
          .from(practiceQuestions)
          .where(active(practiceQuestions, eq(practiceQuestions.sessionId, sessionId)))
          .orderBy(asc(practiceQuestions.order)),

      listPracticeQuestionsByKey: (questionKey: string) =>
        db
          .select()
          .from(practiceQuestions)
          .where(active(practiceQuestions, eq(practiceQuestions.questionKey, questionKey)))
          .orderBy(asc(practiceQuestions.createdAt)),

      listAllPracticeQuestions: () =>
        db
          .select()
          .from(practiceQuestions)
          .where(active(practiceQuestions))
          .orderBy(asc(practiceQuestions.createdAt)),

      getPracticeQuestion: (id: string) =>
        db
          .select()
          .from(practiceQuestions)
          .where(active(practiceQuestions, eq(practiceQuestions.id, id)))
          .limit(1),

      createPracticeQuestion: (input: PracticeQuestionInput) =>
        revive(practiceQuestions, {
          id: input.id,
          userId,
          sessionId: input.sessionId,
          order: input.order ?? 0,
          questionKey: input.questionKey,
          question: input.question,
          type: input.type,
          dimension: input.dimension ?? null,
          difficulty: input.difficulty ?? 'standard',
          basis: input.basis ?? {},
          maxFollowUps: input.maxFollowUps ?? 2,
          skipped: input.skipped ?? false,
          regeneratedFrom: input.regeneratedFrom ?? null,
          weaknessId: input.weaknessId ?? null,
        }),

      updatePracticeQuestion: (id: string, patch: PracticeQuestionPatch) =>
        db
          .update(practiceQuestions)
          .set({ ...patch, updatedAt: new Date() })
          .where(active(practiceQuestions, eq(practiceQuestions.id, id)))
          .returning(),

      deletePracticeQuestion: (id: string) => softDelete(practiceQuestions, practiceQuestions.id, id),

      // ------------------------------------------------------ 练习回答
      listPracticeAnswers: (questionId: string) =>
        db
          .select()
          .from(practiceAnswers)
          .where(active(practiceAnswers, eq(practiceAnswers.questionId, questionId)))
          .orderBy(asc(practiceAnswers.turn)),

      listPracticeAnswersForSession: (sessionId: string) =>
        db
          .select()
          .from(practiceAnswers)
          .where(active(practiceAnswers, eq(practiceAnswers.sessionId, sessionId)))
          .orderBy(asc(practiceAnswers.turn)),

      getPracticeAnswer: (id: string) =>
        db
          .select()
          .from(practiceAnswers)
          .where(active(practiceAnswers, eq(practiceAnswers.id, id)))
          .limit(1),

      createPracticeAnswer: (input: PracticeAnswerInput) =>
        revive(practiceAnswers, {
          id: input.id,
          userId,
          sessionId: input.sessionId,
          questionId: input.questionId,
          turn: input.turn ?? 0,
          prompt: input.prompt,
          answer: input.answer ?? '',
          isDraft: input.isDraft ?? true,
          wordCount: input.wordCount ?? 0,
          paraCount: input.paraCount ?? 0,
          submittedAt: input.submittedAt ?? null,
        }),

      updatePracticeAnswer: (id: string, patch: PracticeAnswerPatch) =>
        db
          .update(practiceAnswers)
          .set({ ...patch, updatedAt: new Date() })
          .where(active(practiceAnswers, eq(practiceAnswers.id, id)))
          .returning(),

      deletePracticeAnswer: (id: string) => softDelete(practiceAnswers, practiceAnswers.id, id),

      // ------------------------------------------------------ 练习评分
      listPracticeEvaluations: (answerId: string) =>
        db
          .select()
          .from(practiceEvaluations)
          .where(active(practiceEvaluations, eq(practiceEvaluations.answerId, answerId)))
          .orderBy(asc(practiceEvaluations.createdAt)),

      listAllPracticeEvaluations: () =>
        db
          .select()
          .from(practiceEvaluations)
          .where(active(practiceEvaluations))
          .orderBy(asc(practiceEvaluations.createdAt)),

      getPracticeEvaluation: (id: string) =>
        db
          .select()
          .from(practiceEvaluations)
          .where(active(practiceEvaluations, eq(practiceEvaluations.id, id)))
          .limit(1),

      createPracticeEvaluation: (input: PracticeEvaluationInput) =>
        revive(practiceEvaluations, {
          id: input.id,
          userId,
          answerId: input.answerId,
          questionId: input.questionId,
          source: input.source ?? 'ai',
          status: input.status ?? 'generated',
          rubricVersion: input.rubricVersion,
          promptVersion: input.promptVersion,
          modelId: input.modelId ?? null,
          dimensions: input.dimensions ?? [],
          strengths: input.strengths ?? [],
          actions: input.actions ?? [],
          sampleAnswer: input.sampleAnswer ?? null,
          summary: input.summary ?? null,
          includeInProfile: input.includeInProfile ?? false,
          calibration: input.calibration ?? null,
        }),

      updatePracticeEvaluation: (id: string, patch: PracticeEvaluationPatch) =>
        db
          .update(practiceEvaluations)
          .set({ ...patch, updatedAt: new Date() })
          .where(active(practiceEvaluations, eq(practiceEvaluations.id, id)))
          .returning(),

      deletePracticeEvaluation: (id: string) => softDelete(practiceEvaluations, practiceEvaluations.id, id),

      // ------------------------------------------------------ 练习弱项
      listPracticeWeaknesses: () =>
        db
          .select()
          .from(practiceWeaknesses)
          .where(active(practiceWeaknesses))
          .orderBy(asc(practiceWeaknesses.status), desc(practiceWeaknesses.updatedAt)),

      getPracticeWeakness: (id: string) =>
        db
          .select()
          .from(practiceWeaknesses)
          .where(active(practiceWeaknesses, eq(practiceWeaknesses.id, id)))
          .limit(1),

      createPracticeWeakness: (input: PracticeWeaknessInput) =>
        revive(practiceWeaknesses, {
          id: input.id,
          userId,
          source: input.source,
          dimension: input.dimension ?? null,
          questionId: input.questionId ?? null,
          interviewNoteId: input.interviewNoteId ?? null,
          reason: input.reason,
          status: input.status ?? 'pending',
          lastPracticeAt: input.lastPracticeAt ?? null,
          lastLevel: input.lastLevel ?? null,
        }),

      updatePracticeWeakness: (id: string, patch: PracticeWeaknessPatch) =>
        db
          .update(practiceWeaknesses)
          .set({ ...patch, updatedAt: new Date() })
          .where(active(practiceWeaknesses, eq(practiceWeaknesses.id, id)))
          .returning(),

      deletePracticeWeakness: (id: string) => softDelete(practiceWeaknesses, practiceWeaknesses.id, id),

      // ------------------------------------------------------ STAR 经历素材
      listSnippets: () =>
        db.select().from(snippets).where(active(snippets)).orderBy(desc(snippets.updatedAt)),

      getSnippet: (id: string) =>
        db
          .select()
          .from(snippets)
          .where(active(snippets, eq(snippets.id, id)))
          .limit(1),

      createSnippet: (input: SnippetInput) =>
        revive(snippets, {
          id: input.id,
          userId,
          title: input.title,
          category: input.category ?? null,
          tags: input.tags ?? [],
          situation: input.situation ?? null,
          task: input.task ?? null,
          action: input.action ?? null,
          result: input.result ?? null,
        }),

      updateSnippet: (id: string, patch: SnippetPatch) =>
        db
          .update(snippets)
          .set({ ...patch, updatedAt: new Date() })
          .where(active(snippets, eq(snippets.id, id)))
          .returning(),

      deleteSnippet: (id: string) => softDelete(snippets, snippets.id, id),

      // ------------------------------------------------------------ 设置
      getSettings: () =>
        db.select().from(settings).where(eq(settings.userId, userId)).limit(1),

      /** jsonb 合并：只覆盖传入的键，不碰用户在别处写入的设置。 */
      mergeSettings: (patch: Record<string, unknown>) => {
        const json = JSON.stringify(patch);
        return db
          .insert(settings)
          .values({ userId, payload: patch })
          .onConflictDoUpdate({
            target: settings.userId,
            set: {
              payload: sql`${settings.payload} || ${json}::jsonb`,
              updatedAt: new Date(),
            },
          })
          .returning();
      },

      // ---------------------------------------------------------- 冲突地基（0011）
      /** 跨设备冲突留底：按实体查落败方快照，可用于人工恢复被 LWW 覆盖的编辑。 */
      /** 0012 · 冲突快照列表：支持状态筛选；全是本地审计数据，不进同步流。 */
      listConflictSnapshots: (
        filter: { entity?: string; entityId?: string; status?: string } = {}
      ) =>
        db
          .select()
          .from(conflictSnapshots)
          .where(
            and(
              eq(conflictSnapshots.userId, userId),
              ...(filter.entity ? [eq(conflictSnapshots.entity, filter.entity)] : []),
              ...(filter.entityId ? [eq(conflictSnapshots.entityId, filter.entityId)] : []),
              ...(filter.status
                ? [eq(conflictSnapshots.status, filter.status as 'pending' | 'restored' | 'dismissed')]
                : [])
            )
          )
          .orderBy(desc(conflictSnapshots.createdAt))
          .limit(200),

      getConflictSnapshot: (id: string) =>
        db
          .select()
          .from(conflictSnapshots)
          .where(and(eq(conflictSnapshots.userId, userId), eq(conflictSnapshots.id, id)))
          .limit(1),

      /**
       * 0012 · 人工恢复落败方版本。
       *
       * 关键语义：恢复 = 一次全新的本地写，不是把旧 HLC / device_id 抄回去。
       * 事务内依次完成：取当前行（含墓碑）→ 用快照的业务列写回（触发器领新 HLC、
       * 归因本机、写 change_log）→ 把刚被换下的当前版本留成一条 pending 快照 →
       * 原快照标记 restored。于是「恢复」本身可同步、可再撤销，任何一版都不丢。
       */
      restoreConflictSnapshot: (id: string): Promise<ConflictRestoreResult> =>
        db.transaction(async (tx): Promise<ConflictRestoreResult> => {
          const [snap] = await tx
            .select()
            .from(conflictSnapshots)
            .where(and(eq(conflictSnapshots.userId, userId), eq(conflictSnapshots.id, id)))
            .limit(1);
          if (!snap) return { ok: false, reason: 'not_found' };
          if (snap.status !== 'pending') {
            return { ok: false, reason: 'already_resolved', status: snap.status };
          }
          const table = restorableTable(snap.entity);
          if (!table) return { ok: false, reason: 'unsupported_entity' };
          const row = buildRestoreRow(snap.entity, snap.snapshot, userId, snap.entityId);
          if (!row) return { ok: false, reason: 'invalid_snapshot' };

          // 墓碑也要能取到：恢复软删记录属于「撤销删除」。
          const [current] = await tx
            .select()
            .from(table)
            .where(and(eq(table.userId, userId), eq(table.id, snap.entityId)))
            .limit(1);

          // table 是反射得到的 any，drizzle 的返回类型会退化成数组 | Results；运行时就是行数组。
          const restored = (await tx
            .insert(table)
            .values(row as any)
            .onConflictDoUpdate({ target: [table.userId, table.id], set: row as any })
            .returning()) as unknown as any[];
          if (!restored.length) return { ok: false, reason: 'invalid_snapshot' };
          const fresh = restored[0] as Record<string, any>;

          let backupSnapshotId: string | null = null;
          if (current) {
            const [backup] = await tx
              .insert(conflictSnapshots)
              .values({
                userId,
                entity: snap.entity,
                entityId: snap.entityId,
                resolution: 'restore',
                winnerHlc: String(fresh.hlc),
                loserHlc: String((current as any).hlc || ''),
                loserDeviceId: String((current as any).deviceId || 'local'),
                snapshot: rowToSnapshotJson(snap.entity, current as Record<string, unknown>),
                status: 'pending',
                restoredFrom: snap.id,
              })
              .returning({ id: conflictSnapshots.id });
            backupSnapshotId = backup?.id ?? null;
          }

          await tx
            .update(conflictSnapshots)
            .set({ status: 'restored', resolvedAt: new Date() })
            .where(and(eq(conflictSnapshots.userId, userId), eq(conflictSnapshots.id, id)));

          return {
            ok: true,
            entity: snap.entity,
            entityId: snap.entityId,
            hlc: String(fresh.hlc),
            deviceId: String(fresh.deviceId),
            backupSnapshotId,
            restoredTitle: typeof fresh.title === 'string' ? fresh.title : null,
          };
        }),

      /** 忽略一条快照：只改状态，原文永久保留，随时可在筛选里翻出来。 */
      dismissConflictSnapshot: (id: string): Promise<ConflictDismissResult> =>
        db.transaction(async (tx): Promise<ConflictDismissResult> => {
          const [snap] = await tx
            .select()
            .from(conflictSnapshots)
            .where(and(eq(conflictSnapshots.userId, userId), eq(conflictSnapshots.id, id)))
            .limit(1);
          if (!snap) return { ok: false, reason: 'not_found' };
          if (snap.status !== 'pending') {
            return { ok: false, reason: 'already_resolved', status: snap.status };
          }
          await tx
            .update(conflictSnapshots)
            .set({ status: 'dismissed', resolvedAt: new Date() })
            .where(and(eq(conflictSnapshots.userId, userId), eq(conflictSnapshots.id, id)));
          return { ok: true, status: 'dismissed' };
        }),

      /** chat append-only 事实源：按 (user, tracker) 取全部事件，供将来合并聊天记录。 */
      listTrackerChatEvents: (trackerId: string) =>
        db
          .select()
          .from(trackerChatEvents)
          .where(and(eq(trackerChatEvents.userId, userId), eq(trackerChatEvents.trackerId, trackerId)))
          .orderBy(asc(trackerChatEvents.createdAt)),

      // ------------------------------------------------ 附件（local-first + 同步 outbox）
      listAttachments: (filter: { ownerType?: string; ownerId?: string } = {}) =>
        db
          .select()
          .from(attachments)
          .where(
            and(
              eq(attachments.userId, userId),
              isNull(attachments.deletedAt),
              ...(filter.ownerType ? [eq(attachments.ownerType, filter.ownerType)] : []),
              ...(filter.ownerId ? [eq(attachments.ownerId, filter.ownerId)] : [])
            )
          )
          .orderBy(desc(attachments.createdAt)),

      getAttachment: (id: string) =>
        db
          .select()
          .from(attachments)
          .where(
            and(
              eq(attachments.userId, userId),
              eq(attachments.id, id),
              isNull(attachments.deletedAt)
            )
          )
          .limit(1),

      /** 行 + outbox 同事务：任何一次本地写都能被云端按 hlc 增量拉走。 */
      insertAttachmentWithChange: (row: AttachmentInsert, change: ChangeInput) =>
        db.transaction(async (tx) => {
          const rows = await tx.insert(attachments).values({ userId, ...row }).returning();
          await recordChange(tx, { ...change, userId, entity: 'attachments', entityId: row.id });
          return rows;
        }),

      /** 软删除墓碑 + outbox：删除必须同步，否则另一台设备会「僵尸复活」。 */
      softDeleteAttachmentWithChange: (id: string, change: ChangeInput) =>
        db.transaction(async (tx) => {
          const rows = await tx
            .update(attachments)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(
              and(
                eq(attachments.userId, userId),
                eq(attachments.id, id),
                isNull(attachments.deletedAt)
              )
            )
            .returning();
          if (!rows.length) return [];
          await recordChange(tx, {
            ...change,
            userId,
            entity: 'attachments',
            entityId: id,
            op: 'delete',
          });
          return rows;
        }),

      /**
       * 同步增量：按 hlc 字典序拉游标之后的变更（含 delete 墓碑）。
       * 游标由 0010 的 DB 触发器统一生成，严格单调，故同一毫秒多条写不会漏。
       * 覆盖附件 + 全部业务表；user_id 由 forUser 锁定，跨用户不可见。
       */
      listChangesSince: (since: string, limit = 500) =>
        db
          .select()
          .from(changeLog)
          .where(and(eq(changeLog.userId, userId), gt(changeLog.hlc, since)))
          .orderBy(asc(changeLog.hlc))
          .limit(Math.min(Math.max(1, limit), 1000)),

      // ---------------------------------------------------------- AI 配置
      // 与所有业务表一致：这里没有任何不带 userId 的查询方法，apiKey 只在本层可见。
      // P0-6 起支持多厂商并存：一个账号多行 (user_id, provider)，is_active 标记生效厂商。
      getAiConfigs: () =>
        db.select().from(aiConfigs).where(eq(aiConfigs.userId, userId)),

      getActiveAiConfig: () =>
        db
          .select()
          .from(aiConfigs)
          .where(and(eq(aiConfigs.userId, userId), eq(aiConfigs.isActive, true)))
          .limit(1),

      // 向后兼容旧调用（business.service.analyzeInterview）：语义收窄为「当前生效配置」。
      getAiConfig: () =>
        db
          .select()
          .from(aiConfigs)
          .where(and(eq(aiConfigs.userId, userId), eq(aiConfigs.isActive, true)))
          .limit(1),

      upsertAiConfig: (input: {
        provider: string;
        baseUrl: string;
        apiKey: string;
        models: Record<string, string>;
        temperature: number;
        timeoutMs: number;
        isActive?: boolean;
      }) =>
        db
          .insert(aiConfigs)
          .values({ userId, ...input })
          .onConflictDoUpdate({
            target: [aiConfigs.userId, aiConfigs.provider],
            set: { ...input, updatedAt: new Date() },
          })
          .returning(),

      /** 单事务内先清空该账号的生效标记，再把目标厂商置为生效（保证唯一索引不冲突）。 */
      setActiveProvider: (provider: string) =>
        db.transaction(async (tx) => {
          await tx
            .update(aiConfigs)
            .set({ isActive: false })
            .where(eq(aiConfigs.userId, userId));
          await tx
            .update(aiConfigs)
            .set({ isActive: true })
            .where(and(eq(aiConfigs.userId, userId), eq(aiConfigs.provider, provider)));
        }),

      deleteAiConfig: (provider: string) =>
        db
          .delete(aiConfigs)
          .where(and(eq(aiConfigs.userId, userId), eq(aiConfigs.provider, provider))),

      listAiUsage: () =>
        db.select().from(aiUsage).where(eq(aiUsage.userId, userId)).orderBy(desc(aiUsage.day)),

      /**
       * 按 (user_id, 本地日期) 累计：失败请求也计入 requests，另累计 errors。
       * 新增维度字段只在 on conflict 时覆盖为「最近一次调用」的最新值（与 last_model 一致）。
       * 隐私铁律：只落元数据，绝不落 prompt 与响应正文。
       */
      bumpAiUsage: (opts: {
        action?: string | null;
        model?: string | null;
        provider?: string | null;
        status?: 'ok' | 'error' | null;
        errorCode?: string | null;
        latencyMs?: number | null;
        tokens?: { promptTokens?: number | null; completionTokens?: number | null } | null;
      }) => {
        const day = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD（本地时区）
        const err = opts.status === 'error' ? 1 : 0;
        const meta = {
          lastAt: new Date(),
          lastModel: opts.model ?? null,
          provider: opts.provider ?? null,
          action: opts.action ?? null,
          status: opts.status ?? null,
          errorCode: opts.errorCode ?? null,
          latencyMs: opts.latencyMs ?? null,
          promptTokens: opts.tokens?.promptTokens ?? null,
          completionTokens: opts.tokens?.completionTokens ?? null,
        };
        return db
          .insert(aiUsage)
          .values({
            userId,
            day,
            requests: 1,
            errors: err,
            ...meta,
          })
          .onConflictDoUpdate({
            target: [aiUsage.userId, aiUsage.day],
            set: {
              requests: sql`${aiUsage.requests} + 1`,
              errors: sql`${aiUsage.errors} + ${err}`,
              ...meta,
            },
          })
          .returning();
      },

      /**
       * 0020 · 每次 AI 调用追加一条明细（append-only，永不更新），供厂商/模型对账。
       * 与 bumpAiUsage 并行调用：后者供趋势图，本方法供对账明细。隐私铁律：只落元数据。
       */
      insertAiUsageEvent: (opts: {
        provider?: string | null;
        model?: string | null;
        action?: string | null;
        status?: 'ok' | 'error' | null;
        errorCode?: string | null;
        latencyMs?: number | null;
        tokens?: { promptTokens?: number | null; completionTokens?: number | null } | null;
      }) =>
        db.insert(aiUsageEvents).values({
          userId,
          provider: opts.provider ?? null,
          model: opts.model ?? null,
          action: opts.action ?? null,
          status: opts.status ?? null,
          errorCode: opts.errorCode ?? null,
          latencyMs: opts.latencyMs ?? null,
          promptTokens: opts.tokens?.promptTokens ?? null,
          completionTokens: opts.tokens?.completionTokens ?? null,
        }),

      /**
       * 0020 · 按时间范围读明细，供 /api/ai/usage 对账。返回倒序明细行（最新在前）。
       * since 为可选的时间下界（含），不传则全量；limit 可选，用于明细流水列表。
       */
      listAiUsageEvents: (since?: Date | null, limit?: number) => {
        const conds = [eq(aiUsageEvents.userId, userId)];
        if (since) conds.push(gte(aiUsageEvents.createdAt, since));
        const base = db
          .select()
          .from(aiUsageEvents)
          .where(and(...conds))
          .orderBy(desc(aiUsageEvents.createdAt));
        return limit && limit > 0 ? base.limit(limit) : base;
      },
    };
  }
}
