import { describe, expect, it } from 'vitest';
import {
  AutosaveController,
  canonical,
  formatSavedAt,
  type AutosaveView,
} from '../src/web/pages/editor-autosave';

/** 可控的异步写请求：手动 resolve / reject，用于构造单飞、排空与乱序场景。 */
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = (err) => rej(err);
  });
  return { promise, resolve, reject };
}

/** 等待所有微任务落地（pump 的 .then 链 + flushAndWait 的 resolve）。 */
const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const NOW = 1_700_000_000_000;

function makeHarness(now: () => number = () => NOW) {
  const calls: Array<{ payload: any; seq: number }> = [];
  const gates: Deferred[] = [];
  const views: AutosaveView[] = [];
  let drained = 0;
  const ctrl = new AutosaveController({
    transport: (payload, seq) => {
      calls.push({ payload: clone(payload), seq });
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    },
    onChange: (v) => views.push(v),
    onDrained: () => { drained += 1; },
    now,
  });
  return { ctrl, calls, gates, views, drained: () => drained };
}

const doc = (name: string, savedAt?: number): any => {
  const p: any = { data: { name, sections: [] }, fonts: {}, spacing: {}, v: 8 };
  if (savedAt !== undefined) p.savedAt = savedAt;
  return p;
};

describe('canonical / formatSavedAt（纯函数口径）', () => {
  it('canonical 剥离顶层 savedAt：仅时间戳不同的两个 payload 指纹相同', () => {
    const a = doc('张三', 111);
    const b = doc('张三', 222);
    expect(canonical(a)).toBe(canonical(b));
    expect(canonical(a)).not.toContain('savedAt');
  });

  it('canonical 对 data 内改动敏感，且不递归删除嵌套字段', () => {
    const a = doc('张三', 111);
    const b = doc('李四', 111);
    expect(canonical(a)).not.toBe(canonical(b));
    const nested: any = { data: { name: '张三' }, savedAt: 1 };
    expect(canonical(nested)).toBe('{"data":{"name":"张三"}}');
    expect(canonical(null)).toBe('null');
    expect(canonical([1, 2])).toBe('[1,2]');
  });

  it('formatSavedAt 输出本地 HH:mm:ss（手动补零，不依赖 locale）', () => {
    const ts = new Date(2024, 0, 2, 3, 4, 5).getTime();
    expect(formatSavedAt(ts)).toBe('03:04:05');
    const ts2 = new Date(2024, 5, 18, 13, 47, 9).getTime();
    expect(formatSavedAt(ts2)).toBe('13:47:09');
    expect(formatSavedAt(ts2)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe('AutosaveController（状态转换与并发不变量）', () => {
  it('幂等：内容未变时 touch + commit，transport 调用 0 次', async () => {
    const h = makeHarness();
    h.ctrl.reset(doc('A'));
    h.ctrl.touch(doc('A'));
    h.ctrl.commit();
    await tick();
    expect(h.calls.length).toBe(0);
    expect(h.ctrl.view().status).toBe('idle');
    expect(h.ctrl.view().dirty).toBe(false);
    expect(h.drained()).toBe(0);
  });

  it('单飞合并：在飞期间多次 touch + commit 只发 1 次，pending 合并为最新', async () => {
    const h = makeHarness();
    h.ctrl.reset(doc('A'));
    h.ctrl.touch(doc('B'));
    h.ctrl.commit();
    expect(h.calls.length).toBe(1);
    // reset() 会推进 seq 使旧在飞响应失效，序号只需单调递增（不假定从 1 开始）
    expect(h.calls[0].seq).toBeGreaterThan(0);
    expect(h.calls[0].payload.data.name).toBe('B');
    for (const name of ['C', 'D', 'E']) {
      h.ctrl.touch(doc(name));
      h.ctrl.commit();
    }
    await tick();
    expect(h.calls.length).toBe(1);
    expect(h.ctrl.view().inflight).toBe(true);
    expect(h.ctrl.view().pendingCount).toBe(1);
    expect(h.ctrl.view().status).toBe('saving');
    h.gates[0].resolve();
    await tick();
    expect(h.calls.length).toBe(2);
    expect(h.calls[1].payload.data.name).toBe('E');
    h.gates[1].resolve();
    await tick();
  });

  it('排空续发：第一个成功后自动发第二个且内容最新，onDrained 恰好 1 次', async () => {
    const h = makeHarness();
    h.ctrl.reset(doc('A'));
    h.ctrl.touch(doc('B'));
    h.ctrl.commit();
    h.ctrl.touch(doc('C'));
    h.gates[0].resolve();
    await tick();
    expect(h.calls.length).toBe(2);
    expect(h.calls[1].payload.data.name).toBe('C');
    expect(h.drained()).toBe(0); // 未排空，不刷预览
    expect(h.ctrl.view().status).toBe('saving');
    h.gates[1].resolve();
    await tick();
    expect(h.drained()).toBe(1);
    expect(h.ctrl.view().status).toBe('saved');
    expect(h.ctrl.view().lastSavedAt).toBe(NOW);
    expect(h.ctrl.view().dirty).toBe(false);
    // 保存成功后不再重复写：撤销/重做/应用 JSON 造成内容相同的 touch 也幂等
    h.ctrl.touch(doc('C'));
    h.ctrl.commit();
    await tick();
    expect(h.calls.length).toBe(2);
  });

  it('乱序丢弃：旧 deferred 晚 resolve 不回退状态、不污染 baseline、不重复 onDrained', async () => {
    const h = makeHarness();
    h.ctrl.reset(doc('A'));
    h.ctrl.touch(doc('A2'));
    h.ctrl.commit(); // seq=1 在飞
    expect(h.calls.length).toBe(1);
    // 模拟 id 切换：reset 使旧序号失效，随后发出新简历的请求
    h.ctrl.reset(doc('B'));
    h.ctrl.touch(doc('B2'));
    h.ctrl.commit();
    expect(h.calls.length).toBe(2);
    expect(h.calls[1].seq).toBeGreaterThan(h.calls[0].seq);
    const viewsBefore = h.views.length;
    h.gates[0].resolve(); // 旧响应晚到
    await tick();
    expect(h.views.length).toBe(viewsBefore); // 不触发 onChange
    expect(h.ctrl.view().status).toBe('saving');
    expect(h.ctrl.view().lastSavedAt).toBeNull();
    expect(h.drained()).toBe(0);
    h.gates[1].resolve();
    await tick();
    expect(h.drained()).toBe(1);
    expect(h.ctrl.view().status).toBe('saved');
    expect(h.ctrl.view().lastSavedAt).toBe(NOW);
    // baseline 未被旧快照污染：再次 touch 同一内容不产生新请求
    h.ctrl.touch(doc('B2'));
    h.ctrl.commit();
    await tick();
    expect(h.calls.length).toBe(2);
  });

  it('失败可恢复：transport reject 后 error + saveError，retry 以最新 draft 成功', async () => {
    const h = makeHarness();
    h.ctrl.reset(doc('A'));
    h.ctrl.touch(doc('B'));
    h.ctrl.commit();
    h.gates[0].reject(new Error('HTTP 500'));
    await tick();
    expect(h.ctrl.view().status).toBe('error');
    expect(h.ctrl.view().saveError).toBe('HTTP 500');
    expect(h.ctrl.view().dirty).toBe(true);
    expect(h.drained()).toBe(0);
    h.ctrl.retry(doc('C'));
    expect(h.calls.length).toBe(2);
    expect(h.calls[1].payload.data.name).toBe('C');
    expect(h.ctrl.view().saveError).toBe('');
    h.gates[1].resolve();
    await tick();
    expect(h.ctrl.view().status).toBe('saved');
    expect(h.ctrl.view().saveError).toBe('');
    expect(h.drained()).toBe(1);
  });

  it('error 态 touch 不清 saveError，commit 不自动重试（不做 R8）', async () => {
    const h = makeHarness();
    h.ctrl.reset(doc('A'));
    h.ctrl.touch(doc('B'));
    h.ctrl.commit();
    h.gates[0].reject(new Error('网络中断'));
    await tick();
    const before = h.calls.length;
    h.ctrl.touch(doc('C'));
    h.ctrl.commit();
    await tick();
    expect(h.calls.length).toBe(before);
    expect(h.ctrl.view().status).toBe('error');
    expect(h.ctrl.view().saveError).toBe('网络中断');
    expect(h.ctrl.view().dirty).toBe(true);
    // 用户显式点「重试」才发，且拿到的是继续编辑后的最新内容
    h.ctrl.retry(doc('D'));
    expect(h.calls.length).toBe(before + 1);
    expect(h.calls[before].payload.data.name).toBe('D');
  });

  it('reset 清空状态并按新基线幂等；撤销回到基线不产生多余写请求', async () => {
    const h = makeHarness();
    h.ctrl.reset(doc('A'));
    h.ctrl.touch(doc('B'));
    h.ctrl.commit();
    h.gates[0].resolve();
    await tick();
    expect(h.ctrl.view().status).toBe('saved');
    h.ctrl.reset(doc('X', 999));
    expect(h.ctrl.view().status).toBe('idle');
    expect(h.ctrl.view().lastSavedAt).toBeNull();
    expect(h.ctrl.view().dirty).toBe(false);
    expect(h.ctrl.view().saveError).toBe('');
    h.ctrl.touch(doc('X', 123)); // 仅 savedAt 变化：canonical 相同
    h.ctrl.commit();
    await tick();
    expect(h.calls.length).toBe(1);
    h.ctrl.touch(doc('Y'));
    h.ctrl.touch(doc('X'));
    h.ctrl.commit();
    await tick();
    expect(h.calls.length).toBe(1); // 回到基线，pending 被取消
    expect(h.ctrl.view().dirty).toBe(false);
  });

  it('dispose 后所有响应丢弃，view 归 idle，isIdle 为 false', async () => {
    const h = makeHarness();
    h.ctrl.reset(doc('A'));
    h.ctrl.touch(doc('B'));
    h.ctrl.commit();
    const viewsBefore = h.views.length;
    h.ctrl.dispose();
    h.gates[0].resolve();
    await tick();
    expect(h.views.length).toBe(viewsBefore);
    expect(h.ctrl.view().status).toBe('idle');
    expect(h.ctrl.view().dirty).toBe(false);
    expect(h.ctrl.isIdle()).toBe(false);
    expect(h.drained()).toBe(0);
    h.ctrl.touch(doc('C'));
    h.ctrl.commit();
    await tick();
    expect(h.calls.length).toBe(1);
  });

  it('flushAndWait：队列忙时等待排空后 resolve，且落库的是最新 draft', async () => {
    const h = makeHarness();
    h.ctrl.reset(doc('A'));
    h.ctrl.touch(doc('B'));
    h.ctrl.commit();
    let done = false;
    const waiting = h.ctrl.flushAndWait(doc('C')).then(() => { done = true; });
    await tick();
    expect(done).toBe(false);
    h.gates[0].resolve();
    await tick();
    expect(h.calls.length).toBe(2);
    expect(h.calls[1].payload.data.name).toBe('C');
    expect(done).toBe(false);
    h.gates[1].resolve();
    await waiting;
    await tick();
    expect(done).toBe(true);
    expect(h.ctrl.view().dirty).toBe(false);
    expect(h.drained()).toBe(1);
  });

  it('flushAndWait：失败也 resolve 且把原因写入 saveError', async () => {
    const h = makeHarness();
    h.ctrl.reset(doc('A'));
    h.ctrl.touch(doc('B'));
    h.ctrl.commit();
    const p = h.ctrl.flushAndWait(doc('C'));
    h.gates[0].reject(new Error('服务不可用'));
    await p; // 永不 reject：若 reject 则本用例直接失败
    await tick();
    expect(h.ctrl.view().status).toBe('error');
    expect(h.ctrl.view().saveError).toBe('服务不可用');
    expect(h.ctrl.view().dirty).toBe(true);
    expect(h.drained()).toBe(0);
  });

  it('isIdle / dirty：inflight 时 idle=false，排空后 true；脏标记成功清除、失败保持', async () => {
    const h = makeHarness();
    h.ctrl.reset(doc('A'));
    expect(h.ctrl.isIdle()).toBe(true);
    expect(h.ctrl.view().dirty).toBe(false);
    h.ctrl.touch(doc('B'));
    expect(h.ctrl.view().status).toBe('editing');
    expect(h.ctrl.view().dirty).toBe(true);
    expect(h.ctrl.isIdle()).toBe(true); // 无在飞请求，仅待发
    h.ctrl.commit();
    expect(h.ctrl.isIdle()).toBe(false);
    h.gates[0].resolve();
    await tick();
    expect(h.ctrl.isIdle()).toBe(true);
    expect(h.ctrl.view().dirty).toBe(false);
    expect(h.ctrl.view().status).toBe('saved');
  });
});
