import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS } from '../../shared/constants';

interface Entry {
  count: number;
  firstAt: number;
}

/** 无界增长防护：Map 最多保留 MAX_ENTRIES 条；写满即整体清理过期项，仍满则清空。 */
const MAX_ENTRIES = 10_000;

/**
 * 内测规模（≤10 人）用进程内限流足够；重启即清零，不引入 Redis。
 *
 * key 只用 email：本地回环下所有请求的 remote ip 都是 127.0.0.1，
 * 若把 ip 也拼进 key，等于所有账号共享同一个限流桶（一人误操作锁死全体）。
 * 攻击者用随机 email 泛洪时的内存增长由 MAX_ENTRIES 上限兜底。
 */
@Injectable()
export class LoginThrottle {
  private readonly failures = new Map<string, Entry>();

  private sweep(now: number): void {
    for (const [k, e] of this.failures) {
      if (now - e.firstAt > LOGIN_WINDOW_MS) this.failures.delete(k);
    }
  }

  assertAllowed(key: string): void {
    const now = Date.now();
    const e = this.failures.get(key);
    if (e && now - e.firstAt > LOGIN_WINDOW_MS) {
      this.failures.delete(key);
      return;
    }
    if (e && e.count >= LOGIN_MAX_FAILURES) {
      throw new HttpException('登录尝试过于频繁，请 5 分钟后再试', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  recordFailure(key: string): void {
    const now = Date.now();
    const e = this.failures.get(key);
    if (!e || now - e.firstAt > LOGIN_WINDOW_MS) {
      if (this.failures.size >= MAX_ENTRIES) {
        // 写满说明被随机 email 泛洪：先清过期项腾空间，仍满则整体清空（宁可不拦也别 OOM）。
        this.sweep(now);
        if (this.failures.size >= MAX_ENTRIES) this.failures.clear();
      }
      this.failures.set(key, { count: 1, firstAt: now });
    } else {
      e.count += 1;
    }
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
