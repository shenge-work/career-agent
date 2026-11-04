import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ilike, notInArray, or, sql } from 'drizzle-orm';
import { DB_TOKEN } from '../../shared/constants';
import type { Database } from '../db/client';
import {
  aiConfigs,
  aiUsage,
  applicationEvents,
  applications,
  companies,
  companyJds,
  interviewKb,
  interviewNotes,
  portfolios,
  resumes,
  settings,
  tracker,
  versions,
} from '../db/schema';

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

/**
 * 行级隔离的唯一入口。
 *
 * 设计铁律：这个对象里**没有任何**不带 userId 的查询方法。
 * controller 拿到的只能是 forUser(currentUser.id) 的返回值，
 * 因此「忘了加 where user_id」在结构上就不可能发生。
 * 需要跨用户视图时（管理员），必须走单独的 UsersService 并经 RolesGuard('admin')。
 */
@Injectable()
export class TenantDb {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  forUser(userId: string) {
    if (!userId) throw new Error('TenantDb.forUser 必须传入 userId');
    const db = this.db;

    return {
      // ---------------------------------------------------------- 简历
      listResumes: () =>
        db.select().from(resumes).where(eq(resumes.userId, userId)).orderBy(desc(resumes.savedAt)),

      getResume: (id: string) =>
        db
          .select()
          .from(resumes)
          .where(and(eq(resumes.userId, userId), eq(resumes.id, id)))
          .limit(1),

      createResume: (input: ResumeInput) =>
        db
          .insert(resumes)
          .values({
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
          })
          .returning(),

      updateResume: (id: string, patch: ResumePatch) =>
        db
          .update(resumes)
          .set({ ...patch, updatedAt: new Date(), savedAt: Date.now() })
          .where(and(eq(resumes.userId, userId), eq(resumes.id, id)))
          .returning(),

      deleteResume: (id: string) =>
        db
          .delete(resumes)
          .where(and(eq(resumes.userId, userId), eq(resumes.id, id)))
          .returning({ id: resumes.id }),

      /** 主简历互斥：先确认目标属于本人，再在同一事务里清旧主、设新主。 */
      setMasterResume: (id: string) =>
        db.transaction(async (tx) => {
          const found = await tx
            .select({ id: resumes.id })
            .from(resumes)
            .where(and(eq(resumes.userId, userId), eq(resumes.id, id)))
            .limit(1);
          if (!found.length) return [];
          await tx
            .update(resumes)
            .set({ isMaster: false, updatedAt: new Date() })
            .where(and(eq(resumes.userId, userId), eq(resumes.isMaster, true)));
          return tx
            .update(resumes)
            .set({ isMaster: true, updatedAt: new Date() })
            .where(and(eq(resumes.userId, userId), eq(resumes.id, id)))
            .returning();
        }),

      // ------------------------------------------------------ 版本历史
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
        db.select().from(companies).where(eq(companies.userId, userId)).orderBy(desc(companies.updatedAt)),

      getCompany: (id: string) =>
        db
          .select()
          .from(companies)
          .where(and(eq(companies.userId, userId), eq(companies.id, id)))
          .limit(1),

      createCompany: (input: { id: string; name: string; payload: Record<string, unknown> }) =>
        db
          .insert(companies)
          .values({ id: input.id, userId, name: input.name, payload: input.payload })
          .returning(),

      updateCompany: (id: string, patch: { name?: string; payload?: Record<string, unknown> }) =>
        db
          .update(companies)
          .set({ ...patch, updatedAt: new Date() })
          .where(and(eq(companies.userId, userId), eq(companies.id, id)))
          .returning(),

      deleteCompany: (id: string) =>
        db
          .delete(companies)
          .where(and(eq(companies.userId, userId), eq(companies.id, id)))
          .returning({ id: companies.id }),

      // ------------------------------------------------------ 公司岗位 JD
      listCompanyJds: (companyId: string) =>
        db
          .select()
          .from(companyJds)
          .where(and(eq(companyJds.userId, userId), eq(companyJds.companyId, companyId))),

      getCompanyJd: (id: string) =>
        db
          .select()
          .from(companyJds)
          .where(and(eq(companyJds.userId, userId), eq(companyJds.id, id)))
          .limit(1),

      createCompanyJd: (input: { id: string; companyId: string; payload: Record<string, unknown> }) =>
        db
          .insert(companyJds)
          .values({ id: input.id, userId, companyId: input.companyId, payload: input.payload })
          .returning(),

      deleteCompanyJd: (id: string) =>
        db
          .delete(companyJds)
          .where(and(eq(companyJds.userId, userId), eq(companyJds.id, id)))
          .returning({ id: companyJds.id }),

      deleteCompanyJdsForCompany: (companyId: string) =>
        db
          .delete(companyJds)
          .where(and(eq(companyJds.userId, userId), eq(companyJds.companyId, companyId)))
          .returning({ id: companyJds.id }),

      // -------------------------------------------------------- 投递管理
      listTracker: () =>
        db.select().from(tracker).where(eq(tracker.userId, userId)).orderBy(desc(tracker.updatedAt)),

      getTracker: (id: string) =>
        db
          .select()
          .from(tracker)
          .where(and(eq(tracker.userId, userId), eq(tracker.id, id)))
          .limit(1),

      createTracker: (input: { id: string; companyId: string | null; payload: Record<string, unknown> }) =>
        db
          .insert(tracker)
          .values({ id: input.id, userId, companyId: input.companyId, payload: input.payload })
          .returning(),

      updateTracker: (id: string, patch: { companyId?: string | null; payload?: Record<string, unknown> }) =>
        db
          .update(tracker)
          .set({ ...patch, updatedAt: new Date() })
          .where(and(eq(tracker.userId, userId), eq(tracker.id, id)))
          .returning(),

      deleteTracker: (id: string) =>
        db
          .delete(tracker)
          .where(and(eq(tracker.userId, userId), eq(tracker.id, id)))
          .returning({ id: tracker.id }),

      // ------------------------------------------------------ 岗位/申请（聚合根）
      listApplications: () =>
        db
          .select()
          .from(applications)
          .where(eq(applications.userId, userId))
          .orderBy(desc(applications.updatedAt)),

      getApplication: (id: string) =>
        db
          .select()
          .from(applications)
          .where(and(eq(applications.userId, userId), eq(applications.id, id)))
          .limit(1),

      createApplication: (input: ApplicationInput) =>
        db
          .insert(applications)
          .values({
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
          })
          .returning(),

      updateApplication: (id: string, patch: ApplicationPatch) =>
        db
          .update(applications)
          .set({ ...patch, updatedAt: new Date() })
          .where(and(eq(applications.userId, userId), eq(applications.id, id)))
          .returning(),

      deleteApplication: (id: string) =>
        db
          .delete(applications)
          .where(and(eq(applications.userId, userId), eq(applications.id, id)))
          .returning({ id: applications.id }),

      /** 删除岗位时连带清空其状态流水（聚合根级联，跨用户仍由 user_id 兜底隔离）。 */
      deleteApplicationEvents: (applicationId: string) =>
        db
          .delete(applicationEvents)
          .where(and(eq(applicationEvents.userId, userId), eq(applicationEvents.applicationId, applicationId)))
          .returning({ id: applicationEvents.id }),

      // ------------------------------------------------------ 个人作品集
      listPortfolios: () =>
        db.select().from(portfolios).where(eq(portfolios.userId, userId)).orderBy(desc(portfolios.updatedAt)),

      getPortfolio: (id: string) =>
        db
          .select()
          .from(portfolios)
          .where(and(eq(portfolios.userId, userId), eq(portfolios.id, id)))
          .limit(1),

      createPortfolio: (input: {
        id: string;
        title: string;
        templateId: string;
        layout?: Record<string, unknown>;
        deploy?: Record<string, unknown> | null;
        payload?: Record<string, unknown>;
      }) =>
        db
          .insert(portfolios)
          .values({
            id: input.id,
            userId,
            title: input.title,
            templateId: input.templateId,
            layout: input.layout ?? {},
            deploy: input.deploy ?? null,
            payload: input.payload ?? {},
          })
          .returning(),

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
          .where(and(eq(portfolios.userId, userId), eq(portfolios.id, id)))
          .returning(),

      deletePortfolio: (id: string) =>
        db
          .delete(portfolios)
          .where(and(eq(portfolios.userId, userId), eq(portfolios.id, id)))
          .returning({ id: portfolios.id }),

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
          .where(
            applicationId
              ? and(eq(interviewNotes.userId, userId), eq(interviewNotes.applicationId, applicationId))
              : eq(interviewNotes.userId, userId)
          )
          .orderBy(desc(interviewNotes.interviewAt), desc(interviewNotes.updatedAt)),

      getInterviewNote: (id: string) =>
        db
          .select()
          .from(interviewNotes)
          .where(and(eq(interviewNotes.userId, userId), eq(interviewNotes.id, id)))
          .limit(1),

      createInterviewNote: (input: InterviewNoteInput) =>
        db
          .insert(interviewNotes)
          .values({
            id: input.id,
            userId,
            applicationId: input.applicationId ?? null,
            company: input.company ?? null,
            position: input.position ?? null,
            round: input.round ?? null,
            interviewAt: input.interviewAt ?? null,
            payload: input.payload ?? {},
          })
          .returning(),

      updateInterviewNote: (id: string, patch: InterviewNotePatch) =>
        db
          .update(interviewNotes)
          .set({ ...patch, updatedAt: new Date() })
          .where(and(eq(interviewNotes.userId, userId), eq(interviewNotes.id, id)))
          .returning(),

      deleteInterviewNote: (id: string) =>
        db
          .delete(interviewNotes)
          .where(and(eq(interviewNotes.userId, userId), eq(interviewNotes.id, id)))
          .returning({ id: interviewNotes.id }),

      // ------------------------------------------------------ 面经知识库
      listKb: () => db.select().from(interviewKb).where(eq(interviewKb.userId, userId)).orderBy(desc(interviewKb.updatedAt)),

      getKb: (id: string) =>
        db
          .select()
          .from(interviewKb)
          .where(and(eq(interviewKb.userId, userId), eq(interviewKb.id, id)))
          .limit(1),

      createKb: (input: InterviewKbInput) =>
        db
          .insert(interviewKb)
          .values({
            id: input.id,
            userId,
            title: input.title,
            category: input.category ?? null,
            tags: input.tags ?? [],
            content: input.content,
          })
          .returning(),

      updateKb: (id: string, patch: InterviewKbPatch) =>
        db
          .update(interviewKb)
          .set({ ...patch, updatedAt: new Date() })
          .where(and(eq(interviewKb.userId, userId), eq(interviewKb.id, id)))
          .returning(),

      deleteKb: (id: string) =>
        db
          .delete(interviewKb)
          .where(and(eq(interviewKb.userId, userId), eq(interviewKb.id, id)))
          .returning({ id: interviewKb.id }),

      /** 本地检索：把 query 拆成词（按空白/标点），任一词在 title/category/content 命中即返回（OR 语义）。 */
      searchKb: (query: string, limit = 10) => {
        const q = String(query || '').trim();
        const limitN = Math.max(1, Math.min(limit || 10, 50));
        if (!q) {
          return db.select().from(interviewKb).where(eq(interviewKb.userId, userId)).orderBy(desc(interviewKb.updatedAt)).limit(limitN);
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
        const conds = words.flatMap((w) => {
          const like = `%${w}%`;
          return [ilike(interviewKb.title, like), ilike(interviewKb.category, like), ilike(interviewKb.content, like)];
        });
        return db
          .select()
          .from(interviewKb)
          .where(and(eq(interviewKb.userId, userId), or(...conds)))
          .orderBy(desc(interviewKb.updatedAt))
          .limit(limitN);
      },

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

      // ---------------------------------------------------------- AI 配置
      // 与所有业务表一致：这里没有任何不带 userId 的查询方法，apiKey 只在本层可见。
      getAiConfig: () =>
        db.select().from(aiConfigs).where(eq(aiConfigs.userId, userId)).limit(1),

      upsertAiConfig: (input: {
        provider: string;
        baseUrl: string;
        apiKey: string;
        models: Record<string, string>;
        temperature: number;
        timeoutMs: number;
      }) =>
        db
          .insert(aiConfigs)
          .values({ userId, ...input })
          .onConflictDoUpdate({
            target: aiConfigs.userId,
            set: { ...input, updatedAt: new Date() },
          })
          .returning(),

      listAiUsage: () =>
        db.select().from(aiUsage).where(eq(aiUsage.userId, userId)).orderBy(desc(aiUsage.day)),

      /** 按 (user_id, 本地日期) 累计；失败请求也计入 requests，另累计 errors。 */
      bumpAiUsage: (opts: { error?: boolean; model?: string | null }) => {
        const day = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD（本地时区）
        const err = opts.error ? 1 : 0;
        return db
          .insert(aiUsage)
          .values({
            userId,
            day,
            requests: 1,
            errors: err,
            lastAt: new Date(),
            lastModel: opts.model ?? null,
          })
          .onConflictDoUpdate({
            target: [aiUsage.userId, aiUsage.day],
            set: {
              requests: sql`${aiUsage.requests} + 1`,
              errors: sql`${aiUsage.errors} + ${err}`,
              lastAt: new Date(),
              lastModel: opts.model ?? null,
            },
          })
          .returning();
      },
    };
  }
}
