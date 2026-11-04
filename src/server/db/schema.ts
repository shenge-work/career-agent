import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * 所有业务表都带 user_id —— 这是行级数据隔离的物理基础。
 * 查询一律经 TenantDb.forUser(userId)，禁止在 controller 里手写 where。
 * DDL 与 drizzle/0000_init.sql 一一对应，改这里必须同步改迁移文件。
 */

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name'),
  role: text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
  status: text('status', { enum: ['active', 'disabled'] }).notNull().default('active'),
  createdAt: createdAt(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
});

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_token_idx').on(t.tokenHash)]
);

export const resumes = pgTable(
  'resumes',
  {
    // v1 数据的 id 由客户端生成，跨用户必然可能重复 —— 主键必须是 (user_id, id)。
    id: text('id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    kind: text('kind', { enum: ['master', 'derived', 'blank'] }).notNull().default('master'),
    parentId: text('parent_id'),
    jobId: text('job_id'),
    jdText: text('jd_text'),
    tags: jsonb('tags').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    isMaster: boolean('is_master').notNull().default(false),
    /** 完整简历载荷，原样承载旧版 data.sections 结构，避免 P0 阶段丢字段。 */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    savedAt: bigint('saved_at', { mode: 'number' }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index('resumes_user_idx').on(t.userId),
    index('resumes_user_saved_idx').on(t.userId, t.savedAt),
  ]
);

/** N11 本地版本历史：快照不含 savedAt，按用户 + 简历隔离。 */
export const versions = pgTable(
  'versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    resumeId: text('resume_id').notNull(),
    kind: text('kind').notNull(),
    label: text('label'),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('versions_user_resume_idx').on(t.userId, t.resumeId)]
);

/** 公司档案：只存公司本身信息，applied 作为隐藏关联标记留在 payload 里。 */
export const companies = pgTable(
  'companies',
  {
    id: text('id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index('companies_user_idx').on(t.userId),
  ]
);

export const companyJds = pgTable(
  'company_jds',
  {
    id: text('id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    companyId: text('company_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index('company_jds_user_company_idx').on(t.userId, t.companyId),
  ]
);

export const tracker = pgTable(
  'tracker',
  {
    id: text('id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    companyId: text('company_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index('tracker_user_idx').on(t.userId),
  ]
);

/**
 * 岗位/申请（Application）——「个人求职 Agent 工作台」的第一公民聚合根。
 *
 * 一个 application = 一次求职的完整旅程：JD + 公司 + 定制简历 + 投递状态 + 面试阶段。
 * 把原先散落在 resumes.parentId/jobId、tracker.companyId/payload.status 的血缘收拢到一处，
 * 让「投了多少 / 卡在哪 / 下一步」这类工作台问题有单一数据源可聚合。
 *
 * tracker 保留为 BOSS 聊天采集 + IM 事实源（见 tracker 注释），通过 tracker_id 关联，
 * 不破坏现有 collect 采集链路；状态变更走 application_events 流水。
 */
export const applications = pgTable(
  'applications',
  {
    id: text('id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 岗位名（如「高级前端工程师」），派生简历 title 的历史落点。 */
    position: text('position').notNull(),
    companyId: text('company_id'),
    jdId: text('jd_id'),
    /** 本次投递采用的简历（多为派生版）；可为空（尚未定制）。 */
    resumeId: text('resume_id'),
    /** 关联的投递记录（BOSS 聊天采集的事实源），可为空。 */
    trackerId: text('tracker_id'),
    /** 投递状态：interested 意向 / applied 已投 / interviewing 面试中 / offered 已录用 / rejected 已拒 / withdrawn 已撤回。 */
    status: text('status', {
      enum: ['interested', 'applied', 'interviewing', 'offered', 'rejected', 'withdrawn'],
    })
      .notNull()
      .default('interested'),
    /** 面试阶段（interviewing 时的细分），非结构化、按需写入。 */
    stage: text('stage'),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    /** 跟进提醒：投递后多久该跟进（天数），空 = 不提醒。 */
    followUpAfterDays: integer('follow_up_after_days'),
    /** 扩展载荷：JD 文本快照 / 求职信 / 面试材料 / 备注，避免频繁改 schema。 */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index('applications_user_status_idx').on(t.userId, t.status),
    index('applications_user_company_idx').on(t.userId, t.companyId),
  ]
);

/**
 * 岗位状态流水：每次 status/stage 变更追加一条，作为「求职旅程时间线」的事实源。
 * tracker 历史状态在迁移时回填为 events（见 drizzle/0005_applications.sql）。
 */
export const applicationEvents = pgTable(
  'application_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    applicationId: text('application_id').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [index('app_events_user_app_idx').on(t.userId, t.applicationId)]
);

/**
 * N13 · 个人作品集站点（Portfolio）——「作品集官网」的聚合根。
 *
 * 一次配置，可反复生成静态站 / 反复发布到 GitHub Pages。
 * 内容独立维护（不复用简历数据，用户明确要求），布局与模板解耦：
 *   - templateId 引用代码内置模板库（src/server/portfolio/templates/），不落库；
 *   - layout 承载板块顺序/显隐/自定义板块；
 *   - payload 承载作品集专属内容（简介/项目/kpi/联系方式等）；
 *   - deploy 承载发布配置（目标仓库/分支/最近发布时间/公网 URL）。
 */
export const portfolios = pgTable(
  'portfolios',
  {
    id: text('id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /** 当前模板 id（模板定义在代码内置模板库，这里只存引用）。 */
    templateId: text('template_id').notNull(),
    /** 布局配置：板块顺序/显隐/自定义板块。 */
    layout: jsonb('layout').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** 发布配置：目标仓库/分支/最近发布时间/公网 URL。 */
    deploy: jsonb('deploy').$type<Record<string, unknown> | null>(),
    /** 作品集专属内容：简介/项目/kpi/联系方式等。 */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index('portfolios_user_idx').on(t.userId),
  ]
);

/**
 * N12 S2 · 面试复盘（InterviewNote）——「求职旅程」里面试环节的事实沉淀。
 *
 * 一次面试 = 一轮复盘：挂了哪个岗位（applicationId）、面到哪一轮（round）、
 * 问了什么问题、自己答得如何、哪些要改进、下次怎么答。挂 applications 聚合根，
 * 让「岗位 → 面试 → 复盘 → 改进」有单一血缘。ai 复盘结果写入 payload.aiReview。
 */
export const interviewNotes = pgTable(
  'interview_notes',
  {
    id: text('id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 关联岗位；可为空（独立面试记录）。 */
    applicationId: text('application_id'),
    /** 公司名快照（方便面经库跨岗位检索，不强制关联 company 表）。 */
    company: text('company'),
    /** 岗位名快照。 */
    position: text('position'),
    /** 面试轮次（一面/二面/HR 面/终面 等，自由文本）。 */
    round: text('round'),
    /** 面试时间。 */
    interviewAt: timestamp('interview_at', { withTimezone: true }),
    /** 复盘正文：问题/回答/反思/改进点，自由结构。 */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index('interview_notes_user_app_idx').on(t.userId, t.applicationId),
  ]
);

/**
 * N12 S2 · 面经知识库（InterviewKb）——「RAG 知识沉淀」的落点。
 *
 * 沉淀面经/面试题/通用技巧，供「kb-ask」动作做本地检索（关键词 + 全文），
 * 让大模型只引用用户自己的知识库回答，不编造外部信息。
 */
export const interviewKb = pgTable(
  'interview_kb',
  {
    id: text('id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /** 分类（技术面/行为面/HR 面/公司面经/通用技巧 等，自由文本）。 */
    category: text('category'),
    /** 标签，用于检索加权。 */
    tags: jsonb('tags').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** 正文内容（富文本/纯文本）。 */
    content: text('content').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index('interview_kb_user_cat_idx').on(t.userId, t.category),
  ]
);

/** N3 分享授权：有账号后 shareToken 才有「可吊销 / 可过期 / 只读」的落点。 */
export const shareGrants = pgTable(
  'share_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    resumeId: text('resume_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    permission: text('permission', { enum: ['read'] }).notNull().default('read'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('share_grants_user_idx').on(t.userId)]
);

export const settings = pgTable('settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  updatedAt: updatedAt(),
});

/**
 * P2b · AI 模型配置（按账号隔离）。
 * api_key 只留在服务端数据库里，任何 GET 接口都不回传明文（只给 hasApiKey）。
 * 未配置时服务会只读回退到 v1 的 ai.config.json，方便老用户零配置过渡。
 */
export const aiConfigs = pgTable('ai_configs', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull().default('openai-compatible'),
  baseUrl: text('base_url').notNull(),
  apiKey: text('api_key').notNull().default(''),
  models: jsonb('models').$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
  temperature: real('temperature').notNull().default(0.4),
  timeoutMs: integer('timeout_ms').notNull().default(60000),
  updatedAt: updatedAt(),
});

/** P2b · AI 用量按账号 + 自然日累计（内测需要知道谁在用、用了多少次）。 */
export const aiUsage = pgTable(
  'ai_usage',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    day: text('day').notNull(),
    requests: integer('requests').notNull().default(0),
    errors: integer('errors').notNull().default(0),
    lastAt: timestamp('last_at', { withTimezone: true }),
    lastModel: text('last_model'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })]
);

export const schema = {
  users,
  sessions,
  resumes,
  versions,
  companies,
  companyJds,
  tracker,
  applications,
  applicationEvents,
  portfolios,
  interviewNotes,
  interviewKb,
  shareGrants,
  settings,
  aiConfigs,
  aiUsage,
};

export type UserRow = typeof users.$inferSelect;
export type ResumeRow = typeof resumes.$inferSelect;
export type ApplicationRow = typeof applications.$inferSelect;
export type PortfolioRow = typeof portfolios.$inferSelect;
export type InterviewNoteRow = typeof interviewNotes.$inferSelect;
export type InterviewKbRow = typeof interviewKb.$inferSelect;
