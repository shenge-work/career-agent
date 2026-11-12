import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type MouseEvent as ReactMouseEvent, type ReactNode,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, auditResume, exportTextUrl, pdfUrl, post, put, type AuditReport, type ResumeItem, type SnippetItem } from '../api';
import ConfirmModal from '../components/ConfirmModal';
import { AutosaveController, formatSavedAt, type AutosaveView, type SaveTransport } from './editor-autosave';

/** keepalive 请求体保守上限：48 KiB（浏览器 64 KiB 限制预留 headers 等开销）。 */
const KEEPALIVE_LIMIT = 48 * 1024;
/** 超上限或 flush 失败时的可见提示（浏览器原生离开确认文案不可自定义）。 */
const LARGE_PAYLOAD_HINT = '内容较大，无法自动保存；请点击状态条「重试」保存后再离开';

/** 状态条初始视图：与 AutosaveController 构造后的 idle 视图一致。 */
const INITIAL_SAVE_VIEW: AutosaveView = {
  status: 'idle', saveError: '', lastSavedAt: null, dirty: false, inflight: false, pendingCount: 0,
};

/**
 * 卸载 / 刷新前的 best-effort 写回：api.ts 的 put() 无法注入 keepalive，此处用原生请求
 * 复刻 PUT /api/resumes/:id 的 { payload } 契约（与 InterviewSession 同款写法）。
 * 返回 false 表示体量超限，不发必然失败的请求，由调用方硬拦截并写可见错误。
 */
function bestEffortFlush(resumeId: string, payload: any, onError: (msg: string) => void): boolean {
  const body = JSON.stringify({ payload });
  const bytes = new TextEncoder().encode(body).length;
  if (bytes > KEEPALIVE_LIMIT) return false;
  fetch(`/api/resumes/${encodeURIComponent(resumeId)}`, {
    method: 'PUT',
    credentials: 'include',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body,
  }).catch(() => onError(LARGE_PAYLOAD_HINT));
  return true;
}

/** 点击外部关闭下拉菜单的通用 hook：返回 ref 与开关，供主题/格式/新增板块菜单复用。 */
function useDismissible(initial = false) {
  const [open, setOpen] = useState(initial);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return { open, setOpen, ref };
}

/* =============================================================
 * 左预览 / 右编辑
 * -------------------------------------------------------------
 * 预览是后端 vm 沙箱渲染出的独立 A4 HTML（v1 真实管线，一行未改），
 * 用 iframe 隔离成「命令式 DOM 孤岛」：React 不碰预览里的任何节点。
 * 右栏只改 payload，保存后刷新 iframe，预览与 PDF 永远同源。
 * ============================================================= */

const deepClone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

type Path = (string | number)[];

function setAt(root: any, path: Path, value: any): any {
  const next = deepClone(root);
  if (!path.length) return value;
  let cur = next;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]];
  cur[path[path.length - 1]] = value;
  return next;
}

/** 新增列表项：沿用首项的形态（保留 spacing 等内部字段），字符串全部清空。 */
function blankLike(sample: any): any {
  if (typeof sample === 'string') return '';
  if (typeof sample === 'number') return 0;
  if (typeof sample === 'boolean') return false;
  if (!sample || typeof sample !== 'object') return { text: '', spacing: { mt: 0, mb: 0 } };
  const clear = (v: any): any => {
    if (typeof v === 'string') return '';
    if (Array.isArray(v)) return [];
    if (v && typeof v === 'object') {
      const o: any = {};
      for (const k of Object.keys(v)) o[k] = clear(v[k]);
      return o;
    }
    return v;
  };
  return clear(sample);
}

/** 列表纯函数：上移 / 下移 / 删除（都返回新数组，不修改入参）。 */
function moveInArray<T>(arr: T[], i: number, dir: -1 | 1): T[] {
  const n = deepClone(arr);
  const j = i + dir;
  if (j < 0 || j >= n.length) return n;
  const t = n[i];
  n[i] = n[j];
  n[j] = t;
  return n;
}
function removeAt<T>(arr: T[], i: number): T[] {
  return arr.filter((_, j) => j !== i);
}

const sp = () => ({ mt: 0, mb: 0 });
const newSectionId = () => 's_' + Math.random().toString(36).slice(2, 9);

/* =============================================================
 * 模型工厂：与 legacy/js/render/editor-schema.js 的 blank* 工厂保持一致。
 * 内部 spacing / *Spacing / *Bold 等字段随结构保留，编辑区绝不展示、绝不丢弃。
 * ============================================================= */
function blankAdvantage() {
  return { label: '', text: '', labelBold: true, spacing: sp() };
}
function blankHighlightCard() {
  return { text: '', spacing: sp() };
}
function blankPhase() {
  return {
    label: 'PHASE', date: '', title: '', desc: '',
    spacing: sp(), labelSpacing: sp(), dateSpacing: sp(), titleSpacing: sp(), descSpacing: sp(),
  };
}
function blankSkillGroup() {
  return { name: '', keywords: '', detail: '', items: [], spacing: sp(), nameSpacing: sp(), keywordsSpacing: sp(), detailSpacing: sp() };
}
function blankProject() {
  return {
    name: '', stack: '', desc: '', results: [], descQuote: true, descColor: '#888888', pageBreak: false,
    spacing: sp(), nameSpacing: sp(), stackSpacing: sp(), descSpacing: sp(),
  };
}
function blankCareerItem() {
  return {
    company: '', role: '', date: '', summary: '', summaryQuote: true, summaryColor: '#888888', pageBreak: false,
    projects: [], spacing: sp(),
    companySpacing: sp(), roleSpacing: sp(), dateSpacing: sp(), summarySpacing: sp(),
    logoSpacing: sp(), logoSizeSpacing: sp(), logoWidthSpacing: sp(), logoGapSpacing: sp(),
  };
}
function blankSection(type: string) {
  switch (type) {
    case 'advantages':
      return { id: newSectionId(), type, title: '个人优势', pageBreak: false, items: [blankAdvantage()], spacing: sp() };
    case 'highlights':
      return { id: newSectionId(), type, title: '关键印记', pageBreak: false, cards: [blankHighlightCard(), blankHighlightCard()], tags: ['', '', ''], spacing: sp() };
    case 'growth':
      return { id: newSectionId(), type, title: '技术成长路径', pageBreak: false, phases: [blankPhase(), blankPhase(), blankPhase()], spacing: sp() };
    case 'skills':
      return { id: newSectionId(), type, title: '专业技能', pageBreak: false, groups: [blankSkillGroup()], spacing: sp() };
    case 'career':
      return { id: newSectionId(), type, title: '职业履历', pageBreak: false, items: [blankCareerItem()], spacing: sp() };
    case 'custom':
      return { id: newSectionId(), type, title: '自定义', headingVisible: true, pageBreak: false, html: '', spacing: sp() };
    default:
      return { id: newSectionId(), type, title: '', pageBreak: false, spacing: sp() };
  }
}

/** 列表项新增：有首项样本时沿用其形态（blankLike），否则用 kind 专属模板。 */
function makeItem(kind: string, sample?: any): any {
  if (sample !== undefined && sample !== null && (typeof sample === 'object' || typeof sample === 'string')) {
    return blankLike(sample);
  }
  switch (kind) {
    case 'contact': return { text: '', spacing: sp() };
    case 'advantage': return blankAdvantage();
    case 'highlightCard': return blankHighlightCard();
    case 'tag': return '';
    case 'phase': return blankPhase();
    case 'skillGroup': return blankSkillGroup();
    case 'careerItem': return blankCareerItem();
    case 'project': return blankProject();
    case 'result': return { text: '', spacing: sp() };
    default: return { text: '', spacing: sp() };
  }
}

