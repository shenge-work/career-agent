import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, exportTextUrl, pdfUrl, post, put, type ResumeItem } from '../api';

/** 点击外部关闭下拉菜单的通用 hook：返回 ref 与开关，供主题/格式菜单复用。 */
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

/** 字段中文名：只影响标签，不改 key，写回时仍是 v1 原始结构。 */
const LABELS: Record<string, string> = {
  data: '简历内容',
  name: '姓名',
  subtitle: '头衔 / 定位',
  subtitleBold: '头衔加粗',
  meta: '补充信息',
  metaBold: '补充信息加粗',
  contact: '联系方式',
  pageMargins: '页边距（mm）',
  top: '上', right: '右', bottom: '下', left: '左',
  sections: '板块',
  title: '标题',
  text: '内容',
  label: '阶段标签',
  date: '时间',
  company: '公司',
  role: '职位',
  desc: '描述',
  detail: '说明',
  keywords: '关键词',
  stack: '技术栈',
  name2: '名称',
  results: '量化成果',
  projects: '项目',
  phases: '成长阶段',
  groups: '技能分组',
  cards: '优势要点',
  items: '条目',
  tags: '标签',
  pageBreak: '此前强制分页',
  fonts: '字号',
  spacing: '行间距',
};
const labelOf = (k: string) => LABELS[k] || k;

/** 内部排版对象不展示（值原样保留在 draft 里，编辑时不会被丢弃）。 */
const HIDDEN = new Set(['spacing', 'labelSpacing', 'spacingDefaults']);
/** 这些字符串字段通常是长文本，用 textarea。 */
const LONG_KEYS = new Set(['text', 'desc', 'detail', 'keywords', 'company', 'subtitle', 'results']);

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

interface BranchProps {
  value: any;
  path: Path;
  label: string;
  depth: number;
  onSet: (path: Path, value: any) => void;
}

function Branch({ value, path, label, depth, onSet }: BranchProps) {
  if (value === null || typeof value !== 'object') {
    const key = String(path[path.length - 1] ?? '');
    const isLong = typeof value === 'string' && (LONG_KEYS.has(key) || value.length > 48);
    if (typeof value === 'boolean') {
      return (
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={value}
              onChange={(e) => onSet(path, e.target.checked)}
            />
            {label}
          </label>
        </div>
      );
    }
    if (typeof value === 'number') {
      return (
        <div className="field">
          <label>{label}</label>
          <input
            type="number"
            value={value}
            onChange={(e) => onSet(path, Number(e.target.value))}
          />
        </div>
      );
    }
    return (
      <div className="field">
        <label>{label}</label>
        {isLong ? (
          <textarea
            rows={Math.min(8, Math.max(2, Math.ceil(String(value).length / 42)))}
            value={String(value ?? '')}
            onChange={(e) => onSet(path, e.target.value)}
          />
        ) : (
          <input value={String(value ?? '')} onChange={(e) => onSet(path, e.target.value)} />
        )}
      </div>
    );
  }

  if (Array.isArray(value)) {
    return (
      <div className={'branch array depth-' + depth}>
        <div className="branch-head">
          <span>{label}</span>
          <span className="muted small">{value.length} 条</span>
          <button
            className="mini"
            onClick={() => onSet(path, [...value, blankLike(value[0] ?? { text: '', spacing: { mt: 0, mb: 0 } })])}
          >
            ＋ 新增
          </button>
        </div>
        {value.length === 0 && <p className="muted small">暂无条目</p>}
        {value.map((item: any, i: number) => {
          const itemPath = [...path, i];
          const brief = typeof item === 'string'
            ? item.slice(0, 24)
            : typeof item === 'object' && item
              ? String(item.title || item.name || item.label || item.text || item.company || '').slice(0, 24)
              : String(item);
          return (
            <div className="array-item" key={i}>
              <div className="array-bar">
                <span className="muted small mono">
                  {label} #{i + 1}{brief ? ' · ' + brief : ''}
                </span>
                <span className="spacer" />
                <button className="mini" disabled={i === 0} onClick={() => {
                  const n = deepClone(value);
                  [n[i - 1], n[i]] = [n[i], n[i - 1]];
                  onSet(path, n);
                }}>↑</button>
                <button className="mini" disabled={i === value.length - 1} onClick={() => {
                  const n = deepClone(value);
                  [n[i + 1], n[i]] = [n[i], n[i + 1]];
                  onSet(path, n);
                }}>↓</button>
                <button className="mini danger" onClick={() => onSet(path, value.filter((_: any, j: number) => j !== i))}>
                  删除
                </button>
              </div>
              {depth < 3 ? (
                <Branch
                  value={item}
                  path={itemPath}
                  label={label}
                  depth={depth + 1}
                  onSet={onSet}
                />
              ) : (
                <textarea
                  rows={3}
                  value={JSON.stringify(item, null, 2)}
                  onChange={(e) => {
                    try { onSet(itemPath, JSON.parse(e.target.value)); } catch { /* 输入中，先不写回 */ }
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    );
  }

  const keys = Object.keys(value).filter((k) => !HIDDEN.has(k));
  return (
    <div className={'branch object depth-' + depth}>
      {keys.map((k) => (
        <Branch
          key={k}
          value={value[k]}
          path={[...path, k]}
          label={labelOf(k)}
          depth={depth + 1}
          onSet={onSet}
        />
      ))}
    </div>
  );
}

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
    queryFn: () => api<Array<{ id: string; name: string; desc: string }>>('/themes'),
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
              <div className="menu-pop" role="menu">
                {themes.map((t) => (
                  <button
                    key={t.id}
                    className={'menu-item' + (t.id === activeThemeId ? ' active' : '')}
                    disabled={themeM.isPending}
                    onClick={() => themeM.mutate(t.id)}
                  >
                    {t.name} {t.id === activeThemeId ? '✓' : ''}
                    <span className="muted small"> · {t.desc}</span>
                  </button>
                ))}
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
            <strong>加粗规则</strong>：只有「个人优势 / 自定义板块 / 技能关键词与说明」里的 <code>**文字**</code> 会渲染成粗体；
            履历描述、项目描述、量化成果是纯文本，写 <code>**</code> 会露出字面星号。
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
            <Branch
              value={dataNode}
              path={dataPrefix}
              label="简历内容"
              depth={0}
              onSet={onSet}
            />

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
