import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS } from '../../shared/constants';

interface Entry {
  count: number;
  firstAt: number;
}

/** 内测规模（≤10 人）用进程内限流足够；重启即清零，不引入 Redis。 */
@Injectable()
export class LoginThrottle {
  private readonly failures = new Map<string, Entry>();

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
      this.failures.set(key, { count: 1, firstAt: now });
    } else {
      e.count += 1;
    }
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
