import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DB_TOKEN } from '../../shared/constants';
import type { Database } from '../db/client';
import {
  aiConfigs,
  aiUsage,
  companies,
  companyJds,
  resumes,
  settings,
  syncConfigs,
  syncOauth,
  syncState,
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

      // -------------------------------------------------- 飞书同步（P2b 二期）
      // 凭证 / 状态全部按账号隔离；appSecret / accessToken 只在本层可见，绝不回传。

      getSyncConfig: () =>
        db.select().from(syncConfigs).where(eq(syncConfigs.userId, userId)).limit(1),

      /** upsert 应用身份配置；patch 为已归一化的全量列值。 */
      upsertSyncConfig: (patch: {
        appId: string;
        appSecret: string;
        domain: string;
        folderToken: string;
        docTitle: string;
        fileName: string;
        fileUploadMode: string;
        dryRun: boolean;
      }) =>
        db
          .insert(syncConfigs)
          .values({ userId, ...patch })
          .onConflictDoUpdate({
            target: syncConfigs.userId,
            set: { ...patch, updatedAt: new Date() },
          })
          .returning(),

      /** 只更新个别列（probe 回填 folder_token / 默认项时用），不改 appSecret。 */
      patchSyncConfig: (patch: Partial<{
        appId: string;
        domain: string;
        folderToken: string;
        docTitle: string;
        fileName: string;
        fileUploadMode: string;
        dryRun: boolean;
      }>) =>
        db
          .update(syncConfigs)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(syncConfigs.userId, userId))
          .returning(),

      deleteSyncConfig: () =>
        db.delete(syncConfigs).where(eq(syncConfigs.userId, userId)).returning({ userId: syncConfigs.userId }),

      getSyncOauth: () =>
        db.select().from(syncOauth).where(eq(syncOauth.userId, userId)).limit(1),

      upsertSyncOauth: (patch: {
        accessToken: string;
        refreshToken: string;
        expiresAt: number;
        refreshExpiresAt: number;
        scope: string;
      }) =>
        db
          .insert(syncOauth)
          .values({ userId, ...patch, updatedAt: Date.now() })
          .onConflictDoUpdate({
            target: syncOauth.userId,
            set: { ...patch, updatedAt: Date.now() },
          })
          .returning(),

      deleteSyncOauth: () =>
        db.delete(syncOauth).where(eq(syncOauth.userId, userId)).returning({ userId: syncOauth.userId }),

      getSyncState: (resumeId: string) =>
        db
          .select()
          .from(syncState)
          .where(and(eq(syncState.userId, userId), eq(syncState.resumeId, resumeId)))
          .limit(1),

      /** upsert 简历的飞书锚点；app 与 user 身份各写各的列，互不串写。 */
      upsertSyncState: (resumeId: string, patch: { documentId?: string; fileToken?: string; userDocumentId?: string; userFileToken?: string }) =>
        db
          .insert(syncState)
          .values({ userId, resumeId, ...patch })
          .onConflictDoUpdate({
            target: [syncState.userId, syncState.resumeId],
            set: { ...patch, updatedAt: new Date() },
          })
          .returning(),
    };
  }
}
