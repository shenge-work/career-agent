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

/**
 * P2b 第二期 · 飞书「应用身份」配置（按账号隔离）。
 * app_secret 只留在服务端数据库，任何 GET 接口都不回传明文（只给 hasSecret）。
 * 未配置时只读回退 v1 的 sync.config.json；一旦保存过本账号配置即以 DB 为准。
 */
export const syncConfigs = pgTable('sync_configs', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  appId: text('app_id').notNull().default(''),
  appSecret: text('app_secret').notNull().default(''),
  domain: text('domain').notNull().default(''),
  folderToken: text('folder_token').notNull().default(''),
  docTitle: text('doc_title').notNull().default(''),
  fileName: text('file_name').notNull().default(''),
  fileUploadMode: text('file_upload_mode').notNull().default('versioned'),
  dryRun: boolean('dry_run').notNull().default(false),
  updatedAt: updatedAt(),
});

/** 扫码授权（OAuth 授权码模式）的用户身份凭证；有效期沿用 v1 的毫秒时间戳语义。 */
export const syncOauth = pgTable('sync_oauth', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token').notNull().default(''),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  refreshExpiresAt: bigint('refresh_expires_at', { mode: 'number' }).notNull().default(0),
  scope: text('scope').notNull().default(''),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  createdAt: createdAt(),
});

/** 每份简历 × 认证模式的飞书锚点（docx 文档 / 云盘文件 token），分列即 v1 的分键隔离。 */
export const syncState = pgTable(
  'sync_state',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    resumeId: text('resume_id').notNull(),
    documentId: text('document_id').notNull().default(''),
    fileToken: text('file_token').notNull().default(''),
    userDocumentId: text('user_document_id').notNull().default(''),
    userFileToken: text('user_file_token').notNull().default(''),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.resumeId] })]
);

export const schema = {
  users,
  sessions,
  resumes,
  versions,
  companies,
  companyJds,
  tracker,
  shareGrants,
  settings,
  aiConfigs,
  aiUsage,
  syncConfigs,
  syncOauth,
  syncState,
};

export type UserRow = typeof users.$inferSelect;
export type ResumeRow = typeof resumes.$inferSelect;
