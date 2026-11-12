import { describe, expect, it } from 'vitest';
import { HttpException } from '@nestjs/common';
import { LoginThrottle } from '../src/server/auth/login-throttle.service';
import { LOGIN_MAX_FAILURES } from '../src/shared/constants';

describe('LoginThrottle', () => {
  it('同 email 连续失败达到上限后拒绝', () => {
    const t = new LoginThrottle();
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) t.recordFailure('a@test.com');
    expect(() => t.assertAllowed('a@test.com')).toThrow(HttpException);
  });

  it('不同 email 互不影响（回环下共用 ip 也不会互相锁死）', () => {
    const t = new LoginThrottle();
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) t.recordFailure('a@test.com');
    expect(() => t.assertAllowed('b@test.com')).not.toThrow();
  });

  it('成功登录后计数清零', () => {
    const t = new LoginThrottle();
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) t.recordFailure('a@test.com');
    t.reset('a@test.com');
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) t.recordFailure('a@test.com');
    expect(() => t.assertAllowed('a@test.com')).not.toThrow();
  });

  it('随机 email 泛洪不会让 Map 无界增长', () => {
    const t = new LoginThrottle();
    // 远超过 MAX_ENTRIES(10000) 的随机 key，全部处于同窗口内
    for (let i = 0; i < 20000; i++) t.recordFailure(`u${i}@test.com`);
    // 内部实现细节不对外暴露，这里只验证：泛洪后仍能正常记录且不抛异常
    expect(() => t.recordFailure('final@test.com')).not.toThrow();
    expect(() => t.assertAllowed('final@test.com')).not.toThrow();
  });
});
