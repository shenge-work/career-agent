/**
 * HLC（混合逻辑时钟）：跨设备同步的因果序判定。
 *
 * 为什么不用 updatedAt / savedAt：现有业务写的是本机墙钟（Date.now()），
 * 两台设备差几秒甚至时区/手动改表，就会让 last-write-wins 误判「谁更新」。
 * HLC = 物理毫秒 + 同毫秒自增计数器，定长字符串保证字典序 = 因果序，
 * 可以直接放进 SQL 的 ORDER BY / WHERE hlc > $cursor。
 */
const MS_WIDTH = 13;
const COUNTER_WIDTH = 6;

export function encodeHlc(ms: number, counter: number): string {
  return String(Math.max(0, Math.floor(ms))).padStart(MS_WIDTH, '0') + '.' +
    String(Math.max(0, Math.floor(counter))).padStart(COUNTER_WIDTH, '0');
}

export function parseHlc(value: string): { ms: number; counter: number } {
  const [ms, counter] = String(value || '').split('.');
  const m = Number(ms);
  const c = Number(counter);
  return {
    ms: Number.isFinite(m) ? m : 0,
    counter: Number.isFinite(c) ? c : 0,
  };
}

export class HlcClock {
  private lastMs = 0;
  private counter = 0;

  next(): string {
    const now = Date.now();
    if (now > this.lastMs) {
      this.lastMs = now;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
    return encodeHlc(this.lastMs, this.counter);
  }

  /** 收到远端 hlc 时推进本地时钟，保证后续本地写一定大于已见过的远端写。 */
  observe(remote: string): void {
    const { ms, counter } = parseHlc(remote);
    if (ms > this.lastMs) {
      this.lastMs = ms;
      this.counter = counter + 1;
    } else if (ms === this.lastMs && counter >= this.counter) {
      this.counter = counter + 1;
    }
  }
}

/** 进程内单例；设备数量少、单进程写，无需持久化 lastMs。 */
export const hlcClock = new HlcClock();
