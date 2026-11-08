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
 * DDL 与 drizzle/*.sql 一一对应，改这里必须同步改迁移文件。
 *
 * 0011 起每张业务表都带同步三元组（hlc / device_id / deleted_at），由数据库
 * BEFORE 触发器统一维护，应用层不要自己写这三列：
 *   · hlc        跨设备 HLC 因果时钟，LWW 冲突判定的唯一依据；
 *   · device_id  写来源设备，同一设备的重复回灌不算并发冲突；
 *   · deleted_at 软删除墓碑，null = 活跃行；读查询必须经 TenantDb 的 active() 过滤。
 * savedAt / updatedAt 是本机墙钟，只用于 UI 展示与排序，绝不参与冲突判定。
 */
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/** 每次返回全新的 column builder，避免多表共用同一个实例造成 drizzle 状态串味。 */
const syncCols = () => ({
  hlc: text('hlc').notNull().default(''),
  deviceId: text('device_id').notNull().default('local'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

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
    ...syncCols(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index('resumes_user_idx').on(t.userId),
    index('resumes_user_saved_idx').on(t.userId, t.savedAt),
  ]
);

/**
 * N11 本地版本历史：快照不含 savedAt，按用户 + 简历隔离。
 * 流式/不可变表：deleted_at 恒为 null，降采样仍走物理删除（见 0011 注释）。
 */
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
    ...syncCols(),
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
    ...syncCols(),
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
    ...syncCols(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index('company_jds_user_company_idx').on(t.userId, t.companyId),
  ]
);

/**
 * 内推信息（Referral）—— 统一的内推资源池。
 *
 * 一条 referral = 一次可用的内推机会：谁内推（referrer）、哪家公司（companyId）、
 * 哪个岗位（payload.position）、走什么渠道（payload.channel）、当前进展（payload.status）、
 * 下一步什么时候跟进（payload.followUpAt）。
 *
 * company_id 与 company_jds 一样不加外键：companies 的主键是 (user_id, id) 复合键，
 * 且公司被删时内推信息是独立资产（内推人还在、岗位链接还有效），只做软删除级联。
 * 细节字段全部落 payload，避免为内推规则频繁改 schema。
 */
export const referrals = pgTable(
  'referrals',
  {
    id: text('id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 关联公司档案；可为空（还没建档，或内推人本身挂着多个岗位）。 */
    companyId: text('company_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ...syncCols(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index('referrals_user_idx').on(t.userId),
    index('referrals_user_company_idx').on(t.userId, t.companyId),
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
    ...syncCols(),
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
    ...syncCols(),
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
 * append-only：deleted_at 恒为 null，级联清理走物理删除。
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
    ...syncCols(),
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
    ...syncCols(),
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
    ...syncCols(),
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
    ...syncCols(),
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

/**
 * 本地附件（local-first 文件存储的元数据侧）。
 *
 * 字节不进 PG：落在 <dataRoot>/blobs/sha256/<前2>/<后62>，这里只存不可变的内容指纹与归属。
 * 这样 DBeaver 能查到完整附件清单，云端同步时 object key 直接复用 sha256，零映射。
 *
 * 可同步设计：
 *   · hlc / device_id：HLC 逻辑时钟（字典序即因果序），替代会漂移的墙钟做 last-write-wins；
 *   · sync_state / remote_key：本地优先 → 云端托管的迁移落点，先只写不读，接云时无需洗表；
 *   · deleted_at：软删除墓碑，保证「A 设备删除」能同步出去，不会在 B 设备上僵尸复活。
 *   附件走应用层 recordChange 记账，不挂 0011 的业务表触发器（避免两处时钟互相覆盖）。
 */
export const attachments = pgTable(
  'attachments',
  {
    id: text('id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 内容指纹，同时是本地 blob 路径与未来云端 object key。 */
    sha256: text('sha256').notNull(),
    /** 由 magic number 判定，绝不采信客户端声明的 content-type。 */
    mime: text('mime').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    /** 仅用于展示，永不参与拼路径。 */
    originalName: text('original_name').notNull(),
    /** 归属聚合根（resume / application / company / interview 等），可为空。 */
    ownerType: text('owner_type'),
    ownerId: text('owner_id'),
    /** local 本地新增 / pending 待上传 / synced 已上云 / remote_only 本地未缓存。 */
    syncState: text('sync_state', {
      enum: ['local', 'pending', 'synced', 'remote_only'],
    })
      .notNull()
      .default('local'),
    /** 云端 object key；本地阶段为 null，接云后通常等于 sha256。 */
    remoteKey: text('remote_key'),
    hlc: text('hlc').notNull(),
    deviceId: text('device_id').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index('attachments_user_sha_idx').on(t.userId, t.sha256),
    index('attachments_user_hlc_idx').on(t.userId, t.hlc),
    index('attachments_user_owner_idx').on(t.userId, t.ownerType, t.ownerId),
  ]
);

/**
 * 变更日志（同步 outbox）：所有本地写操作按 user 记一条增量，云端按 hlc 游标拉取。
 *
 * 写入路径：附件模块用 sync/change-log.ts 的 recordChange 同事务记账；其余业务表
 * 由 drizzle/0010 + 0011 的触发器自动记账（软删除/物理删除都写 delete 墓碑）。
 * hlc 由 ca_change_log_cursor 触发器统一改写为本地严格单调的拉取游标；
 * 跨设备冲突判定请用业务行自己的 hlc，不要把本地游标当全局时钟。
 * 回灌期间（app.sync_import='on'）change_log 写入会被吞掉，防止云端变更被推回去成环。
 * 注意：这不是 pgDump / WAL 物理复制 —— PGlite 的 pgdata 无法被原生 PG 打开。
 */
export const changeLog = pgTable(
  'change_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 表名 / 聚合根名，如 attachments、resumes。 */
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    op: text('op', { enum: ['upsert', 'delete'] }).notNull(),
    hlc: text('hlc').notNull(),
    deviceId: text('device_id').notNull(),
    /** 增量载荷：轻量信号；软删除带 deleted_at，chat 事件带消息本体。 */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index('change_log_user_hlc_idx').on(t.userId, t.hlc)]
);

/**
 * 0011 · 跨设备冲突快照：LWW 判定后把「落败方整行」留底，绝不静默丢改动。
 * 独立于 versions（那是用户手动版本历史），覆盖简历以外的全部实体。
 * 回灌时由 ca_business_row_guard 自动写入，敏感列已被 ca_safe_row_json 剔除。
 *
 * 0012 · 增加处理状态：pending → restored / dismissed。人工恢复时还会插入一条
 * resolution='restore' 的 pending 快照，保存「被替换掉的当前版本」，因此恢复可来回切换。
 * 这张表是纯本地审计数据，不进 change_log、不参与云端同步。
 */
export const conflictSnapshots = pgTable(
  'conflict_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    /** remote_wins=远端覆盖本地；local_wins=本地胜出；restore=人工恢复时被换下的当前版本。 */
    resolution: text('resolution', { enum: ['remote_wins', 'local_wins', 'restore'] }).notNull(),
    winnerHlc: text('winner_hlc').notNull(),
    loserHlc: text('loser_hlc').notNull(),
    loserDeviceId: text('loser_device_id').notNull(),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    status: text('status', { enum: ['pending', 'restored', 'dismissed'] })
      .notNull()
      .default('pending'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** 由哪条快照的恢复操作产生（仅 resolution='restore' 的留底行有值）。 */
    restoredFrom: uuid('restored_from'),
    createdAt: createdAt(),
  },
  (t) => [
    index('conflict_snapshots_user_entity_idx').on(t.userId, t.entity, t.entityId, t.createdAt),
    index('conflict_snapshots_user_status_idx').on(t.userId, t.status, t.createdAt),
  ]
);

/**
 * 0011 · tracker.payload.chat[] 的 append-only 投影。
 * 前端与 BOSS 采集器仍写整块 jsonb，触发器按 (user, tracker, role+text+ts) 幂等
 * 追加每条消息；将来合并两台设备的聊天记录按 dedupe_key 取并集，而不是整块 LWW。
 */
export const trackerChatEvents = pgTable(
  'tracker_chat_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    trackerId: text('tracker_id').notNull(),
    dedupeKey: text('dedupe_key').notNull().unique(),
    message: jsonb('message').$type<Record<string, unknown>>().notNull(),
    hlc: text('hlc').notNull(),
    deviceId: text('device_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('tracker_chat_events_user_tracker_idx').on(t.userId, t.trackerId, t.createdAt)]
);

export const settings = pgTable('settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  updatedAt: updatedAt(),
  ...syncCols(),
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
  ...syncCols(),
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
 * 0013 · 同步状态（local-first 的本地游标与 E2EE 密钥柜）。
 *
 * 云端是哑管道、只认 seq；本地必须自己记三样东西：
 *   · pushedCursor —— change_log.hlc 拉取游标，'' = 尚未做过基线全量首传；
 *   · pulledSeq     —— 云端已消费的 seq，断点续传只认它；
 *   · keysJson      —— 派生的 E2EE 密钥（base64）只存本机，恢复码本身不落库。
 * 同机重启后靠 keysJson 直接恢复密钥；另一台设备加入仍需手抄恢复码（scrypt 单向，无法反推）。
 * knownBlobs 是「已知云端 blob key」集合，供云端 GC 比对引用集（内容寻址，只增不删）。
 */
export const syncState = pgTable('sync_state', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  vaultId: text('vault_id').notNull(),
  deviceId: text('device_id').notNull(),
  /** 本地增量拉取游标（change_log.hlc）；空串 = 需做基线全量首传。 */
  pushedCursor: text('pushed_cursor').notNull().default(''),
  /** 云端已消费 seq；断点续传游标，不参与冲突判定。 */
  pulledSeq: text('pulled_seq').notNull().default('00000000000000000000'),
  /** E2EE 派生密钥（base64），仅存本机；{ vaultId, salt, authKey, encKey, macKey }。 */
  keysJson: jsonb('keys_json').$type<Record<string, string>>().notNull(),
  /** idle | syncing | error | disabled。 */
  status: text('status', { enum: ['idle', 'syncing', 'error', 'disabled'] })
    .notNull()
    .default('idle'),
  lastError: text('last_error'),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  /** 已知云端 blob key（内容寻址），云端 GC 比对引用集时用。 */
  knownBlobs: jsonb('known_blobs').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  updatedAt: updatedAt(),
});

export const schema = {
  users,
  sessions,
  resumes,
  versions,
  companies,
  companyJds,
  referrals,
  tracker,
  applications,
  applicationEvents,
  portfolios,
  interviewNotes,
  interviewKb,
  shareGrants,
  attachments,
  changeLog,
  conflictSnapshots,
  trackerChatEvents,
  settings,
  aiConfigs,
  aiUsage,
  syncState,
};

export type UserRow = typeof users.$inferSelect;
export type ResumeRow = typeof resumes.$inferSelect;
export type CompanyRow = typeof companies.$inferSelect;
export type ReferralRow = typeof referrals.$inferSelect;
export type ApplicationRow = typeof applications.$inferSelect;
export type PortfolioRow = typeof portfolios.$inferSelect;
export type InterviewNoteRow = typeof interviewNotes.$inferSelect;
export type InterviewKbRow = typeof interviewKb.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
export type ChangeLogRow = typeof changeLog.$inferSelect;
export type ConflictSnapshotRow = typeof conflictSnapshots.$inferSelect;
export type TrackerChatEventRow = typeof trackerChatEvents.$inferSelect;
