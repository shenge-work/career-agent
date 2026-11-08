/**
 * 内推信息（Referral）的前端规整层。
 *
 * 服务端只存 companyId + jsonb payload（与 companies 一致），所以字段形态由这里兜底：
 * 老数据缺字段、手填的日期、空串都能安全渲染，不用在每个页面重复判空。
 * 纯函数、无依赖，前端与测试共用。
 */

export type ReferralStatus =
  | 'pending' // 待沟通
  | 'contacted' // 已沟通
  | 'submitted' // 已内推
  | 'screening' // 简历通过
  | 'interviewing' // 面试中
  | 'offered' // 已录用
  | 'closed'; // 已失效

export interface ReferralStatusMeta {
  id: ReferralStatus;
  label: string;
  tone: 'gray' | 'blue' | 'amber' | 'green' | 'red' | 'indigo';
}

export const REFERRAL_STATUSES: ReferralStatusMeta[] = [
  { id: 'pending', label: '待沟通', tone: 'gray' },
  { id: 'contacted', label: '已沟通', tone: 'blue' },
  { id: 'submitted', label: '已内推', tone: 'indigo' },
  { id: 'screening', label: '简历通过', tone: 'blue' },
  { id: 'interviewing', label: '面试中', tone: 'amber' },
  { id: 'offered', label: '已录用', tone: 'green' },
  { id: 'closed', label: '已失效', tone: 'red' },
];

export const REFERRAL_STATUS_MAP: Record<string, ReferralStatusMeta> = Object.fromEntries(
  REFERRAL_STATUSES.map((s) => [s.id, s])
);

export function statusMeta(id?: string | null): ReferralStatusMeta {
  const key = String(id || 'pending');
  return REFERRAL_STATUS_MAP[key] || { id: 'pending', label: key, tone: 'gray' };
}

/** 渠道建议值（自由文本，仅用于下拉提示）。 */
export const REFERRAL_CHANNELS = [
  '朋友/前同事',
  '同学',
  '脉脉',
  '小红书',
  'BOSS 直聘',
  '内推码',
  '官网内推',
  '猎头',
  '社群',
  '其他',
];

export interface Referral {
  id: string;
  companyId: string | null;
  companyName: string;
  referrer: string;
  referrerRole: string;
  contact: string;
  channel: string;
  position: string;
  city: string;
  salary: string;
  jobUrl: string;
  referralCode: string;
  status: ReferralStatus;
  /** 实际投递/内推日期（YYYY-MM-DD）。 */
  appliedAt: string;
  /** 下次跟进日期（YYYY-MM-DD）。 */
  followUpAt: string;
  /** 内推码/名额有效期。 */
  validUntil: string;
  notes: string;
  tags: string[];
}

const str = (v: unknown): string => (v == null ? '' : String(v).trim());

export function normalizeReferral(payload: Record<string, any> | null | undefined, companyId?: string | null): Referral {
  const p = (payload || {}) as Record<string, any>;
  const status = String(p.status || 'pending');
  return {
    id: str(p.id),
    companyId: str(p.companyId ?? companyId) || null,
    companyName: str(p.companyName),
    referrer: str(p.referrer),
    referrerRole: str(p.referrerRole),
    contact: str(p.contact),
    channel: str(p.channel),
    position: str(p.position),
    city: str(p.city),
    salary: str(p.salary),
    jobUrl: str(p.jobUrl),
    referralCode: str(p.referralCode),
    status: (REFERRAL_STATUS_MAP[status] ? (status as ReferralStatus) : 'pending'),
    appliedAt: str(p.appliedAt),
    followUpAt: str(p.followUpAt),
    validUntil: str(p.validUntil),
    notes: str(p.notes),
    tags: Array.isArray(p.tags) ? p.tags.map((t: unknown) => str(t)).filter(Boolean) : [],
  };
}

/** 标题：优先「岗位 @ 公司」，两者都缺时退化到内推人。 */
export function referralTitle(r: Referral): string {
  if (r.position && r.companyName) return `${r.position} @ ${r.companyName}`;
  if (r.position) return r.position;
  if (r.companyName) return r.companyName;
  return r.referrer ? `${r.referrer} 的内推` : '未命名内推';
}

const DAY = 86400000;

/** 把 YYYY-MM-DD 或 ISO 串转成当天 0 点的本地时间戳；非法返回 null。 */
function dayOf(v: string): number | null {
  if (!v) return null;
  const d = new Date(v.length <= 10 ? `${v}T00:00:00` : v);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 跟进状态：逾期 / 今天 / N 天后；无日期返回 null。 */
export function followUpInfo(
  r: Referral,
  now: Date = new Date()
): { text: string; tone: 'red' | 'amber' | 'gray' } | null {
  const due = dayOf(r.followUpAt);
  if (due == null) return null;
  const today = dayOf(now.toISOString().slice(0, 10))!;
  const diff = Math.round((due - today) / DAY);
  if (diff < 0) return { text: `跟进逾期 ${-diff} 天`, tone: 'red' };
  if (diff === 0) return { text: '今天该跟进', tone: 'amber' };
  if (diff <= 3) return { text: `${diff} 天后跟进`, tone: 'amber' };
  return { text: `${diff} 天后跟进`, tone: 'gray' };
}

/** 进行中的口径：未到终态（已录用/已失效之外都算在跟进）。 */
export function isActiveReferral(r: Referral): boolean {
  return r.status !== 'offered' && r.status !== 'closed';
}

export interface ReferralStats {
  total: number;
  active: number;
  submitted: number;
  offered: number;
  dueSoon: number;
  companies: number;
}

export function referralStats(list: Referral[], now: Date = new Date()): ReferralStats {
  const dueLimit = dayOf(now.toISOString().slice(0, 10))! + 3 * DAY;
  const companySet = new Set<string>();
  let active = 0;
  let submitted = 0;
  let offered = 0;
  let dueSoon = 0;
  for (const r of list) {
    if (isActiveReferral(r)) active += 1;
    if (r.status === 'submitted' || r.status === 'screening' || r.status === 'interviewing') submitted += 1;
    if (r.status === 'offered') offered += 1;
    if (r.companyId) companySet.add(r.companyId);
    const due = dayOf(r.followUpAt);
    if (due != null && isActiveReferral(r) && due <= dueLimit) dueSoon += 1;
  }
  return { total: list.length, active, submitted, offered, dueSoon, companies: companySet.size };
}

/** 关键词命中：公司 / 岗位 / 内推人 / 渠道 / 内推码 / 备注 / 标签 / 城市。 */
export function matchReferral(r: Referral, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    r.companyName,
    r.position,
    r.referrer,
    r.referrerRole,
    r.channel,
    r.contact,
    r.referralCode,
    r.city,
    r.notes,
    r.tags.join(' '),
  ]
    .join('\n')
    .toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((term) => hay.includes(term));
}

/**
 * 公司招聘官网链接：新字段 careersUrl，同时兼容历史数据里可能出现的 recruitUrl / jobsUrl。
 * 前端只读这一个入口，避免三个页面各写一套兼容逻辑。
 */
export function careersUrlOf(payload: Record<string, any> | null | undefined): string {
  const p = (payload || {}) as Record<string, any>;
  for (const key of ['careersUrl', 'recruitUrl', 'jobsUrl']) {
    const v = str(p[key]);
    if (v) return v;
  }
  return '';
}

/** 内推入口（独立于招聘官网，可能是一个内推表单页）。 */
export function referralEntryUrlOf(payload: Record<string, any> | null | undefined): string {
  const p = (payload || {}) as Record<string, any>;
  return str(p.referralUrl);
}
