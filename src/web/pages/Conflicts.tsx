import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  dismissConflict,
  fmtTime,
  restoreConflict,
  type ConflictSnapshot,
} from '../api';

/**
 * 冲突恢复（0012）。
 *
 * 0011 把 LWW 落败方整行留进 conflict_snapshots，本页负责「人来做决定」：
 * 查看原文 → 恢复成当前版本 / 标记为已忽略。
 *
 * 恢复的三条语义必须让用户看得见（页面里也写明了）：
 *   · 不是把旧 HLC / device_id 抄回去，而是一次新的本地写（新时钟 + 同步增量）；
 *   · 被换下的当前版本自动留一条 resolution='restore' 的待处理快照，可再切回；
 *   · 快照永远不物理删除，忽略只是改状态。
 */
const ENTITY_LABEL: Record<string, string> = {
  resumes: '简历',
  versions: '版本快照',
  companies: '公司',
  company_jds: '岗位 JD',
  tracker: '投递记录',
  applications: '岗位',
  application_events: '投递事件',
  portfolios: '作品集',
  interview_notes: '面试复盘',
  interview_kb: '面经',
  settings: '设置',
  ai_configs: 'AI 配置',
};

/** 与服务端 sync/restore.ts 的 RESTORABLE_TABLES 一一对应；流水/单例表只能人工处理。 */
const RESTORABLE = new Set([
  'resumes',
  'companies',
  'company_jds',
  'referrals',
  'tracker',
  'applications',
  'portfolios',
  'interview_notes',
  'interview_kb',
]);

const STATUS_LABEL: Record<ConflictSnapshot['status'], string> = {
  pending: '待处理',
  restored: '已恢复',
  dismissed: '已忽略',
};

const RESOLUTION_LABEL: Record<ConflictSnapshot['resolution'], string> = {
  remote_wins: '远端胜出',
  local_wins: '本地胜出',
  restore: '恢复留底',
};

type StatusFilter = 'all' | ConflictSnapshot['status'];

/** 支持从其它页面用 #/conflicts?entityId=xxx 深链过来只看某条记录。 */
function initialEntityId(): string {
  const hash = window.location.hash || '';
  const pos = hash.indexOf('?');
  const q = new URLSearchParams(pos >= 0 ? hash.slice(pos + 1) : '');
  return q.get('entityId') || '';
}

/** 快照是整行 JSON（DB 列名键），挑一个人类可读的标题展示。 */
function snapshotTitle(s: ConflictSnapshot): string {
  const j = s.snapshot || {};
  const raw = j.title ?? j.name ?? j.position ?? j.content;
  if (raw == null || raw === '') return '（无标题）';
  const text = String(raw);
  return text.length > 48 ? text.slice(0, 48) + '…' : text;
}

function entityLink(s: ConflictSnapshot): string | null {
  const id = encodeURIComponent(s.entityId);
  switch (s.entity) {
    case 'resumes':
      return `#/editor/${id}`;
    case 'companies':
      return `#/companies/${id}`;
    case 'applications':
      return `#/applications/${id}`;
    case 'tracker':
      return `#/tracker/${id}`;
    default:
      return null;
  }
}

