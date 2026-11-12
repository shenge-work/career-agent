import type { CurrentUser } from '../shared/constants';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface Me {
  user: CurrentUser;
}

export interface ResumeItem {
  id: string;
  title: string;
  kind: string;
  isMaster: boolean;
  tags: string[] | null;
  parentId: string | null;
  jobId: string | null;
  jdText: string | null;
  payload: Record<string, any>;
  savedAt: number;
  updatedAt: string;
  createdAt: string;
}

export interface CompanyItem {
  id: string;
  name: string;
  payload: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface JdItem {
  id: string;
  companyId: string;
  payload: Record<string, any>;
  createdAt: string;
}

/** 内推信息：公司关联 + 自由 payload（内推人/岗位/渠道/状态/链接/跟进日期）。 */
export interface ReferralItem {
  id: string;
  companyId: string | null;
  payload: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface TrackerItem {
  id: string;
  companyId: string | null;
  payload: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationItem {
  id: string;
  position: string;
  companyId: string | null;
  jdId: string | null;
  resumeId: string | null;
  trackerId: string | null;
  status: 'interested' | 'applied' | 'interviewing' | 'offered' | 'rejected' | 'withdrawn';
  stage: string | null;
  appliedAt: string | null;
  followUpAfterDays: number | null;
  payload: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationEvent {
  id: string;
  applicationId: string;
  fromStatus: string | null;
  toStatus: string;
  note: string | null;
  createdAt: string;
}

export interface VersionItem {
  id: string;
  resumeId: string;
  kind: string;
  label: string | null;
  snapshot: Record<string, any>;
  createdAt: string;
}

export interface PortfolioItem {
  id: string;
  title: string;
  templateId: string;
  layout: Record<string, any>;
  deploy: Record<string, any> | null;
  payload: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface PortfolioTemplateMeta {
  id: string;
  name: string;
  description: string;
}

export interface PortfolioDeployResult {
  id: string;
  repo: string;
  branch: string;
  commit: string;
  url: string;
  publishedAt: number;
}

/** 本地附件：字节落内容寻址 blob 目录，PG 只存元数据（local-first，可同步）。 */
export interface AttachmentItem {
  id: string;
  userId: string;
  sha256: string;
  mime: string;
  bytes: number;
  originalName: string;
  ownerType: string | null;
  ownerId: string | null;
  syncState: 'local' | 'pending' | 'synced' | 'remote_only';
  remoteKey: string | null;
  hlc: string;
  deviceId: string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 同步 outbox 的一条增量，按 hlc 字典序游标拉取。 */
export interface ChangeEntry {
  id: string;
  userId: string;
  entity: string;
  entityId: string;
  op: 'upsert' | 'delete';
  hlc: string;
  deviceId: string;
  payload: Record<string, any>;
  createdAt: string;
}

export interface ChangesResponse {
  changes: ChangeEntry[];
  nextCursor: string;
}

/**
 * 0011/0012 · 跨设备冲突留底：LWW 判定后落败方的整行原文。
 * 纯本地审计数据，不进 change_log、不参与云端同步。
 * resolution=restore 表示「人工恢复时被换下的当前版本」，仍可再次恢复，来回切换不丢改动。
 */
export interface ConflictSnapshot {
  id: string;
  userId: string;
  entity: string;
  entityId: string;
  resolution: 'remote_wins' | 'local_wins' | 'restore';
  status: 'pending' | 'restored' | 'dismissed';
  winnerHlc: string;
  loserHlc: string;
  loserDeviceId: string;
  snapshot: Record<string, any>;
  restoredFrom: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

/** 恢复结果：这是一次新的本地写，带回服务端重新领取的 HLC 与当前版本留底 id。 */
export interface ConflictRestoreResult {
  ok: true;
  entity: string;
  entityId: string;
  hlc: string;
  deviceId: string;
  backupSnapshotId: string | null;
  restoredTitle: string | null;
}

/** 云同步（Sync Engine）一轮同步的统计。 */
export interface SyncRunStats {
  pulled: number;
  applied: number;
  rejected: number;
  skipped: number;
  pushed: number;
  baseline: boolean;
  blobsUploaded: number;
  blobsDownloaded: number;
  localBlobsGc: number;
  cloudBlobsGc: number;
  pulledSeq: string;
  pushedCursor: string;
  headSeq: string;
}

/** GET /api/sync/status。 */
export interface SyncCloudStatus {
  enabled: boolean;
  vaultId?: string;
  deviceId?: string;
  status?: 'idle' | 'syncing' | 'error' | 'disabled';
  lastError?: string | null;
  lastSyncAt?: string | null;
  pushedCursor?: string;
  pulledSeq?: string;
  baseUrl?: string;
}

/** POST /api/sync/enable 响应；recoveryCode 只回显这一次。 */
export interface SyncEnableResult {
  mode: 'created' | 'joined';
  recoveryCode: string;
  stats: SyncRunStats;
}

export const getSyncStatus = () => api<SyncCloudStatus>('/sync/status');
export const enableSync = (recoveryCode: string) =>
  post<SyncEnableResult>('/sync/enable', { recoveryCode });
export const runSync = () => post<SyncRunStats>('/sync/run');
export const disableSync = () => post<{ ok: true }>('/sync/disable');

export const restoreConflict = (id: string) =>
  post<ConflictRestoreResult>(`/sync/conflicts/${encodeURIComponent(id)}/restore`);

export const dismissConflict = (id: string) =>
  del<{ ok: true; status: 'dismissed' }>(`/sync/conflicts/${encodeURIComponent(id)}`);

export interface UserRow {
  id: string;
  email: string;
  displayName: string | null;
  role: 'admin' | 'member';
  status: 'active' | 'disabled';
  createdAt: string;
  lastLoginAt: string | null;
}

export interface SettingsResponse {
  payload: Record<string, any>;
}

export interface AiStatus {
  configured: boolean;
  hasApiKey: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  models: Record<string, string>;
  temperature: number;
  timeoutMs: number;
  source: string;
  nodeVersion: string;
  hint: string;
  usage: {
    requests: number;
    errors: number;
    todayRequests: number;
    lastAt: string | null;
    lastModel: string | null;
    days: Array<{ day: string; requests: number; errors: number }>;
  };
}

export interface CollectStatus {
  scriptAvailable: boolean;
  defaultPort: number;
  hint: string;
}

export interface CollectResult {
  ok: boolean;
  added: number;
  total: number;
  hint: string;
  title?: string;
  url?: string;
  company?: string;
}

/** N12 · JD 结构化解析结果（大模型抽取，规则层降级）。 */
export interface ParsedJd {
  position: string;
  company: string;
  summary: string;
  requirements: string[];
  preferred: string[];
  keywords: string[];
}

/** N12 · /api/agent/parse-jd 响应。 */
export interface JdParseResult {
  jdText: string;
  parsed: ParsedJd;
  aiUsed: boolean;
  model: string | null;
  degraded: boolean;
  rule: {
    keywords: string[];
    termCount: number;
    match: JdMatchResult | null;
  };
}

/** 投递体检：/api/resumes/:id/audit 响应（三级规则检查报告）。 */
export interface AuditItem {
  key: string;
  title: string;
  level: 'ok' | 'warn' | 'fail';
  message: string;
  detail?: string[];
}

export interface AuditReport {
  checkedAt: number;
  score: number;
  items: AuditItem[];
  summary: { ok: number; warn: number; fail: number };
}

/** 投递体检：传 draftPayload 可体检未保存的草稿，缺省用已保存内容。 */
export const auditResume = (id: string, draftPayload?: unknown) =>
  post<AuditReport>(`/resumes/${encodeURIComponent(id)}/audit`, { ...(draftPayload != null ? { payload: draftPayload } : {}) });

/** N12 · 规则层匹配分析（与 jd.service.ts 的 analyze 同构）。 */
export interface JdMatchResult {
  stats: { total: number; covered: number; weak: number; missing: number; score: number };
  groups: {
    covered: Array<{ term: string; hits: number; bonus: boolean; jdCount: number; inSections: string[] }>;
    weak: Array<{ term: string; hits: number; bonus: boolean; jdCount: number; inSections: string[] }>;
    missing: Array<{ term: string; hits: number; bonus: boolean; jdCount: number; inSections: string[] }>;
  };
}

/** N12 · 投递话术（greeting=打招呼，coverLetter=求职信）。 */
export interface Pitch {
  greeting: string;
  coverLetter: string;
  generatedAt: number;
  model: string | null;
  basedOn: string;
  degraded: boolean;
}

/** N12 · /api/agent/gen-pitch 响应（返回更新后的岗位行 + pitch）。 */
export interface GenPitchResult extends ApplicationItem {
  pitch: Pitch;
}

/** N12 S2 · 面试复盘记录。 */
export interface InterviewNoteItem {
  id: string;
  applicationId: string | null;
  company: string | null;
  position: string | null;
  round: string | null;
  interviewAt: string | null;
  payload: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

/** N12 S2 · 面经知识库条目。 */
export interface KbItem {
  id: string;
  title: string;
  category: string | null;
  tags: string[] | null;
  content: string;
  createdAt: string;
  updatedAt: string;
}

/** N12 S2 · 面试复盘（AI 结构化结果）。 */
export interface InterviewReview {
  summary: string;
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
  verdict: string;
  generatedAt: number;
  model: string | null;
  degraded: boolean;
}

/** N12 S2 · /api/agent/review-interview 响应。 */
export interface ReviewInterviewResult extends InterviewNoteItem {
  aiReview: InterviewReview;
}

/** N12 S2 · /api/agent/kb-ask 响应。 */
export interface KbAskResult {
  question: string;
  answer: string;
  sources: string[];
  grounded: boolean;
  aiUsed: boolean;
  model: string | null;
  degraded: boolean;
  hitCount: number;
}

/** N14 · AI 面试练习：会话 / 题目 / 回答 / 评分 / 弱项。 */
export type PracticeSessionStatus = 'configuring' | 'active' | 'paused' | 'completed';
export type PracticeQuestionType = 'behavioral' | 'project' | 'hr' | 'system_design';
export type PracticeDifficulty = 'easy' | 'standard' | 'hard';

export interface PracticeSession {
  id: string;
  status: PracticeSessionStatus;
  applicationId: string | null;
  resumeId: string | null;
  goal: Record<string, any>;
  currentQuestionOrder: number;
  usage: Record<string, any>;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  questions?: PracticeQuestion[];
}

export interface PracticeQuestion {
  id: string;
  sessionId: string;
  order: number;
  questionKey: string;
  question: string;
  type: PracticeQuestionType;
  dimension: string | null;
  difficulty: PracticeDifficulty;
  basis: Record<string, any>;
  maxFollowUps: number;
  skipped: boolean;
  regeneratedFrom: string | null;
  weaknessId: string | null;
  createdAt: string;
  answers?: PracticeAnswer[];
  evaluations?: PracticeEvaluation[];
}

export interface PracticeAnswer {
  id: string;
  sessionId: string;
  questionId: string;
  turn: number;
  prompt: string;
  answer: string;
  isDraft: boolean;
  wordCount: number;
  paraCount: number;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PracticeDimensionScore {
  dimension: string;
  level: number;
  reason?: string;
  evidence?: string;
}

export interface PracticeEvaluation {
  id: string;
  answerId: string;
  questionId: string;
  source: 'ai' | 'self';
  status: 'generated' | 'pending_retry' | 'not_generated';
  rubricVersion: string;
  promptVersion: string;
  modelId: string | null;
  dimensions: PracticeDimensionScore[];
  strengths: string[];
  actions: string[];
  sampleAnswer: string | null;
  summary: string | null;
  includeInProfile: boolean;
  calibration: Record<string, any> | null;
  createdAt: string;
}

export interface PracticeWeakness {
  id: string;
  source: 'dimension' | 'question' | 'interview_note';
  dimension: string | null;
  questionId: string | null;
  interviewNoteId: string | null;
  reason: string;
  status: 'pending' | 'practiced' | 'resolved';
  lastPracticeAt: string | null;
  lastLevel: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface GenerateQuestionsResult {
  sessionId: string;
  questions: PracticeQuestion[];
  aiUsed: boolean;
  model: string | null;
  degraded: boolean;
}

export interface PracticeScoreResult {
  evaluation: PracticeEvaluation;
  aiUsed: boolean;
  model: string | null;
  degraded: boolean;
  notGenerated?: boolean;
  pendingRetry?: boolean;
}

export interface SubmitFirstAnswerResult extends PracticeScoreResult {
  answer: PracticeAnswer;
}

export interface PracticeFollowUpResult {
  answer: PracticeAnswer | null;
  enough: boolean;
  target: string;
  aiUsed: boolean;
  model: string | null;
  degraded: boolean;
}

export interface PracticeSampleAnswerResult {
  sampleAnswer: string;
  basedOn: string;
  aiUsed: boolean;
  model: string | null;
  degraded: boolean;
}

export interface PracticeRetryResult {
  session: PracticeSession;
  question: PracticeQuestion;
}

export interface PracticeSettleResult {
  session: PracticeSession;
  weaknesses: PracticeWeakness[];
  profile: Record<string, any>;
}

export interface GrowthResult {
  rubricVersions: string[];
  profile: Record<string, { latest: number | null; count: number; history: Array<{ level: number; at: string; rubricVersion: string }> }>;
  trend: Record<string, Array<{ level: number; at: string }>>;
  radar: { first: Record<string, number | null>; recent: Record<string, number | null> };
  calendar: { days: string[]; totalDays: number };
  milestones: string[];
  sameQuestion: Array<{
    questionKey: string;
    question: string;
    attempts: Array<{ questionId: string; answer: string; submittedAt: string | null; levels: PracticeDimensionScore[] }>;
  }>;
}

export const listPracticeSessions = () => api<PracticeSession[]>('/practice/sessions');

export const getPracticeSession = (id: string) =>
  api<PracticeSession>(`/practice/sessions/${encodeURIComponent(id)}`);

export const createPracticeSession = (body: {
  applicationId?: string | null;
  resumeId?: string | null;
  jdText?: string;
  questionType?: string;
  difficulty?: string;
  questionCount?: number;
}) => post<PracticeSession>('/practice/sessions', body);

export const updatePracticeSessionStatus = (id: string, status: string) =>
  put<PracticeSession>(`/practice/sessions/${encodeURIComponent(id)}/status`, { status });

export const generatePracticeQuestions = (sessionId: string, count?: number) =>
  post<GenerateQuestionsResult>(`/practice/sessions/${encodeURIComponent(sessionId)}/questions/generate`, {
    ...(count ? { count } : {}),
  });

export const practiceFollowUp = (questionId: string, answerId: string) =>
  post<PracticeFollowUpResult>(`/practice/questions/${encodeURIComponent(questionId)}/follow-up`, { answerId });

export const submitFirstAnswer = (questionId: string, answer: string) =>
  post<SubmitFirstAnswerResult>(`/practice/questions/${encodeURIComponent(questionId)}/answers`, { answer });

export const retryPracticeQuestion = (questionId: string) =>
  post<PracticeRetryResult>(`/practice/questions/${encodeURIComponent(questionId)}/retry`);

export const savePracticeDraft = (answerId: string, answer: string) =>
  put<PracticeAnswer>(`/practice/answers/${encodeURIComponent(answerId)}/draft`, { answer });

export const submitPracticeAnswer = (answerId: string, answer?: string) =>
  post<PracticeAnswer>(`/practice/answers/${encodeURIComponent(answerId)}/submit`, { ...(answer !== undefined ? { answer } : {}) });

export const evaluatePracticeAnswer = (answerId: string) =>
  post<PracticeScoreResult>(`/practice/answers/${encodeURIComponent(answerId)}/evaluate`);

export const selfEvaluatePracticeAnswer = (
  answerId: string,
  dimensions: Array<{ dimension: string; level: number }>
) => post<PracticeEvaluation>(`/practice/answers/${encodeURIComponent(answerId)}/self-evaluate`, { dimensions });

export const practiceSampleAnswer = (answerId: string) =>
  post<PracticeSampleAnswerResult>(`/practice/answers/${encodeURIComponent(answerId)}/sample-answer`);

export const getPracticeGrowth = (query?: { rubricVersion?: string; from?: string; to?: string }) => {
  const qs = new URLSearchParams();
  if (query?.rubricVersion) qs.set('rubricVersion', query.rubricVersion);
  if (query?.from) qs.set('from', query.from);
  if (query?.to) qs.set('to', query.to);
  const s = qs.toString();
  return api<GrowthResult>(`/practice/growth${s ? '?' + s : ''}`);
};

export const listPracticeWeaknesses = () => api<PracticeWeakness[]>('/practice/weaknesses');

export const createPracticeWeakness = (body: {
  source: string;
  dimension?: string | null;
  questionId?: string | null;
  interviewNoteId?: string | null;
  reason: string;
}) => post<PracticeWeakness>('/practice/weaknesses', body);

export const updatePracticeWeaknessStatus = (id: string, status: string) =>
  put<PracticeWeakness>(`/practice/weaknesses/${encodeURIComponent(id)}/status`, { status });

export const settlePracticeSession = (sessionId: string) =>
  post<PracticeSettleResult>(`/practice/sessions/${encodeURIComponent(sessionId)}/settle`);

export const exportPracticeKb = (sessionId: string, body: { title: string; category?: string | null; tags?: string[] }) =>
  post<KbItem>(`/practice/sessions/${encodeURIComponent(sessionId)}/export-kb`, body);

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  // 没有请求体时绝不声明 JSON Content-Type：Fastify 会对「声明了 JSON 却是空 body」
  // 的 DELETE / POST 直接回 400（Body cannot be empty），曾让「停用 AI 配置」按钮失效。
  // FormData 也必须不声明 Content-Type：浏览器要自己生成带 boundary 的 multipart 头。
  const hasBody = init.body !== undefined && init.body !== null;
  const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData;
  const res = await fetch('/api' + path, {
    ...init,
    credentials: 'include',
    headers: {
      ...(hasBody && !isForm ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });

  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const raw = body?.message || body?.error || `HTTP ${res.status}`;
    const message = Array.isArray(raw) ? raw.join('；') : String(raw);
    // /auth/me 的 401 由 App 自己处理（它据此渲染登录页），其余接口的 401 统一广播跳登录。
    if (res.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new CustomEvent('rs:unauthorized'));
    }
    throw new HttpError(res.status, message);
  }
  return body as T;
}

export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const put = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) });

export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

/** 附件字节流：图片 / PDF 可 inline 预览，其余由服务端强制下载 + CSP sandbox。 */
export const attachmentRawUrl = (id: string) =>
  `/api/attachments/${encodeURIComponent(id)}/raw`;

/** multipart 上传（字段名 file）；归属走 query。切勿手动设置 Content-Type。 */
export function uploadAttachment(
  file: File,
  owner: { ownerType?: string; ownerId?: string } = {}
): Promise<AttachmentItem> {
  const fd = new FormData();
  fd.append('file', file);
  const qs = new URLSearchParams();
  if (owner.ownerType) qs.set('ownerType', owner.ownerType);
  if (owner.ownerId) qs.set('ownerId', owner.ownerId);
  const suffix = qs.toString();
  return api<AttachmentItem>(`/attachments${suffix ? '?' + suffix : ''}`, {
    method: 'POST',
    body: fd,
  });
}

/** PDF 下载地址：vector=Chrome 原生打印（文字可选中），image=v1 截图管线（精确分页）。 */
export const pdfUrl = (id: string, mode: 'vector' | 'image' = 'vector') =>
  `/api/resumes/${encodeURIComponent(id)}/pdf${mode === 'image' ? '?mode=image' : ''}`;

/** 导出专用页：浏览器自行跑 v1 截图管线并下载（不经服务端 Chrome）。 */
export const exportPageUrl = (id: string) =>
  `/api/resumes/${encodeURIComponent(id)}/export-page`;

/** 多格式导出下载地址：txt / md / doc（Word）。 */
export const exportTextUrl = (id: string, format: 'txt' | 'md' | 'doc') =>
  `/api/resumes/${encodeURIComponent(id)}/export?format=${format}`;

export const fmtTime = (v: unknown): string => {
  if (v == null || v === '') return '—';
  const n = typeof v === 'number' ? v : Number(v);
  const d = Number.isFinite(n) ? new Date(n) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN');
};
