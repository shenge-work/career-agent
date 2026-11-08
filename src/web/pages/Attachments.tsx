import { useMemo, useRef, useState, type DragEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  attachmentRawUrl,
  del,
  fmtTime,
  uploadAttachment,
  type AttachmentItem,
  type ChangesResponse,
} from '../api';

/**
 * 附件库（local-first）。
 *
 * 字节由服务端落在内容寻址的 blobs 目录，页面只消费 PG 元数据；
 * 所有读取都经过 /api/attachments/:id/raw 的会话鉴权，绝不静态直挂文件目录。
 * 支持：拖拽/多选上传、归属标记、图片预览、下载、软删除、同步增量预览。
 */
const MAX_BYTES = 20 * 1024 * 1024;

const OWNER_TYPES = [
  { value: '', label: '不指定归属' },
  { value: 'resume', label: '简历' },
  { value: 'application', label: '岗位' },
  { value: 'company', label: '公司' },
  { value: 'interview', label: '面试' },
  { value: 'portfolio', label: '作品集' },
  { value: 'other', label: '其它' },
];

const SYNC_LABEL: Record<AttachmentItem['syncState'], string> = {
  local: '仅本地',
  pending: '待上云',
  synced: '已同步',
  remote_only: '仅云端',
};

const ENTITY_LABEL: Record<string, string> = {
  attachments: '附件',
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

/** 从 HashRouter 的 hash 里读初始归属，支持从其它页面深链进来。 */
function initialOwner(): { ownerType: string; ownerId: string } {
  const hash = window.location.hash || '';
  const pos = hash.indexOf('?');
  const q = new URLSearchParams(pos >= 0 ? hash.slice(pos + 1) : '');
  return { ownerType: q.get('ownerType') || '', ownerId: q.get('ownerId') || '' };
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function ownerLabel(v: string | null): string {
  if (!v) return '未指定';
  return OWNER_TYPES.find((o) => o.value === v)?.label || v;
}

/** 只有位图允许内联缩略图；SVG / zip / 文本一律走下载（服务端 CSP sandbox）。 */
function isImage(mime: string): boolean {
  return mime.startsWith('image/') && mime !== 'image/svg+xml';
}

function extLabel(a: AttachmentItem): string {
  if (a.mime === 'application/pdf') return 'PDF';
  if (a.mime === 'application/zip') return 'ZIP';
  if (a.mime === 'image/svg+xml') return 'SVG';
  if (a.mime === 'text/plain') return 'TXT';
  return 'FILE';
}

export default function Attachments() {
  const qc = useQueryClient();
  const [seed] = useState(initialOwner);
  const [ownerType, setOwnerType] = useState(seed.ownerType);
  const [ownerId, setOwnerId] = useState(seed.ownerId);
  const [filterType, setFilterType] = useState(seed.ownerType);
  const [filterId, setFilterId] = useState(seed.ownerId);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const filterQuery = useMemo(() => {
    const qs = new URLSearchParams();
    if (filterType) qs.set('ownerType', filterType);
    if (filterId.trim()) qs.set('ownerId', filterId.trim());
    const s = qs.toString();
    return s ? '?' + s : '';
  }, [filterType, filterId]);

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['attachments', filterQuery],
    queryFn: () => api<AttachmentItem[]>('/attachments' + filterQuery),
  });

  // 本地 outbox 的最近变更：证明「所有本地写都能被云端按增量拉走」。
  const { data: changesResp } = useQuery({
    queryKey: ['attachment-changes'],
    queryFn: () => api<ChangesResponse>('/attachments/sync/changes?limit=1000'),
  });
  const recentChanges = useMemo(
    () => (changesResp?.changes || []).slice(-12).reverse(),
    [changesResp]
  );

  const selected = items.find((i) => i.id === selectedId) ?? null;

  const removeM = useMutation({
    mutationFn: (id: string) => del<{ ok: boolean }>(`/attachments/${id}`),
    onSuccess: () => {
      setConfirmId(null);
      setSelectedId(null);
      setError('');
      setNote('已删除（软删除墓碑已记入同步增量）');
      qc.invalidateQueries({ queryKey: ['attachments'] });
      qc.invalidateQueries({ queryKey: ['attachment-changes'] });
    },
    onError: (e: unknown) => setError((e as Error).message),
  });

  /** 顺序上传：一次可拖多个文件，失败不影响其它文件，最后统一刷新列表。 */
  async function uploadFiles(files: File[]) {
    if (!files.length || busy) return;
    setBusy(true);
    setError('');
    setNote('');
    const owner = { ownerType: ownerType || undefined, ownerId: ownerId.trim() || undefined };
    let ok = 0;
    const failures: string[] = [];
    for (const f of files) {
      if (f.size > MAX_BYTES) {
        failures.push(`${f.name}：超过 20MB`);
        continue;
      }
      try {
        await uploadAttachment(f, owner);
        ok += 1;
      } catch (e) {
        failures.push(`${f.name}：${(e as Error).message}`);
      }
    }
    setBusy(false);
    if (ok) {
      setNote(`已上传 ${ok} 个文件（内容寻址去重，重复文件只存一份字节）`);
      qc.invalidateQueries({ queryKey: ['attachments'] });
      qc.invalidateQueries({ queryKey: ['attachment-changes'] });
    }
    if (failures.length) setError(failures.join('；'));
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    void uploadFiles(Array.from(e.dataTransfer.files || []));
  }

  return (
    <>
      <div className="page-head">
        <h1>附件库</h1>
        <p className="muted small">
          图片 / PDF / Offer 截图 / 作品材料的本地存储。字节按 SHA-256 内容寻址落盘，PG 只存元数据与归属；
          单文件上限 20MB，支持 PNG、JPEG、GIF、WebP、PDF、Office(docx/xlsx/pptx)、SVG、纯文本。
        </p>
      </div>

      {error && <div className="alert">{error}</div>}
      {note && <div className="hint">{note}</div>}

      <section className="panel att-upload">
        <div className="att-upload-head">
          <h2>上传附件</h2>
          <span className="muted small">本地优先 · 断网可用 · 未来可整库上云</span>
        </div>
        <div
          className={'att-drop' + (dragging ? ' is-drag' : '')}
          role="button"
          tabIndex={0}
          onClick={() => fileRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setDragging(false);
          }}
          onDrop={onDrop}
        >
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              e.target.value = '';
              void uploadFiles(files);
            }}
          />
          <span className="att-drop-icon" aria-hidden>⇧</span>
          <div>{busy ? '正在上传…' : '拖入文件，或点击选择'}</div>
          <div className="muted small">可一次选择多个文件，将按顺序上传</div>
        </div>

        <div className="att-owner-row">
          <label>
            归属类型
            <select value={ownerType} onChange={(e) => setOwnerType(e.target.value)}>
              {OWNER_TYPES.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label>
            归属 ID（可选）
            <input
              value={ownerId}
              onChange={(e) => setOwnerId(e.target.value)}
              placeholder="如简历 ID / 岗位 ID"
            />
          </label>
          <span className="muted small att-owner-hint">归属只作标记与筛选，不影响文件读取权限。</span>
        </div>
      </section>

      <section className="panel att-list-panel">
        <div className="att-toolbar">
          <div className="att-toolbar-title">
            <h2>全部附件 <span className="muted small">({items.length})</span></h2>
          </div>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            aria-label="按归属类型筛选"
          >
            {OWNER_TYPES.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <input
            value={filterId}
            onChange={(e) => setFilterId(e.target.value)}
            placeholder="按归属 ID 筛选"
            aria-label="按归属 ID 筛选"
          />
          {(filterType || filterId) && (
            <button
              className="mini"
              onClick={() => {
                setFilterType('');
                setFilterId('');
              }}
            >
              清除筛选
            </button>
          )}
        </div>

        {isLoading ? (
          <div className="empty">正在读取本地附件…</div>
        ) : items.length === 0 ? (
          <div className="empty">暂无附件。把文件拖到上方区域即可上传。</div>
        ) : (
          <div className="att-grid">
            {items.map((a) => (
              <article
                key={a.id}
                className={'att-card' + (selectedId === a.id ? ' selected' : '')}
                onClick={() => setSelectedId(selectedId === a.id ? null : a.id)}
              >
                <div className="att-thumb">
                  {isImage(a.mime) ? (
                    <img src={attachmentRawUrl(a.id)} alt="" loading="lazy" />
                  ) : (
                    <span className="att-ext">{extLabel(a)}</span>
                  )}
                </div>
                <div className="att-card-body">
                  <div className="att-name" title={a.originalName}>{a.originalName}</div>
                  <div className="muted small">{fmtBytes(a.bytes)} · {fmtTime(a.createdAt)}</div>
                  <div className="att-tags">
                    <span className="tag">{SYNC_LABEL[a.syncState] || a.syncState}</span>
                    {a.ownerType && <span className="tag">{ownerLabel(a.ownerType)}</span>}
                  </div>
                  <div className="btn-row" onClick={(e) => e.stopPropagation()}>
                    {isImage(a.mime) || a.mime === 'application/pdf' ? (
                      <a className="mini" href={attachmentRawUrl(a.id)} target="_blank" rel="noreferrer">
                        预览
                      </a>
                    ) : null}
                    <a className="mini" href={attachmentRawUrl(a.id)} download={a.originalName}>
                      下载
                    </a>
                    {confirmId === a.id ? (
                      <>
                        <button
                          className="mini danger"
                          disabled={removeM.isPending}
                          onClick={() => removeM.mutate(a.id)}
                        >
                          确认删除
                        </button>
                        <button className="mini" onClick={() => setConfirmId(null)}>取消</button>
                      </>
                    ) : (
                      <button className="mini danger" onClick={() => setConfirmId(a.id)}>删除</button>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {selected && (
        <section className="panel att-detail">
          <div className="btn-row" style={{ justifyContent: 'space-between' }}>
            <h2>附件详情</h2>
            <button className="mini" onClick={() => setSelectedId(null)}>收起</button>
          </div>
          <div className="kv">
            <span>文件名</span><span>{selected.originalName}</span>
            <span>类型</span><span>{selected.mime}</span>
            <span>大小</span><span>{fmtBytes(selected.bytes)}</span>
            <span>归属</span><span>{ownerLabel(selected.ownerType)}{selected.ownerId ? ` · ${selected.ownerId}` : ''}</span>
            <span>同步状态</span><span>{SYNC_LABEL[selected.syncState] || selected.syncState}</span>
            <span>云端 key</span><span className="mono">{selected.remoteKey || '—（尚未上云）'}</span>
            <span>SHA-256</span><span className="mono">{selected.sha256}</span>
            <span>HLC</span><span className="mono">{selected.hlc}</span>
            <span>设备</span><span className="mono">{selected.deviceId}</span>
            <span>创建时间</span><span>{fmtTime(selected.createdAt)}</span>
          </div>
        </section>
      )}

      <section className="panel att-changes">
        <div className="btn-row" style={{ justifyContent: 'space-between' }}>
          <h2>同步增量（本地 outbox）</h2>
          <button
            className="mini"
            onClick={() => qc.invalidateQueries({ queryKey: ['attachment-changes'] })}
          >
            刷新
          </button>
        </div>
        <p className="muted small">
          附件与所有业务表的本地写都会留下一条变更；未来云端按游标增量拉取，不需要上传整个 pgdata。
          删除也会留下墓碑，避免其它设备「僵尸复活」。这里展示最近一批（最多回溯 1000 条）的末尾 12 条。
        </p>
        {recentChanges.length === 0 ? (
          <div className="empty">暂无变更记录。</div>
        ) : (
          <ul className="mini-list">
            {recentChanges.map((c) => (
              <li key={c.id}>
                <strong>{ENTITY_LABEL[c.entity] || c.entity}</strong>
                <span className="tag">{c.op === 'delete' ? '删除' : '写入'}</span>
                <span className="muted small mono">{c.hlc}</span>
                <span className="muted small">{fmtTime(c.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
        {changesResp?.nextCursor && (
          <div className="muted small mono att-cursor">当前游标：{changesResp.nextCursor}</div>
        )}
      </section>
    </>
  );
}