export default function Conflicts() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<StatusFilter>('pending');
  const [entity, setEntity] = useState('');
  const [entityId, setEntityId] = useState(initialEntityId);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const query = useMemo(() => {
    const q = new URLSearchParams();
    if (entity) q.set('entity', entity);
    if (entityId.trim()) q.set('entityId', entityId.trim());
    const s = q.toString();
    return s ? '?' + s : '';
  }, [entity, entityId]);

  // 一次拉全量（最多 200 条），状态筛选在前端做，切页签不用重新请求。
  const { data: items = [], isLoading } = useQuery({
    queryKey: ['conflicts', query],
    queryFn: () => api<ConflictSnapshot[]>('/sync/conflicts' + query),
  });

  const counts = useMemo(
    () => ({
      all: items.length,
      pending: items.filter((i) => i.status === 'pending').length,
      restored: items.filter((i) => i.status === 'restored').length,
      dismissed: items.filter((i) => i.status === 'dismissed').length,
    }),
    [items]
  );
  const visible = useMemo(
    () => (status === 'all' ? items : items.filter((i) => i.status === status)),
    [items, status]
  );

  const restoreM = useMutation({
    mutationFn: (id: string) => restoreConflict(id),
    onSuccess: (r) => {
      setConfirmId(null);
      setExpandedId(null);
      setError('');
      setNote(
        `已恢复「${r.restoredTitle || r.entityId}」。本次是一次新的本地写，HLC ${r.hlc}；` +
          (r.backupSnapshotId
            ? `被换下的当前版本已留底（${r.backupSnapshotId}），在列表里仍可切回。`
            : '原行已不存在，未产生留底快照。')
      );
      void qc.invalidateQueries({ queryKey: ['conflicts'] });
      void qc.invalidateQueries({ queryKey: ['attachment-changes'] });
    },
    onError: (e: unknown) => setError((e as Error).message),
  });

  const dismissM = useMutation({
    mutationFn: (id: string) => dismissConflict(id),
    onSuccess: () => {
      setConfirmId(null);
      setError('');
      setNote('已标记忽略；快照原文永久保留，可在状态筛选里翻出来');
      void qc.invalidateQueries({ queryKey: ['conflicts'] });
    },
    onError: (e: unknown) => setError((e as Error).message),
  });

  async function copyJson(s: ConflictSnapshot) {
    try {
      await navigator.clipboard.writeText(JSON.stringify(s.snapshot, null, 2));
      setError('');
      setNote('快照 JSON 已复制到剪贴板');
    } catch {
      setError('复制失败，请在下方原文里手动选中复制');
    }
  }

  const entityOptions = useMemo(
    () => [...new Set(items.map((i) => i.entity))].sort(),
    [items]
  );

  return (
    <>
      <div className="page-head">
        <h1>冲突恢复</h1>
        <p className="muted small">
          两台设备同时编辑同一条记录时，按业务 HLC 做 LWW 判定，落败方的整行原文留在这里。
          恢复不是回拨时钟：它会作为一次<strong>新的本地写</strong>重新领 HLC、记入同步增量；
          被换下的当前版本会自动留一条待处理快照，随时可再切回。
        </p>
      </div>

      {error && <div className="alert">{error}</div>}
      {note && <div className="hint">{note}</div>}

      <section className="panel cf-panel">
        <div className="cf-summary">
          {(['pending', 'restored', 'dismissed', 'all'] as StatusFilter[]).map((k) => (
            <button
              key={k}
              className={'cf-stat' + (status === k ? ' active' : '')}
              onClick={() => setStatus(k)}
            >
              <b>{counts[k]}</b>
              <span>{k === 'all' ? '全部快照' : STATUS_LABEL[k]}</span>
            </button>
          ))}
        </div>
        <div className="cf-toolbar">
          <select value={entity} onChange={(e) => setEntity(e.target.value)} aria-label="按实体筛选">
            <option value="">全部实体</option>
            {entityOptions.map((e) => (
              <option key={e} value={e}>{ENTITY_LABEL[e] || e}</option>
            ))}
          </select>
          <input
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
            placeholder="按记录 ID 筛选"
            aria-label="按记录 ID 筛选"
          />
          {(entity || entityId) && (
            <button
              className="mini"
              onClick={() => {
                setEntity('');
                setEntityId('');
              }}
            >
              清除筛选
            </button>
          )}
          <button
            className="mini"
            onClick={() => void qc.invalidateQueries({ queryKey: ['conflicts'] })}
          >
            刷新
          </button>
        </div>
        <p className="muted small">
          仅显示当前筛选下的统计；服务端最多返回最近 200 条。快照只存本地审计数据，不参与云端同步。
        </p>
      </section>

      <section className="panel cf-panel">
        <div className="btn-row" style={{ justifyContent: 'space-between' }}>
          <h2>
            {status === 'all' ? '全部快照' : STATUS_LABEL[status]}
            <span className="muted small"> ({visible.length})</span>
          </h2>
        </div>

        {isLoading ? (
          <div className="empty">正在读取本地冲突快照…</div>
        ) : visible.length === 0 ? (
          <div className="empty">
            {counts.all === 0
              ? '暂无冲突快照。只有跨设备回灌发生 LWW 判定、或人工恢复换下当前版本时才会产生留底。'
              : '当前筛选下没有快照。切到「全部快照」可以看到已处理记录。'}
          </div>
        ) : (
          <div className="cf-list">
            {visible.map((s) => {
              const expanded = expandedId === s.id;
              const canRestore = s.status === 'pending' && RESTORABLE.has(s.entity);
              const link = entityLink(s);
              return (
                <article key={s.id} className={'cf-card' + (s.status !== 'pending' ? ' is-done' : '')}>
                  <div
                    className="cf-head"
                    role="button"
                    tabIndex={0}
                    onClick={() => setExpandedId(expanded ? null : s.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') setExpandedId(expanded ? null : s.id);
                    }}
                  >
                    <span className="cf-title">
                      {ENTITY_LABEL[s.entity] || s.entity} · {snapshotTitle(s)}
                    </span>
                    <span className="tag">{STATUS_LABEL[s.status]}</span>
                    <span className="tag">{RESOLUTION_LABEL[s.resolution]}</span>
                    <span className="muted small">{fmtTime(s.createdAt)}</span>
                    <span className="cf-chevron" aria-hidden>{expanded ? '−' : '+'}</span>
                  </div>

                  <div className="cf-meta">
                    <div>记录 ID <span className="mono">{s.entityId}</span></div>
                    <div>胜者 HLC <span className="mono">{s.winnerHlc}</span></div>
                    <div>落败方 HLC <span className="mono">{s.loserHlc}</span></div>
                    <div>落败设备 <span className="mono">{s.loserDeviceId}</span></div>
                    {s.restoredFrom && <div>源自恢复 <span className="mono">{s.restoredFrom}</span></div>}
                    {s.resolvedAt && <div>处理时间 <span>{fmtTime(s.resolvedAt)}</span></div>}
                  </div>

                  <div className="cf-actions">
                    {s.status === 'pending' && !RESTORABLE.has(s.entity) && (
                      <span className="muted small">流水 / 单例配置表不支持自动恢复，请手动处理</span>
                    )}
                    {canRestore && confirmId !== s.id && (
                      <button className="mini" onClick={() => setConfirmId(s.id)}>恢复此版本</button>
                    )}
                    {s.status === 'pending' && (
                      <button
                        className="mini"
                        disabled={dismissM.isPending}
                        onClick={() => dismissM.mutate(s.id)}
                      >
                        忽略
                      </button>
                    )}
                    {link && <a className="mini" href={link}>打开记录</a>}
                    <button className="mini" onClick={() => setExpandedId(expanded ? null : s.id)}>
                      {expanded ? '收起原文' : '查看原文'}
                    </button>
                  </div>

                  {confirmId === s.id && canRestore && (
                    <div className="cf-warn">
                      <p>
                        确认把这份落败方原文写为当前版本？它会作为<strong>一次新的本地编辑</strong>
                        （新 HLC、本机设备、同步增量），不会回拨时钟；当前版本会自动留底，之后仍可切回。
                        {s.entity === 'resumes' ? ' 恢复后建议打开编辑器确认内容。' : ''}
                      </p>
                      <div className="btn-row">
                        <button
                          className="mini"
                          disabled={restoreM.isPending}
                          onClick={() => restoreM.mutate(s.id)}
                        >
                          {restoreM.isPending ? '正在恢复…' : '确认恢复'}
                        </button>
                        <button className="mini" onClick={() => setConfirmId(null)}>取消</button>
                      </div>
                    </div>
                  )}

                  {expanded && (
                    <>
                      <div className="cf-json-head">
                        <span className="muted small">落败方整行原文（敏感列已剔除）</span>
                        <button className="mini" onClick={() => void copyJson(s)}>复制 JSON</button>
                      </div>
                      <pre className="cf-json">{JSON.stringify(s.snapshot, null, 2)}</pre>
                    </>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