/* =============================================================
 * 语义化编辑器
 * -------------------------------------------------------------
 * 不再把整份 payload 递归铺平，而是按「简历语义」组织：
 *   · 顶部信息卡（name / subtitle / meta / contact / pageMargins）
 *   · 每个 section 一个可折叠卡片，按 type 分发语义面板
 * 内部排版字段（spacing / *Spacing / *Bold / fonts / theme）只保留、不展示。
 * ============================================================= */

const SECTION_META: Record<string, { label: string }> = {
  advantages: { label: '个人优势' },
  highlights: { label: '关键印记' },
  growth: { label: '成长路径' },
  skills: { label: '专业技能' },
  career: { label: '职业履历' },
  custom: { label: '自定义板块' },
};

/** 依据 v1 渲染层（resume-render.js）判断该字段是否支持 `**加粗**`。 */
function supportsBold(type: string, key: string): boolean {
  if (type === 'highlights' && key === 'text') return true; // 高亮卡正文
  if (type === 'skills' && (key === 'keywords' || key === 'detail')) return true; // 技能关键词/说明
  if (type === 'custom' && key === 'html') return true; // 自定义板块自由内容
  return false;
}

function sectionCount(section: any): number {
  const t = section?.type;
  if (t === 'advantages') return (section.items || []).length;
  if (t === 'highlights') return (section.cards || []).length;
  if (t === 'growth') return (section.phases || []).length;
  if (t === 'skills') return (section.groups || []).length;
  if (t === 'career') return (section.items || []).length;
  return 0;
}

const MARGIN_KEYS = ['top', 'right', 'bottom', 'left'] as const;
const MARGIN_LABELS: Record<string, string> = { top: '上', right: '右', bottom: '下', left: '左' };

/** 删除二次确认上下文：各删除按钮通过 requestDelete(描述, 执行回调) 上报，统一走确认弹窗。 */
interface DeleteRequest {
  label: string;
  action: () => void;
}
const DeleteConfirmContext = createContext<(req: DeleteRequest) => void>(() => {});
const useDeleteConfirm = () => useContext(DeleteConfirmContext);

interface FieldProps {
  label: string;
  path: Path;
  value: any;
  onSet: (path: Path, value: any) => void;
  long?: boolean;
  bold?: boolean;
  rows?: number;
  placeholder?: string;
}
function TextField({ label, path, value, onSet, long, bold, rows = 3, placeholder }: FieldProps) {
  return (
    <div className="field">
      <label>
        {label}
        {bold && <span className="bold-hint" title="该字段支持 **文字** 渲染为粗体">**</span>}
      </label>
      {long ? (
        <textarea rows={rows} value={String(value ?? '')} placeholder={placeholder} onChange={(e) => onSet(path, e.target.value)} />
      ) : (
        <input value={String(value ?? '')} placeholder={placeholder} onChange={(e) => onSet(path, e.target.value)} />
      )}
    </div>
  );
}

function BoolField({ label, path, value, onSet }: { label: string; path: Path; value: any; onSet: (p: Path, v: any) => void }) {
  return (
    <div className="field">
      <label className="check">
        <input type="checkbox" checked={!!value} onChange={(e) => onSet(path, e.target.checked)} />
        {label}
      </label>
    </div>
  );
}

interface ItemCardProps {
  index: number;
  count: number;
  brief: string;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
  deleteLabel?: string;
  children: ReactNode;
}
function ItemCard({ index, count, brief, onMove, onDelete, deleteLabel, children }: ItemCardProps) {
  const requestDelete = useDeleteConfirm();
  return (
    <div className="item-card">
      <div className="item-bar">
        <span className="muted small">{brief}</span>
        <span className="spacer" />
        <button className="mini" disabled={index === 0} onClick={() => onMove(-1)} title="上移">↑</button>
        <button className="mini" disabled={index === count - 1} onClick={() => onMove(1)} title="下移">↓</button>
        <button className="mini danger" onClick={() => requestDelete({ label: deleteLabel || brief, action: onDelete })}>删除</button>
      </div>
      <div className="item-body">{children}</div>
    </div>
  );
}

