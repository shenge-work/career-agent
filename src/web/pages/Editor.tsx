import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, exportTextUrl, pdfUrl, post, put, type ResumeItem } from '../api';

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
  children: ReactNode;
}
function ItemCard({ index, count, brief, onMove, onDelete, children }: ItemCardProps) {
  return (
    <div className="item-card">
      <div className="item-bar">
        <span className="muted small">{brief}</span>
        <span className="spacer" />
        <button className="mini" disabled={index === 0} onClick={() => onMove(-1)} title="上移">↑</button>
        <button className="mini" disabled={index === count - 1} onClick={() => onMove(1)} title="下移">↓</button>
        <button className="mini danger" onClick={onDelete}>删除</button>
      </div>
      <div className="item-body">{children}</div>
    </div>
  );
}

/* ------------------------------ 顶部信息卡 ------------------------------ */
function TopInfoCard({ data, prefix, onSet }: { data: any; prefix: Path; onSet: (p: Path, v: any) => void }) {
  const contact = Array.isArray(data?.contact) ? data.contact : [];
  const margins = data?.pageMargins || { top: 14, right: 14, bottom: 14, left: 14 };
  return (
    <div className="sec-card top-card">
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
              <button className="mini danger" onClick={() => onSet([...prefix, 'contact'], removeAt(contact, i))}>×</button>
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
            <button className="mini danger" onClick={() => onSet([...prefix, 'tags'], removeAt(tags, i))}>×</button>
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
            <button className="mini danger" onClick={() => onSet(prefix, removeAt(list, ri))}>×</button>
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
  const projects = Array.isArray(job?.projects) ? job.projects : [];
  return (
    <div className="item-card career-item">
      <div className="item-bar">
        <span className="collapse-toggle" onClick={() => setOpen((v) => !v)} title={open ? '折叠' : '展开'}>{open ? '▾' : '▸'}</span>
        <span className="muted small">{job?.company || `经历 ${index + 1}`}</span>
        <span className="spacer" />
        <button className="mini" disabled={index === 0} onClick={() => onMove(-1)}>↑</button>
        <button className="mini" disabled={index === count - 1} onClick={() => onMove(1)}>↓</button>
        <button className="mini danger" onClick={onDelete}>删除</button>
      </div>
      {open && (
        <div className="item-body">
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
                  <button className="mini danger" onClick={() => onSet([...prefix, 'projects'], removeAt(projects, pi))}>删除</button>
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
  const meta = SECTION_META[section?.type] || { label: section?.type || '未知' };
  const n = sectionCount(section);
  return (
    <div className="sec-card">
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
        <button className="mini danger" onClick={(e) => { e.stopPropagation(); onDelete(); }}>删除</button>
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
  const sections = Array.isArray(data?.sections) ? data.sections : [];
  return (
    <div className="semantic-editor">
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
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [draft, setDraft] = useState<any>(null);
  const [status, setStatus] = useState<'idle' | 'editing' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const [previewKey, setPreviewKey] = useState(0);
  const [showJson, setShowJson] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [busy, setBusy] = useState<'vector' | 'image' | null>(null);
  const themesMenu = useDismissible(false);
  const formatsMenu = useDismissible(false);
  const [showHint, setShowHint] = useState(false);
  // P0-4：A4 预览自适应宽度（默认「适应宽度」，可按需切「实际大小」）。
  const [fitMode, setFitMode] = useState<'fit' | 'full'>('fit');
  const [previewScale, setPreviewScale] = useState(1);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const loadedIdRef = useRef<string | null>(null);
  const baselineRef = useRef<string>('');
  // 撤销/重做：会话级内存栈（对齐 v1 undoRemove 语义，不写后端避免写放大）
  const historyRef = useRef<{ undo: any[]; redo: any[] }>({ undo: [], redo: [] });
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['resume', id],
    queryFn: () => api<ResumeItem>(`/resumes/${id}`),
  });

  // 只在「首次拿到该简历」时灌入 draft；保存后的 invalidate 不重置未保存的编辑
  useEffect(() => {
    if (data && loadedIdRef.current !== id) {
      loadedIdRef.current = id;
      const p = deepClone(data.payload || {});
      setDraft(p);
      setJsonText(JSON.stringify(p, null, 2));
      baselineRef.current = JSON.stringify(p);
      setStatus('idle');
    }
  }, [data, id]);

  const saveM = useMutation({
    mutationFn: (payload: any) => put<ResumeItem>(`/resumes/${id}`, { payload }),
  });

  // 输入停 800ms 自动保存；保存成功后刷新预览 iframe
  useEffect(() => {
    if (!draft) return;
    const current = JSON.stringify(draft);
    if (current === baselineRef.current) return;
    setStatus('editing');
    setError('');
    const timer = setTimeout(() => {
      setStatus('saving');
      const saving = deepClone(draft);
      saving.savedAt = Date.now(); // v1 惯例：写盘 payload 带 savedAt
      saveM.mutate(saving, {
        onSuccess: () => {
          baselineRef.current = JSON.stringify(saving);
          setJsonText(JSON.stringify(saving, null, 2));
          setStatus('saved');
          setPreviewKey((k) => k + 1);
          qc.invalidateQueries({ queryKey: ['resumes'] });
        },
        onError: (e) => {
          setStatus('error');
          setError((e as Error).message);
        },
      });
    }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, id]);

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
      // 应用主题后：用服务端返回的 payload 刷新 draft，并刷新预览
      const p = deepClone(row.payload || {});
      setDraft(p);
      baselineRef.current = JSON.stringify(p);
      setJsonText(JSON.stringify(p, null, 2));
      setStatus('saved');
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
          <Link className="back" to="/resumes">← 简历库</Link>
          <h1>{data.title}</h1>
          <p className="muted small">
            左栏为 v1 真实渲染管线输出的 A4 预览；右栏改动 800ms 后自动保存并刷新预览。
          </p>
        </div>
        <div className="editor-actions">
          <span className={'save-state ' + status}>
            {status === 'saving' ? '保存中…' :
             status === 'editing' ? '有未保存改动' :
             status === 'saved' ? '已保存' :
             status === 'error' ? '保存失败' : '已同步'}
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
              style={{ width: 794 * previewScale, height: 1123 * previewScale }}
            >
              <iframe
                ref={iframeRef}
                key={previewKey}
                className="preview-frame"
                title="简历预览"
                src={previewUrl}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: 794,
                  height: 1123,
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
    </>
  );
}
