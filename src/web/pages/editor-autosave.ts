/**
 * 简历编辑器自动保存状态机（纯逻辑内核）。
 *
 * 设计目标（docs/软件团队/02-代码审查与增量设计.md §3.3.1）：
 *   · canonical 指纹只剥离顶层 savedAt，作为 baseline / 脏判断 / 幂等判断的唯一口径；
 *   · 单飞 + 合并最新：同一时刻最多一个写请求在飞，期间的新改动只覆盖 pending；
 *   · 序号内聚：seq 单调递增，stale 响应整体丢弃，不触发任何回调；
 *   · 只在队列排空且最后一次成功时回调 onDrained（视图层在此刷预览恰好一次）。
 *
 * 本模块是纯 TS：不引用视图框架、不引用任何浏览器全局对象，网络能力由 SaveTransport 注入。
 */

/** 保存状态机状态。idle 与 saved 在界面上统一渲染「已保存」。 */
export type AutosaveStatus = 'idle' | 'editing' | 'saving' | 'saved' | 'error';

/** 状态机推给视图层的不可变视图；视图层只渲染它，不自行推导状态。 */
export interface AutosaveView {
  status: AutosaveStatus;
  saveError: string;
  lastSavedAt: number | null;
  dirty: boolean;
  inflight: boolean;
  pendingCount: number;
}

/** 网络能力由外部注入：纯状态机零浏览器依赖。 */
export type SaveTransport = (payload: any, seq: number) => Promise<void>;

export interface AutosaveOptions {
  transport: SaveTransport;
  /** 状态变化时推送视图；必须是稳定引用。 */
  onChange: (view: AutosaveView) => void;
  /** 队列完全排空且最后一次成功时调用。 */
  onDrained?: () => void;
  /** 可注入时钟，便于单测确定「最近保存于」时间戳。 */
  now?: () => number;
}

/** 剥离顶层 savedAt 后的稳定指纹（沿用 legacy/js/app.js 的 contentHash 口径）。 */
export function canonical(payload: any): string {
  if (!payload || typeof payload !== 'object') return JSON.stringify(payload ?? null);
  if (Array.isArray(payload)) return JSON.stringify(payload);
  const { savedAt: _ignored, ...rest } = payload as Record<string, any>;
  return JSON.stringify(rest);
}

/** 最近保存时间 HH:mm:ss；手动 padStart，不依赖 locale / Intl。 */
export function formatSavedAt(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 把任意 reject 原因归一成可见的错误文本。 */
function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return '保存失败，请点击「重试」';
}

/** 视图浅比较：避免无变化的状态推送引发多余渲染。 */
function sameView(a: AutosaveView | null, b: AutosaveView): boolean {
  if (!a) return false;
  return a.status === b.status
    && a.saveError === b.saveError
    && a.lastSavedAt === b.lastSavedAt
    && a.dirty === b.dirty
    && a.inflight === b.inflight
    && a.pendingCount === b.pendingCount;
}

export class AutosaveController {
  private readonly opts: AutosaveOptions;
  private readonly now: () => number;
  private baseline: string;
  private pending: any = null;
  private lastDraft: any = null;
  private seq = 0;
  private inflightSeq = 0;
  private inflight = false;
  private status: AutosaveStatus = 'idle';
  private saveError = '';
  private lastSavedAt: number | null = null;
  private disposed = false;
  private waiters: Array<() => void> = [];
  private lastEmitted: AutosaveView | null = null;

  constructor(opts: AutosaveOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.baseline = canonical(null);
    // 视图层已持有初始视图，构造时不推送，避免在渲染期间触发状态更新。
    this.lastEmitted = this.view();
  }

  /** 载入 / 切换简历：baseline = canonical(draft)，清空全部状态；之后所有旧响应一律丢弃。 */
  reset(draft: any): void {
    this.seq += 1;
    this.inflightSeq = 0;
    this.inflight = false;
    this.pending = null;
    this.lastDraft = draft;
    this.baseline = canonical(draft);
    this.status = 'idle';
    this.saveError = '';
    this.lastSavedAt = null;
    this.disposed = false;
    this.resolveWaiters();
    this.emit();
  }

  /** 用户编辑或防抖窗口开始：立即给出 editing 反馈 + 记录最新快照；不发请求；幂等。 */
  touch(draft: any): void {
    if (this.disposed) return;
    this.lastDraft = draft;
    const clean = canonical(draft) === this.baseline;
    // 撤销回到基线且没有在飞请求、非 error 态：取消待写，避免内容相同的多余写请求。
    if (clean && !this.inflight && this.status !== 'error') {
      if (this.pending !== null || (this.status !== 'idle' && this.status !== 'saved')) {
        this.pending = null;
        this.status = 'saved';
        this.emit();
      }
      return;
    }
    this.pending = draft; // 合并：pending 恒为最新快照（0 或 1）
    if (this.status === 'error') {
      // 保留 saveError、不自动重试，pending 供 retry() 使用。
      this.emit();
      return;
    }
    if (this.inflight) {
      // 单飞：等待当前响应成功后自动续发，不并发。
      this.emit();
      return;
    }
    if (this.status !== 'editing') this.status = 'editing';
    this.emit();
  }