/* ------------------------------ 顶部信息卡 ------------------------------ */
function TopInfoCard({ data, prefix, onSet }: { data: any; prefix: Path; onSet: (p: Path, v: any) => void }) {
  const requestDelete = useDeleteConfirm();
  const contact = Array.isArray(data?.contact) ? data.contact : [];
  const margins = data?.pageMargins || { top: 14, right: 14, bottom: 14, left: 14 };
  return (
    <div className="sec-card top-card" data-anchor="outline-top">
      <div className="sec-head static">
        <strong className="sec-title">顶部信息</strong>
        <span className="muted small">姓名 / 定位 / 联系方式 / 页边距</span>
      </div>
      <div className="sec-body">
        <TextField label="姓名" path={[...prefix, 'name']} value={data?.name} onSet={onSet} />
        <TextField label="头衔 / 定位" path={[...prefix, 'subtitle']} value={data?.subtitle} onSet={onSet} />
        <BoolField label="头衔加粗" path={[...prefix, 'subtitleBold']} value={data?.subtitleBold} onSet={onSet} />
        <TextField label="补充信息" path={[...prefix, 'meta']} value={data?.meta} onSet={onSet} />
        <BoolField label="补充信息加粗" path={[...prefix, 'metaBold']} value={data?.metaBold} onSet={onSet} />

        <div className="list-block">
          <div className="list-label">联系方式</div>
          {contact.length === 0 && <p className="muted small">暂无联系方式</p>}
          {contact.map((c: any, i: number) => (
            <div className="inline-row" key={i}>
              <input
                value={String(typeof c === 'object' && c ? (c.text ?? '') : (c ?? ''))}
                placeholder="手机号 / 邮箱 / 教育背景"
                onChange={(e) => onSet([...prefix, 'contact', i, 'text'], e.target.value)}
              />
              <button className="mini" disabled={i === 0} onClick={() => onSet([...prefix, 'contact'], moveInArray(contact, i, -1))}>↑</button>
              <button className="mini" disabled={i === contact.length - 1} onClick={() => onSet([...prefix, 'contact'], moveInArray(contact, i, 1))}>↓</button>
              <button className="mini danger" onClick={() => requestDelete({ label: `联系方式「${String(typeof c === 'object' && c ? (c.text ?? '') : (c ?? '')) || '未命名'}」`, action: () => onSet([...prefix, 'contact'], removeAt(contact, i)) })}>×</button>
            </div>
          ))}
          <button className="mini add" onClick={() => onSet([...prefix, 'contact'], [...contact, makeItem('contact', contact[0])])}>＋ 添加联系方式</button>
        </div>

        <div className="list-block">
          <div className="list-label">页边距（mm）</div>
          <div className="margins-row">
            {MARGIN_KEYS.map((k) => (
              <label className="margin-cell" key={k}>
                <span>{MARGIN_LABELS[k]}</span>
                <input
                  type="number"
                  value={margins[k] ?? 0}
                  onChange={(e) => onSet([...prefix, 'pageMargins', k], Number(e.target.value))}
                />
              </label>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ 各板块语义面板 ------------------------------ */
function AdvantagesPanel({ section, prefix, onSet }: { section: any; prefix: Path; onSet: (p: Path, v: any) => void }) {
  const items = Array.isArray(section?.items) ? section.items : [];
  return (
    <div className="list-block">
      <div className="list-label">优势条目</div>
      {items.length === 0 && <p className="muted small">暂无条目</p>}
      {items.map((it: any, i: number) => (
        <ItemCard key={i} index={i} count={items.length} brief={`优势 ${i + 1}`}
          onMove={(d) => onSet([...prefix, 'items'], moveInArray(items, i, d))}
          onDelete={() => onSet([...prefix, 'items'], removeAt(items, i))}>
          <TextField label="小标题" path={[...prefix, 'items', i, 'label']} value={it?.label} onSet={onSet} />
          <TextField label="内容" long path={[...prefix, 'items', i, 'text']} value={it?.text} onSet={onSet} />
        </ItemCard>
      ))}
      <button className="mini add" onClick={() => onSet([...prefix, 'items'], [...items, makeItem('advantage', items[0])])}>＋ 添加优势</button>
    </div>
  );
}

function HighlightsPanel({ section, prefix, onSet }: { section: any; prefix: Path; onSet: (p: Path, v: any) => void }) {
  const requestDelete = useDeleteConfirm();
  const cards = Array.isArray(section?.cards) ? section.cards : [];
  const tags = Array.isArray(section?.tags) ? section.tags : [];
  return (
    <>
      <div className="list-block">
        <div className="list-label">高亮卡</div>
        {cards.length === 0 && <p className="muted small">暂无高亮卡</p>}
        {cards.map((c: any, i: number) => (
          <ItemCard key={i} index={i} count={cards.length} brief={`高亮卡 ${i + 1}`}
            onMove={(d) => onSet([...prefix, 'cards'], moveInArray(cards, i, d))}
            onDelete={() => onSet([...prefix, 'cards'], removeAt(cards, i))}>
            <TextField label="正文" long bold rows={4}
              path={[...prefix, 'cards', i, 'text']}
              value={typeof c === 'object' && c ? c.text : c} onSet={onSet} />
          </ItemCard>
        ))}
        <button className="mini add" onClick={() => onSet([...prefix, 'cards'], [...cards, makeItem('highlightCard', cards[0])])}>＋ 添加高亮卡</button>
      </div>
      <div className="list-block">
        <div className="list-label">标签芯片</div>
        {tags.length === 0 && <p className="muted small">暂无标签</p>}
        {tags.map((t: any, i: number) => (
          <div className="inline-row" key={i}>
            <input value={String(t ?? '')} placeholder="关键词（如 RAG / Multi-Agent）"
              onChange={(e) => onSet([...prefix, 'tags', i], e.target.value)} />
            <button className="mini danger" onClick={() => requestDelete({ label: `标签「${String(t ?? '') || '未命名'}」`, action: () => onSet([...prefix, 'tags'], removeAt(tags, i)) })}>×</button>
          </div>
        ))}
        <button className="mini add" onClick={() => onSet([...prefix, 'tags'], [...tags, makeItem('tag', tags[0])])}>＋ 添加标签</button>
      </div>
    </>
  );
}

function GrowthPanel({ section, prefix, onSet }: { section: any; prefix: Path; onSet: (p: Path, v: any) => void }) {
  const phases = Array.isArray(section?.phases) ? section.phases : [];
  return (
    <div className="list-block">
      <div className="list-label">成长阶段</div>
      {phases.length === 0 && <p className="muted small">暂无阶段</p>}
      {phases.map((p: any, i: number) => (
        <ItemCard key={i} index={i} count={phases.length} brief={p?.label || p?.title || `阶段 ${i + 1}`}
          onMove={(d) => onSet([...prefix, 'phases'], moveInArray(phases, i, d))}
          onDelete={() => onSet([...prefix, 'phases'], removeAt(phases, i))}>
          <TextField label="阶段标签" path={[...prefix, 'phases', i, 'label']} value={p?.label} onSet={onSet} />
          <TextField label="时间" path={[...prefix, 'phases', i, 'date']} value={p?.date} onSet={onSet} />
          <TextField label="主题" path={[...prefix, 'phases', i, 'title']} value={p?.title} onSet={onSet} />
          <TextField label="描述" long path={[...prefix, 'phases', i, 'desc']} value={p?.desc} onSet={onSet} />
        </ItemCard>
      ))}
      <button className="mini add" onClick={() => onSet([...prefix, 'phases'], [...phases, makeItem('phase', phases[0])])}>＋ 添加阶段</button>
    </div>
  );
}

function SkillsPanel({ section, prefix, onSet }: { section: any; prefix: Path; onSet: (p: Path, v: any) => void }) {
  const groups = Array.isArray(section?.groups) ? section.groups : [];
  return (
    <div className="list-block">
      <div className="list-label">技能分组</div>
      {groups.length === 0 && <p className="muted small">暂无分组</p>}
      {groups.map((g: any, i: number) => (
        <ItemCard key={i} index={i} count={groups.length} brief={g?.name || `技能分组 ${i + 1}`}
          onMove={(d) => onSet([...prefix, 'groups'], moveInArray(groups, i, d))}
          onDelete={() => onSet([...prefix, 'groups'], removeAt(groups, i))}>
          <TextField label="分组名" path={[...prefix, 'groups', i, 'name']} value={g?.name} onSet={onSet} />
          <TextField label="关键词行" long bold path={[...prefix, 'groups', i, 'keywords']} value={g?.keywords} onSet={onSet} />
          <TextField label="补充说明" long bold path={[...prefix, 'groups', i, 'detail']} value={g?.detail} onSet={onSet} />
        </ItemCard>
      ))}
      <button className="mini add" onClick={() => onSet([...prefix, 'groups'], [...groups, makeItem('skillGroup', groups[0])])}>＋ 添加技能分组</button>
    </div>
  );
}

function ResultList({ results, prefix, onSet }: { results: any; prefix: Path; onSet: (p: Path, v: any) => void }) {
  const requestDelete = useDeleteConfirm();
  const list = Array.isArray(results) ? results : [];
  return (
    <div className="sublist">
      <div className="list-label">量化成果</div>
      {list.map((r: any, ri: number) => (
        <div className="result-row" key={ri}>
          <textarea
            rows={2}
            value={String(typeof r === 'object' && r ? (r.text ?? '') : (r ?? ''))}
            onChange={(e) => onSet([...prefix, ri, 'text'], e.target.value)}
          />
          <div className="result-actions">
            <button className="mini" disabled={ri === 0} onClick={() => onSet(prefix, moveInArray(list, ri, -1))}>↑</button>
            <button className="mini" disabled={ri === list.length - 1} onClick={() => onSet(prefix, moveInArray(list, ri, 1))}>↓</button>
            <button className="mini danger" onClick={() => requestDelete({ label: `成果「${String(typeof r === 'object' && r ? (r.text ?? '') : (r ?? '')).slice(0, 20) || '未命名'}」`, action: () => onSet(prefix, removeAt(list, ri)) })}>×</button>
          </div>
        </div>
      ))}
      <button className="mini add" onClick={() => onSet(prefix, [...list, makeItem('result', list[0])])}>＋ 添加成果</button>
    </div>
  );
}

function CareerItemCard({ job, index, count, prefix, onMove, onDelete, onSet }: {
  job: any; index: number; count: number; prefix: Path;
  onMove: (d: -1 | 1) => void; onDelete: () => void; onSet: (p: Path, v: any) => void;
}) {
  const [open, setOpen] = useState(true);
  const requestDelete = useDeleteConfirm();
  const projects = Array.isArray(job?.projects) ? job.projects : [];
  return (
    <div className="item-card career-item">
      <div className="item-bar">
        <span className="collapse-toggle" onClick={() => setOpen((v) => !v)} title={open ? '折叠' : '展开'}>{open ? '▾' : '▸'}</span>
        <span className="muted small">{job?.company || `经历 ${index + 1}`}</span>
        <span className="spacer" />
        <button className="mini" disabled={index === 0} onClick={() => onMove(-1)}>↑</button>
        <button className="mini" disabled={index === count - 1} onClick={() => onMove(1)}>↓</button>
        <button className="mini danger" onClick={() => requestDelete({ label: `经历「${job?.company || `经历 ${index + 1}`}」`, action: onDelete })}>删除</button>
      </div>
      {open && (        <div className="item-body">
          <TextField label="公司" path={[...prefix, 'company']} value={job?.company} onSet={onSet} />
          <TextField label="岗位" path={[...prefix, 'role']} value={job?.role} onSet={onSet} />
          <TextField label="时间" path={[...prefix, 'date']} value={job?.date} onSet={onSet} />
          <TextField label="概述" long rows={4} path={[...prefix, 'summary']} value={job?.summary} onSet={onSet} />
          <BoolField label="从新一页开始" path={[...prefix, 'pageBreak']} value={job?.pageBreak} onSet={onSet} />

          <div className="sublist">
            <div className="list-label">项目经历</div>
            {projects.map((p: any, pi: number) => (
              <div className="item-card project-card" key={pi}>
                <div className="item-bar">
                  <span className="muted small">{p?.name || `项目 ${pi + 1}`}</span>
                  <span className="spacer" />
                  <button className="mini" disabled={pi === 0} onClick={() => onSet([...prefix, 'projects'], moveInArray(projects, pi, -1))}>↑</button>
                  <button className="mini" disabled={pi === projects.length - 1} onClick={() => onSet([...prefix, 'projects'], moveInArray(projects, pi, 1))}>↓</button>
                  <button className="mini danger" onClick={() => requestDelete({ label: `项目「${p?.name || '未命名'}」`, action: () => onSet([...prefix, 'projects'], removeAt(projects, pi)) })}>删除</button>
                </div>
                <div className="item-body">
                  <TextField label="项目名" path={[...prefix, 'projects', pi, 'name']} value={p?.name} onSet={onSet} />
                  <TextField label="技术栈" path={[...prefix, 'projects', pi, 'stack']} value={p?.stack} onSet={onSet} />
                  <TextField label="简介" long path={[...prefix, 'projects', pi, 'desc']} value={p?.desc} onSet={onSet} />
                  <BoolField label="从新一页开始" path={[...prefix, 'projects', pi, 'pageBreak']} value={p?.pageBreak} onSet={onSet} />
                  <ResultList results={p?.results} prefix={[...prefix, 'projects', pi, 'results']} onSet={onSet} />
                </div>
              </div>
            ))}
            <button className="mini add" onClick={() => onSet([...prefix, 'projects'], [...projects, makeItem('project', projects[0])])}>＋ 添加项目</button>
          </div>
        </div>
      )}
    </div>
  );
}

function CareerPanel({ section, prefix, onSet }: { section: any; prefix: Path; onSet: (p: Path, v: any) => void }) {
  const items = Array.isArray(section?.items) ? section.items : [];
  return (
    <div className="list-block">
      <div className="list-label">职业经历</div>
      {items.length === 0 && <p className="muted small">暂无经历</p>}
      {items.map((job: any, i: number) => (
        <CareerItemCard key={i} job={job} index={i} count={items.length} prefix={[...prefix, 'items', i]}
          onMove={(d) => onSet([...prefix, 'items'], moveInArray(items, i, d))}
          onDelete={() => onSet([...prefix, 'items'], removeAt(items, i))}
          onSet={onSet} />
      ))}
      <button className="mini add" onClick={() => onSet([...prefix, 'items'], [...items, makeItem('careerItem', items[0])])}>＋ 添加经历</button>
    </div>
  );
}

function CustomPanel({ section, prefix, onSet }: { section: any; prefix: Path; onSet: (p: Path, v: any) => void }) {
  return (
    <div className="list-block">
      <TextField label="内容（支持 **加粗** 与换行）" long bold rows={5}
        path={[...prefix, 'html']} value={section?.html} onSet={onSet} />
    </div>
  );
}

/* ------------------------------ 未知类型通用兜底 ------------------------------ */
const GENERIC_HIDDEN = new Set(['id', 'type', 'spacing']);
function isHiddenKey(k: string): boolean {
  if (GENERIC_HIDDEN.has(k)) return true;
  return /Spacing$/.test(k) || /Bold$/.test(k) || /Color$/.test(k) || /Quote$/.test(k) || k === 'headingVisible';
}
const GENERIC_LABELS: Record<string, string> = {
  name: '名称', company: '公司', role: '岗位', date: '时间', desc: '描述', text: '内容',
  stack: '技术栈', detail: '说明', keywords: '关键词', value: '数字', label: '标签',
  before: '优化前', after: '优化后', approach: '手段', cover: '封面图', metrics: '指标',
  items: '条目', projects: '项目', phases: '阶段', groups: '分组', cards: '卡片', tags: '标签',
};

function GenericFields({ value, path, onSet }: { value: any; path: Path; onSet: (p: Path, v: any) => void }) {
  if (value === null || typeof value !== 'object') return null;
  const keys = Object.keys(value).filter((k) => !isHiddenKey(k));
  return (
    <div className="generic-fields">
      {keys.map((k) => (
        <GenericNode key={k} label={GENERIC_LABELS[k] || k} value={value[k]} path={[...path, k]} onSet={onSet} />
      ))}
    </div>
  );
}

function GenericNode({ label, value, path, onSet }: { label: string; value: any; path: Path; onSet: (p: Path, v: any) => void }) {
  if (Array.isArray(value)) {
    return (
      <div className="list-block">
        <div className="list-label">{label}</div>
        {value.map((it: any, i: number) => (
          <div className="item-card" key={i}>
            <div className="item-bar">
              <span className="muted small">{label} #{i + 1}</span>
              <span className="spacer" />
              <button className="mini" disabled={i === 0} onClick={() => onSet(path, moveInArray(value, i, -1))}>↑</button>
              <button className="mini" disabled={i === value.length - 1} onClick={() => onSet(path, moveInArray(value, i, 1))}>↓</button>
              <button className="mini danger" onClick={() => onSet(path, removeAt(value, i))}>删除</button>
            </div>
            <div className="item-body">
              {typeof it === 'object' && it !== null
                ? <GenericFields value={it} path={[...path, i]} onSet={onSet} />
                : <input value={String(it ?? '')} onChange={(e) => onSet([...path, i], e.target.value)} />}
            </div>
          </div>
        ))}
        <button className="mini add" onClick={() => onSet(path, [...value, blankLike(value[0])])}>＋ 新增</button>
      </div>
    );
  }
  if (typeof value === 'boolean') return <BoolField label={label} path={path} value={value} onSet={onSet} />;
  if (typeof value === 'number') {
    return (
      <div className="field">
        <label>{label}</label>
        <input type="number" value={value} onChange={(e) => onSet(path, Number(e.target.value))} />
      </div>
    );
  }
  return <TextField label={label} path={path} value={value} onSet={onSet} long={String(value ?? '').length > 48} />;
}

function FallbackPanel({ section, prefix, onSet }: { section: any; prefix: Path; onSet: (p: Path, v: any) => void }) {
  const rest: any = {};
  Object.keys(section || {}).forEach((k) => {
    if (!isHiddenKey(k) && k !== 'title' && k !== 'pageBreak') rest[k] = section[k];
  });
  return (
    <div className="list-block">
      <p className="muted small">板块类型「{section?.type}」暂未提供专用编辑，以下为通用字段（已隐藏排版参数），复杂结构可用下方「原始 JSON」。</p>
      <GenericFields value={rest} path={prefix} onSet={onSet} />
    </div>
  );
}

/* ------------------------------ 板块卡片 / 分派 ------------------------------ */
function SectionBody({ section, prefix, onSet }: { section: any; prefix: Path; onSet: (p: Path, v: any) => void }) {
  switch (section?.type) {
    case 'advantages': return <AdvantagesPanel section={section} prefix={prefix} onSet={onSet} />;
    case 'highlights': return <HighlightsPanel section={section} prefix={prefix} onSet={onSet} />;
    case 'growth': return <GrowthPanel section={section} prefix={prefix} onSet={onSet} />;
    case 'skills': return <SkillsPanel section={section} prefix={prefix} onSet={onSet} />;
    case 'career': return <CareerPanel section={section} prefix={prefix} onSet={onSet} />;
    case 'custom': return <CustomPanel section={section} prefix={prefix} onSet={onSet} />;
    default: return <FallbackPanel section={section} prefix={prefix} onSet={onSet} />;
  }
}

function SectionCard({ section, index, count, prefix, onSet, onMove, onDelete }: {
  section: any; index: number; count: number; prefix: Path;
  onSet: (p: Path, v: any) => void; onMove: (d: -1 | 1) => void; onDelete: () => void;
}) {
  const [open, setOpen] = useState(true);
  const requestDelete = useDeleteConfirm();
  const meta = SECTION_META[section?.type] || { label: section?.type || '未知' };
  const n = sectionCount(section);
  return (
    <div className="sec-card" data-anchor={`outline-${section?.id ?? index}`}>
      <div className="sec-head" role="button" tabIndex={0} aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}>
        <span className="sec-arrow">{open ? '▾' : '▸'}</span>
        <strong className="sec-title">{section?.title || '（未命名板块）'}</strong>
        <span className="chip">{meta.label}</span>
        {n > 0 && <span className="muted small">{n} 条</span>}
        <span className="spacer" />
        <button className="mini" disabled={index === 0} onClick={(e) => { e.stopPropagation(); onMove(-1); }}>↑</button>
        <button className="mini" disabled={index === count - 1} onClick={(e) => { e.stopPropagation(); onMove(1); }}>↓</button>
        <button className="mini danger" onClick={(e) => { e.stopPropagation(); requestDelete({ label: `板块「${section?.title || meta.label}」`, action: onDelete }); }}>删除</button>
      </div>
      {open && (
        <div className="sec-body">
          <TextField label="板块标题" path={[...prefix, 'title']} value={section?.title} onSet={onSet} />
          <BoolField label="此前强制分页" path={[...prefix, 'pageBreak']} value={section?.pageBreak} onSet={onSet} />
          <SectionBody section={section} prefix={prefix} onSet={onSet} />
        </div>
      )}
    </div>
  );
}

function ResumeEditor({ data, prefix, onSet }: { data: any; prefix: Path; onSet: (p: Path, v: any) => void }) {
  const addMenu = useDismissible(false);
  const [pending, setPending] = useState<DeleteRequest | null>(null);
  const sections = Array.isArray(data?.sections) ? data.sections : [];
  const requestDelete = useCallback((req: DeleteRequest) => setPending(req), []);
  const jumpTo = useCallback((anchor: string) => {
    const el = document.querySelector(`[data-anchor="${anchor}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);
  return (
    <DeleteConfirmContext.Provider value={requestDelete}>
      <div className="semantic-editor">
        <div className="outline-bar" role="navigation" aria-label="板块大纲">
          <button className="outline-chip" onClick={() => jumpTo('outline-top')}>顶部</button>
          {sections.map((s: any, i: number) => (
            <button key={s?.id ?? i} className="outline-chip" onClick={() => jumpTo(`outline-${s?.id ?? i}`)}>
              {s?.title || SECTION_META[s?.type]?.label || `板块 ${i + 1}`}
            </button>
          ))}
        </div>
        <TopInfoCard data={data} prefix={prefix} onSet={onSet} />
        {sections.map((s: any, i: number) => (
          <SectionCard key={s?.id ?? i} section={s} index={i} count={sections.length} prefix={[...prefix, 'sections', i]}
            onSet={onSet}
            onMove={(d) => onSet([...prefix, 'sections'], moveInArray(sections, i, d))}
            onDelete={() => onSet([...prefix, 'sections'], removeAt(sections, i))} />
        ))}
        <div className="add-section-wrap" ref={addMenu.ref}>
          <button className="mini add" onClick={() => addMenu.setOpen((v) => !v)}>＋ 添加板块</button>
          {addMenu.open && (
            <div className="menu-pop add-section-pop" role="menu">
              {Object.keys(SECTION_META).map((t) => (
                <button key={t} className="menu-item" onClick={() => { onSet([...prefix, 'sections'], [...sections, blankSection(t)]); addMenu.setOpen(false); }}>
                  {SECTION_META[t].label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <ConfirmModal
        open={pending !== null}
        title="确认删除"
        message={`删除「${pending?.label || ''}」？此操作可撤销（Cmd/Ctrl+Z），但删除后需要手动重建内容。`}
        confirmLabel="删除"
        danger
        onConfirm={() => { pending?.action(); setPending(null); }}
        onCancel={() => setPending(null)}
      />
    </DeleteConfirmContext.Provider>
  );
}

/* =============================================================
 * 主题画廊：5 套内置简历主题的色板预览（色值对齐 theme.service.ts）
 * ============================================================= */
/* 色板与后端 theme.service.ts 的 color 强调色对齐（rule / strong / kwText）。 */
const THEME_PALETTES: Record<string, { bars: string[]; paper: string }> = {
  classic: { bars: ['#111827', '#4b5563', '#9ca3af'], paper: '#f7f7f5' },
  modern: { bars: ['#2563eb', '#1d4ed8', '#2563eb'], paper: '#ffffff' },
  elegant: { bars: ['#0f766e', '#115e59', '#0f766e'], paper: '#ffffff' },
  warm: { bars: ['#c2410c', '#9a3412', '#c2410c'], paper: '#ffffff' },
  minimal: { bars: ['#9aa0a6', '#333333', '#555555'], paper: '#ffffff' },
};

export default function Editor() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [draft, setDraft] = useState<any>(null);
  const [error, setError] = useState('');
  const [previewKey, setPreviewKey] = useState(0);
  const [showJson, setShowJson] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [busy, setBusy] = useState<'vector' | 'image' | null>(null);
  const themesMenu = useDismissible(false);
  const formatsMenu = useDismissible(false);
  const [showHint, setShowHint] = useState(false);
  // 投递体检：体检报告弹窗
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditReport, setAuditReport] = useState<AuditReport | null>(null);
  const auditM = useMutation({
    mutationFn: () => auditResume(id, draft),
    onSuccess: (r) => {
      setAuditReport(r);
      setAuditOpen(true);
    },
    onError: (e) => setError((e as Error).message),
  });
  // 插入 STAR 素材：从素材库选一条，一键插进当前简历（作为关键印记高亮卡）。
  const [snippetOpen, setSnippetOpen] = useState(false);
  const { data: snippetList = [] } = useQuery({
    queryKey: ['snippets'],
    queryFn: () => api<SnippetItem[]>('/snippets'),
    enabled: snippetOpen,
  });
  // P0-4：A4 预览自适应宽度（默认「适应宽度」，可按需切「实际大小」）。
  const [fitMode, setFitMode] = useState<'fit' | 'full'>('fit');
  const [previewScale, setPreviewScale] = useState(1);
  // 预览内容高度（px，未缩放）：预览 HTML 是连续长条，多页时高度 = 内容自然高度。
  // 默认单页 A4（1123px），iframe onLoad 时读取真实内容高度后自适应。
  const [previewHeight, setPreviewHeight] = useState(1123);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const loadedIdRef = useRef<string | null>(null);
  // 撤销/重做：会话级内存栈（对齐 v1 undoRemove 语义，不写后端避免写放大）
  const historyRef = useRef<{ undo: any[]; redo: any[] }>({ undo: [], redo: [] });
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  // 自动保存：纯状态机 + 独立错误槽 + 离开确认（不复用导出/主题/体检的 error）
  const ctrlRef = useRef<AutosaveController | null>(null);
  const draftRef = useRef<any>(null);
  // 生命周期令牌：区分「真正卸载」与 StrictMode 的同步二次挂载
  const lifecycleRef = useRef(0);
  const [saveView, setSaveView] = useState<AutosaveView>(INITIAL_SAVE_VIEW);
  const [saveError, setSaveError] = useState('');
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState(false);

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['resume', id],
    queryFn: () => api<ResumeItem>(`/resumes/${id}`),
  });

  /** 创建绑定指定简历 id 的状态机：transport 恒为 PUT /api/resumes/:id 的 { payload } 契约。 */
  const makeController = useCallback((resumeId: string): AutosaveController => {
    const transport: SaveTransport = (payload, _seq) => {
      // 保留 v1 惯例：写盘 payload 带 savedAt（legacy 渲染 / 导入仲裁消费），
      // 但绝不参与任何比较（基线一律走 canonical）。
      const saving = deepClone(payload);
      saving.savedAt = Date.now();
      return put<ResumeItem>(`/resumes/${resumeId}`, { payload: saving }).then(() => undefined);
    };
    return new AutosaveController({
      transport,
      onChange: (v) => { setSaveView(v); setSaveError(v.saveError); },
      onDrained: () => {
        setPreviewKey((k) => k + 1);
        qc.invalidateQueries({ queryKey: ['resumes'] });
        setSaveError('');
      },
    });
  }, [qc]);

  // controller 惰性创建一次；id 切换时在下面的加载 effect 里 dispose + 重建。
  if (!ctrlRef.current) {
    ctrlRef.current = makeController(id);
  }
  // 每 render 同步最新 draft：重试 / 原生确认 / 卸载 flush 永远拿到最新内容。
  draftRef.current = draft;

  /** 超阈值 / keepalive reject 时写独立错误槽（不与 error 共槽）。 */
  const pushSaveError = useCallback((msg: string) => setSaveError(msg), []);

  // 只在「首次拿到该简历」时灌入 draft；保存后的 invalidate 不重置未保存的编辑。
  // id 参数切换时组件不卸载：必须 dispose 旧状态机 → 重建绑定新 id 的状态机 → reset(newDraft)，
  // 否则 A 简历的脏状态与在飞请求会串到 B。
  useEffect(() => {
    if (data && loadedIdRef.current !== id) {
      const switching = loadedIdRef.current !== null;
      loadedIdRef.current = id;
      const p = deepClone(data.payload || {});
      let c = ctrlRef.current;
      if (switching && c) {
        c.dispose();
        c = makeController(id);
        ctrlRef.current = c;
        setSaveView({ ...INITIAL_SAVE_VIEW });
      }
      setDraft(p);
      setJsonText(JSON.stringify(p, null, 2));
      c?.reset(p); // baseline = canonical(p)，清空脏状态
      setSaveError('');
      setLeaveOpen(false);
    }
  }, [data, id, makeController]);

  // 800ms 防抖：touch 立即给出「有未保存改动」反馈，到期 commit 才真正发 PUT。
  // 幂等由状态机的 canonical 基线保证，不再依赖 effect 依赖数组侥幸。
  useEffect(() => {
    if (!draft) return;
    const c = ctrlRef.current;
    if (!c) return;
    c.touch(draft);
    const timer = setTimeout(() => c.commit(), 800);
    return () => clearTimeout(timer);
  }, [draft, id]);

  // 只在脏状态注册原生离开确认；保存成功（dirty=false）后 cleanup 自动解绑。
  // 一律弹原生确认，同时尽力 flush；超阈值或 fetch reject 写可见 saveError，绝不静默丢弃。
  useEffect(() => {
    if (!saveView.dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
      const payload = draftRef.current;
      if (!payload) return;
      const ok = bestEffortFlush(id, payload, pushSaveError);
      if (!ok) pushSaveError(LARGE_PAYLOAD_HINT);
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [saveView.dirty, id, pushSaveError]);

  // 卸载 / id 切换：仅当队列空闲（无在飞 PUT）时发一次 best-effort flush，避免与在飞 PUT 乱序。
  // main.tsx 启用了 React.StrictMode：挂载时会同步「setup → cleanup → setup」，
  // 若 cleanup 里立刻 dispose，第二次 setup 不会重建 controller，自动保存会失效。
  // 用生命周期令牌 + 微任务确认「确实没有新的 setup」后才销毁；id 切换的 dispose 由加载 effect 负责。
  useEffect(() => {
    const token = ++lifecycleRef.current;
    return () => {
      const c = ctrlRef.current;
      if (!c) return;
      const payload = draftRef.current;
      if (payload && c.isDirty(payload) && c.isIdle()) {
        bestEffortFlush(id, payload, pushSaveError);
      }
      queueMicrotask(() => {
        if (lifecycleRef.current === token) c.dispose();
      });
    };
  }, [id, pushSaveError]);

  /** 状态条「重试」：以当前最新 draft 立即发一次，不受 draft 未变限制。 */
  const handleRetry = useCallback(() => {
    ctrlRef.current?.retry(draftRef.current);
  }, []);

  /** 「← 简历库」：脏状态拦截默认跳转，改走三按钮确认（唯一可保证落库再走的受控路径）。 */
  function handleBack(e: ReactMouseEvent<HTMLAnchorElement>) {
    if (!saveView.dirty) return;
    e.preventDefault();
    setLeaveOpen(true);
  }

  /** 「立即保存并离开」：等待队列排空；失败保持弹窗打开并把原因写入独立错误槽。 */
  async function handleSaveAndLeave() {
    const c = ctrlRef.current;
    if (!c) return;
    setLeaveBusy(true);
    await c.flushAndWait(draftRef.current);
    const err = c.view().saveError;
    setLeaveBusy(false);
    if (err) {
      setSaveError(err);
      return;
    }
    setLeaveOpen(false);
    navigate('/resumes');
  }

  const onSet = (path: Path, value: any) => {
    setDraft((prev: any) => {
      if (prev) {
        // 记录修改前快照供撤销；深拷贝避免后续修改污染历史
        const h = historyRef.current;
        h.undo.push(deepClone(prev));
        if (h.undo.length > 100) h.undo.shift();
        h.redo = [];
      }
      return setAt(prev, path, value);
    });
    setTimeout(syncHistoryFlags, 0);
  };

  function syncHistoryFlags() {
    setCanUndo(historyRef.current.undo.length > 0);
    setCanRedo(historyRef.current.redo.length > 0);
  }

  /** 把一条 STAR 素材插进当前简历：优先追加到 highlights 板块的高亮卡，无则新建该板块。 */
  function insertSnippet(s: SnippetItem) {
    const data = dataNode;
    if (!data) return;
    const sections = Array.isArray(data.sections) ? data.sections : [];
    // 素材文本：优先量化结果，退而用行动，最后用标题。
    const text = (s.result || s.action || s.title || '').trim();
    if (!text) return;

    const card = { text, spacing: sp() };
    const hi = sections.findIndex((sec: any) => sec?.type === 'highlights');
    if (hi >= 0) {
      const cards = Array.isArray(sections[hi].cards) ? sections[hi].cards : [];
      onSet([...dataPrefix, 'sections', hi, 'cards'], [...cards, card]);
    } else {
      const newSec = {
        id: newSectionId(),
        type: 'highlights',
        title: '关键印记',
        pageBreak: false,
        cards: [card, blankHighlightCard()],
        tags: ['', '', ''],
        spacing: sp(),
      };
      onSet([...dataPrefix, 'sections'], [...sections, newSec]);
    }
    setSnippetOpen(false);
  }


  function undo() {
    const h = historyRef.current;
    if (!h.undo.length) return;
    setDraft((prev: any) => {
      if (prev) h.redo.push(deepClone(prev));
      return h.undo.pop()!;
    });
    setTimeout(syncHistoryFlags, 0);
  }

  function redo() {
    const h = historyRef.current;
    if (!h.redo.length) return;
    setDraft((prev: any) => {
      if (prev) h.undo.push(deepClone(prev));
      return h.redo.pop()!;
    });
    setTimeout(syncHistoryFlags, 0);
  }

  // 键盘快捷键：Cmd/Ctrl+Z 撤销，Cmd/Ctrl+Shift+Z 或 Ctrl+Y 重做
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const dataNode = useMemo(() => {
    if (!draft) return null;
    return draft.data && typeof draft.data === 'object' ? draft.data : draft;
  }, [draft]);
  const dataPrefix: Path = draft?.data && typeof draft.data === 'object' ? ['data'] : [];

  const previewUrl = `/api/resumes/${encodeURIComponent(id)}/preview?v=${previewKey}`;

  // 预览 iframe 加载完成后，读取其内部真实内容高度（多页简历不再被裁成单页）。
  // 同源 iframe，可直接访问 contentDocument；读取 body 与 .resume 的较大值作高度基准。
  function syncPreviewHeight() {
    const frame = iframeRef.current;
    if (!frame) return;
    try {
      const doc = frame.contentDocument;
      if (!doc) return;
      const bodyH = doc.body ? doc.body.scrollHeight : 0;
      const resumeEl = doc.querySelector('.resume');
      const resumeH = resumeEl ? (resumeEl as HTMLElement).scrollHeight : 0;
      const h = Math.max(bodyH, resumeH, 1123); // 至少一页，避免空内容塌缩
      if (h > 0) setPreviewHeight(h);
    } catch {
      // 跨源或渲染异常时保持默认单页高度，不打断编辑
    }
  }

  // P0-4：依据预览区可用宽度计算缩放比，让 794px 的 A4 内容完整可见（不再被裁掉约 20%）。
  // 依赖 draft：预览 DOM 只在简历加载完成后才渲染，挂载时 ref 尚为空，须在加载完成后再挂 ResizeObserver。
  useEffect(() => {
    const el = previewScrollRef.current;
    if (!el) return;
    const A4_W = 794;
    const fit = () => {
      const contentW = el.clientWidth - 24; // 减去左右内边距
      const s = Math.max(0.1, Math.min(1, contentW / A4_W));
      setPreviewScale(fitMode === 'full' ? 1 : s);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [id, fitMode, draft]);

  async function downloadPdf(mode: 'vector' | 'image') {
    setError('');
    setBusy(mode);
    try {
      const res = await fetch(pdfUrl(id, mode), { credentials: 'include' });
      if (!res.ok) {
        const j: any = await res.json().catch(() => ({}));
        throw new Error(j.error || j.message || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = (
        (dataNode?.name || data?.title || 'resume') +
        (mode === 'image' ? '_图片版' : '') +
        '.pdf'
      ).replace(/[\\/:*?"<>|]/g, '_');
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) {
      // 导出失败与「自动保存失败」是两回事，只写 error 提示条，不污染保存状态
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function downloadText(format: 'txt' | 'md' | 'doc') {
    // 走 fetch + blob：后端转换若失败（如文件名含中文导致 500）能拿到 JSON 错误并提示，
    // 而不是像 <a href> 那样把错误体当文件静默下载下来。
    setError('');
    try {
      const res = await fetch(exportTextUrl(id, format), { credentials: 'include' });
      if (!res.ok) {
        const j: any = await res.json().catch(() => ({}));
        throw new Error(j.error || j.message || `导出失败（HTTP ${res.status}）`);
      }
      const blob = await res.blob();
      const ext = format === 'doc' ? 'doc' : format;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = ((dataNode?.name || data?.title || 'resume') + '.' + ext).replace(/[\\/:*?"<>|]/g, '_');
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) {
      // 导出失败与「自动保存失败」是两回事，只写 error 提示条，不污染保存状态
      setError((e as Error).message);
    } finally {
      formatsMenu.setOpen(false);
    }
  }

  // 主题列表（内置 5 套）
  const { data: themes = [] } = useQuery({
    queryKey: ['themes'],
    queryFn: () => api<Array<{ id: string; name: string; desc: string; layout?: string }>>('/themes'),
  });
  const themeM = useMutation({
    mutationFn: (themeId: string) => post<ResumeItem>(`/resumes/${id}/theme`, { themeId }),
    onSuccess: (row) => {
      // 应用主题后：用服务端返回的 payload 刷新 draft，并刷新预览。
      // baseline 改由状态机 reset(p) 用 canonical 口径重设（主题即一次服务端写入）。
      const p = deepClone(row.payload || {});
      setDraft(p);
      ctrlRef.current?.reset(p);
      setJsonText(JSON.stringify(p, null, 2));
      setPreviewKey((k) => k + 1);
      qc.invalidateQueries({ queryKey: ['resumes'] });
      themesMenu.setOpen(false);
    },
    onError: (e) => setError((e as Error).message),
  });
  const activeThemeId = draft?.data?.theme?.id || 'classic';
  const activeThemeName = themes.find((t) => t.id === activeThemeId)?.name || '经典';

  function applyJson() {
    try {
      const parsed = JSON.parse(jsonText);
      if (!parsed?.data?.sections) throw new Error('缺少 data.sections');
      setDraft(parsed);
      setShowJson(false);
      setError('');
    } catch (e) {
      setError('JSON 无效：' + (e as Error).message);
    }
  }

  if (isLoading) return <p className="muted">加载简历…</p>;
  if (loadError) return <div className="alert">{(loadError as Error).message}</div>;
  if (!draft || !data) return <p className="muted">简历不存在。</p>;

  return (
    <>
      <div className="editor-head">
        <div>
          <Link className="back" to="/resumes" onClick={handleBack}>← 简历库</Link>
          <h1>{data.title}</h1>
          <p className="muted small">
            左栏为 v1 真实渲染管线输出的 A4 预览；右栏改动 800ms 后自动保存并刷新预览。
          </p>
        </div>
        <div className="editor-actions">
          <span className={'save-state ' + saveView.status} aria-live="polite">
            {saveView.status === 'saving' ? '保存中…' :
             saveView.status === 'editing' ? '有未保存改动' :
             saveView.status === 'error' ? '保存失败' : '已保存'}
            {saveView.lastSavedAt && (
              <span className="save-state__time">最近保存于 {formatSavedAt(saveView.lastSavedAt)}</span>
            )}
            {saveView.status === 'error' && (
              <button className="mini save-state__retry" aria-label="重试保存" onClick={handleRetry}>重试</button>
            )}
          </span>

          <div className="menu-wrap" ref={themesMenu.ref}>
            <button className="ghost mini" onClick={() => themesMenu.setOpen((v) => !v)}>
              主题：{activeThemeName} ▾
            </button>
            {themesMenu.open && (
              <div className="menu-pop theme-gallery" role="menu">
                <div className="theme-gallery-title">简历主题</div>
                {themes.map((t) => {
                  const pal = THEME_PALETTES[t.id] || { bars: ['#888888', '#aaaaaa', '#cccccc'], paper: '#ffffff' };
                  const active = t.id === activeThemeId;
                  return (
                    <button
                      key={t.id}
                      className={'theme-gallery-item' + (active ? ' active' : '')}
                      disabled={themeM.isPending}
                      onClick={() => themeM.mutate(t.id)}
                    >
                      <span className="theme-swatch-mini" aria-hidden style={{ background: pal.paper }}>
                        {pal.bars.map((c, i) => <span key={i} className="theme-swatch-bar" style={{ background: c }} />)}
                      </span>
                      <span className="theme-gallery-info">
                        <span className="theme-gallery-name">{t.name}{active ? ' ✓' : ''}</span>
                        <span className="theme-gallery-desc">{t.desc}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <button
            className="ghost mini"
            onClick={() => auditM.mutate()}
            disabled={auditM.isPending}
          >
            {auditM.isPending ? '体检中…' : '体检'}
          </button>

          <button className="ghost mini" onClick={() => setSnippetOpen(true)}>
            插入素材
          </button>

          <div className="menu-wrap" ref={formatsMenu.ref}>
            <button className="ghost mini" onClick={() => formatsMenu.setOpen((v) => !v)}>
              导出 ▾
            </button>
            {formatsMenu.open && (
              <div className="menu-pop" role="menu">
                <button className="menu-item" onClick={() => downloadPdf('vector')} disabled={!!busy}>
                  {busy === 'vector' ? '生成中…' : '矢量 PDF（文字可选）'}
                </button>
                <button className="menu-item" onClick={() => downloadPdf('image')} disabled={!!busy}>
                  {busy === 'image' ? '生成中…（约数秒）' : '图片版 PDF（分页精准）'}
                </button>
                <div className="menu-sep" />
                <button className="menu-item" onClick={() => downloadText('txt')}>纯文本 (.txt)</button>
                <button className="menu-item" onClick={() => downloadText('md')}>Markdown (.md)</button>
                <button className="menu-item" onClick={() => downloadText('doc')}>Word (.doc)</button>
              </div>
            )}
          </div>

          <button className="ghost mini" onClick={() => window.open(previewUrl, '_blank')} disabled={!!busy}>
            打印 / 另存
          </button>
        </div>
      </div>

      {error && <div className="alert">{error}</div>}
      {saveError && <div className="alert save-error-line">{saveError}</div>}

      <div className="hint small">
        <button className="hint-toggle" onClick={() => setShowHint((v) => !v)} aria-expanded={showHint}>
          使用说明 {showHint ? '▴' : '▾'}
        </button>
        {showHint && (
          <div className="hint-body">
            <strong>加粗规则</strong>：只有「关键印记 · 高亮卡」「专业技能 · 关键词 / 说明」「自定义板块」里的 <code>**文字**</code> 会渲染成粗体；
            个人优势、成长路径、履历 / 项目描述、量化成果是纯文本，写 <code>**</code> 会露出字面星号。
            <br />
            <strong>两种 PDF</strong>：矢量版文字可选中、体积小；图片版复用 v1 分页算法、切口与预览一致但文字不可选中。
            配色严格黑白灰。
          </div>
        )}
      </div>

      <div className="editor-grid">
        <section className="preview-pane">
          <div className="pane-cap">
            <span>简历预览（A4）</span>
            <span className={'page-badge'} title="按当前内容高度估算的页数">
              {Math.max(1, Math.ceil(previewHeight / 1123))} 页
            </span>
            <span className="spacer" />
            <div className="seg">
              <button
                className={'seg-btn' + (fitMode === 'fit' ? ' active' : '')}
                onClick={() => setFitMode('fit')}
              >
                适应宽度
              </button>
              <button
                className={'seg-btn' + (fitMode === 'full' ? ' active' : '')}
                onClick={() => setFitMode('full')}
              >
                实际大小
              </button>
            </div>
            <button className="mini" onClick={() => setPreviewKey((k) => k + 1)}>刷新</button>
          </div>
          <div className="preview-fit-scroll" ref={previewScrollRef}>
            <div
              className="preview-fit"
              style={{ width: 794 * previewScale, height: previewHeight * previewScale }}
            >
              <iframe
                ref={iframeRef}
                key={previewKey}
                className="preview-frame"
                title="简历预览"
                src={previewUrl}
                onLoad={syncPreviewHeight}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: 794,
                  height: previewHeight,
                  transform: `scale(${previewScale})`,
                  transformOrigin: 'top left',
                }}
              />
            </div>
          </div>
        </section>

        <aside className="editor-pane">
          <div className="pane-cap">
            <span>内容编辑</span>
            <span className="spacer" />
            <button className="mini" disabled={!canUndo} onClick={undo} title="撤销 (Cmd/Ctrl+Z)">↶ 撤销</button>
            <button className="mini" disabled={!canRedo} onClick={redo} title="重做 (Cmd/Ctrl+Shift+Z)">↷ 重做</button>
            <span className="muted small">自动保存</span>
          </div>
          <div className="editor-scroll">
            <ResumeEditor data={dataNode} prefix={dataPrefix} onSet={onSet} />

            <div className="json-fold">
              <button className="mini" onClick={() => setShowJson((v) => !v)}>
                {showJson ? '收起' : '原始 JSON（高级）'}
              </button>
              {showJson && (
                <>
                  <p className="muted small">
                    可直接编辑完整 payload（含 fonts / spacing / pageMargins）。修改后应用即触发自动保存。
                  </p>
                  <textarea
                    className="json-editor"
                    rows={14}
                    value={jsonText}
                    onChange={(e) => setJsonText(e.target.value)}
                  />
                  <button className="mini" onClick={applyJson}>应用 JSON</button>
                </>
              )}
            </div>
          </div>
        </aside>
      </div>

      {auditOpen && auditReport && (
        <div className="modal-backdrop" onClick={() => setAuditOpen(false)}>
          <div className="modal audit-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="audit-head">
              <h2>投递体检</h2>
              <div className="audit-score" data-level={auditReport.score >= 80 ? 'ok' : auditReport.score >= 60 ? 'warn' : 'fail'}>
                <span className="audit-score-num">{auditReport.score}</span>
                <span className="audit-score-label">综合分</span>
              </div>
            </div>
            <div className="audit-summary muted small">
              通过 {auditReport.summary.ok} · 警告 {auditReport.summary.warn} · 问题 {auditReport.summary.fail}
            </div>
            <ul className="audit-list">
              {auditReport.items.map((it) => (
                <li key={it.key} className={'audit-item level-' + it.level}>
                  <span className={'audit-dot level-' + it.level} aria-hidden />
                  <div className="audit-item-body">
                    <div className="audit-item-title">
                      {it.title}
                      <span className={'audit-tag level-' + it.level}>
                        {it.level === 'ok' ? '通过' : it.level === 'warn' ? '建议' : '问题'}
                      </span>
                    </div>
                    <div className="muted small">{it.message}</div>
                    {it.detail && it.detail.length > 0 && (
                      <ul className="audit-detail">
                        {it.detail.map((d, i) => <li key={i}>{d}</li>)}
                      </ul>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="mini" onClick={() => setAuditOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {snippetOpen && (
        <div className="modal-backdrop" onClick={() => setSnippetOpen(false)}>
          <div className="modal snippet-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h2>插入经历素材</h2>
            <p className="muted small">
              从素材库选一条，把它的量化结果作为「关键印记」高亮卡插进当前简历。
            </p>
            {snippetList.length === 0 ? (
              <div className="empty" style={{ marginTop: 12 }}>
                素材库还是空的。先去「经历素材」沉淀第一条 STAR 片段，或直接在这里手动输入。
              </div>
            ) : (
              <ul className="snippet-pick-list">
                {snippetList.map((s) => {
                  const preview = (s.result || s.action || s.title || '').trim();
                  return (
                    <li key={s.id} className="snippet-pick">
                      <div className="snippet-pick-head">
                        <strong>{s.title}</strong>
                        {s.category && <span className="tag">{s.category}</span>}
                      </div>
                      {preview && <div className="muted small snippet-pick-preview">{preview}</div>}
                      <div className="btn-row" style={{ marginTop: 8 }}>
                        <button className="mini primary" onClick={() => insertSnippet(s)}>
                          插入为高亮卡
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
              <Link className="mini" to="/snippets" onClick={() => setSnippetOpen(false)}>
                去素材库管理 ↗
              </Link>
              <button className="mini" onClick={() => setSnippetOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* 脏状态离开确认：三按钮（继续编辑 / 立即保存并离开 / 直接离开） */}
      <ConfirmModal
        open={leaveOpen}
        title="有未保存的改动"
        message="确定离开吗？"
        cancelLabel="继续编辑"
        extraLabel="立即保存并离开"
        confirmLabel="直接离开"
        danger
        busy={leaveBusy}
        onCancel={() => setLeaveOpen(false)}
        onExtra={handleSaveAndLeave}
        onConfirm={() => { setLeaveOpen(false); navigate('/resumes'); }}
      />
    </>
  );
}