  /** 800ms 防抖到期：队列空闲且有 pending 时发一次；error 态不自动重试（等待 retry）。 */
  commit(): void {
    if (this.disposed) return;
    if (this.status === 'error') return;
    if (!this.inflight && this.pending !== null) this.pump();
  }

  /** 以「当前最新 draft」立即重试，清空 saveError，不受「draft 未变」限制。 */
  retry(draft: any): void {
    if (this.disposed) return;
    this.lastDraft = draft;
    this.pending = draft;
    this.saveError = '';
    if (this.inflight) {
      this.emit();
      return;
    }
    this.pump();
  }

  /** 离开受控路径：等待在飞请求结束 + 最新 draft 落库；永不 reject（失败写 saveError）。 */
  flushAndWait(draft: any): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.lastDraft = draft;
    const needWrite = canonical(draft) !== this.baseline
      || this.pending !== null
      || this.inflight
      || this.status === 'saving'
      || this.status === 'error';
    if (!needWrite) return Promise.resolve();
    this.pending = draft;
    this.saveError = '';
    if (this.inflight) {
      // 在飞：pending 非空，成功响应后会自动续发，无需并发。
      this.emit();
    } else {
      this.pump();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      // 防御：若 pump 未真正启动（异常路径），不让调用方永久挂起。
      if (!this.inflight && this.pending === null) resolve();
    });
  }

  /** 是否有未落盘内容：canonical(draft)!==baseline || !!pending || saving || error。 */
  isDirty(draft: any): boolean {
    if (this.disposed) return false;
    return canonical(draft) !== this.baseline
      || this.pending !== null
      || this.status === 'saving'
      || this.status === 'error';
  }

  /** 队列是否空闲：无在飞写请求（决定卸载时能否发 best-effort flush，避免乱序）。 */
  isIdle(): boolean {
    return !this.disposed && !this.inflight;
  }

  /** 卸载 / id 切换：标记 disposed，之后所有响应一律丢弃（服务端仍落库，不回滚）。 */
  dispose(): void {
    this.seq += 1;
    this.inflightSeq = 0;
    this.inflight = false;
    this.pending = null;
    this.disposed = true;
    this.status = 'idle';
    this.saveError = '';
    // 不推送：组件卸载后不再触发视图层状态更新。
    this.resolveWaiters();
  }

  /** 只读当前视图（单测断言用）。 */
  view(): AutosaveView {
    return {
      status: this.status,
      saveError: this.saveError,
      lastSavedAt: this.lastSavedAt,
      dirty: this.isDirty(this.lastDraft),
      inflight: this.inflight,
      pendingCount: this.pending === null ? 0 : 1,
    };
  }

  /** 单飞泵：只在空闲、有 pending、未销毁时发出一个请求。 */
  private pump(): void {
    if (this.disposed || this.inflight || this.pending === null) return;
    const payload = this.pending;
    this.pending = null;
    const seq = ++this.seq;
    this.inflightSeq = seq;
    this.inflight = true;
    this.status = 'saving';
    this.emit();
    let running: Promise<void>;
    try {
      running = Promise.resolve(this.opts.transport(payload, seq));
    } catch (err) {
      running = Promise.reject(err);
    }
    running.then(
      () => this.onSettled(true, payload, seq, undefined),
      (err: unknown) => this.onSettled(false, payload, seq, err),
    );
  }

  /** 响应落地：stale 整体丢弃；成功且 pending 非空继续泵，排空才 onDrained。 */
  private onSettled(ok: boolean, payload: any, seq: number, err: unknown): void {
    if (this.isStale(seq)) return;
    this.inflight = false;
    this.inflightSeq = 0;
    if (!ok) {
      this.status = 'error';
      this.saveError = errorMessage(err);
      this.emit();
      this.resolveWaiters();
      return;
    }
    this.baseline = canonical(payload);
    this.lastSavedAt = this.now();
    this.saveError = '';
    if (this.pending !== null) {
      // drained=false：不刷预览、不 resolve 等待者，立即续发最新快照。
      this.pump();
      return;
    }
    this.status = 'saved';
    this.emit();
    this.opts.onDrained?.();
    this.resolveWaiters();
  }

  /** 只认最新已发序号；命中即整体丢弃响应。 */
  private isStale(seq: number): boolean {
    return this.disposed
      || this.inflightSeq === 0
      || seq !== this.inflightSeq
      || seq !== this.seq;
  }

  private emit(): void {
    const next = this.view();
    if (sameView(this.lastEmitted, next)) return;
    this.lastEmitted = next;
    this.opts.onChange(next);
  }

  private resolveWaiters(): void {
    if (this.waiters.length === 0) return;
    const list = this.waiters;
    this.waiters = [];
    for (const resolve of list) resolve();
  }
}
