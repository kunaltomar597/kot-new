import { describe, expect, it } from 'vitest';
import { countFailure, isLockedAt, type LockoutPolicy } from '../src/index.js';

const POLICY: LockoutPolicy = { maxFailures: 3, windowMinutes: 10, lockMinutes: 15 };
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 10, 12, minutes));

describe('[AUTH-003] [PC-S5] counting wrong secrets', () => {
  it('counts within the window from the first, and locks at the limit', () => {
    const first = countFailure({ failures: 0, windowStartedAt: null }, at(0), POLICY);
    expect(first).toEqual({ failures: 1, windowStartedAt: at(0), lockedUntil: null, left: 2 });
    const second = countFailure(first, at(5), POLICY);
    expect(second).toEqual({ failures: 2, windowStartedAt: at(0), lockedUntil: null, left: 1 });
    expect(countFailure(second, at(9), POLICY)).toEqual({
      failures: 0,
      windowStartedAt: null,
      lockedUntil: at(24),
      left: 0,
    });
  });

  it('starts a new window once the old one is over', () => {
    expect(countFailure({ failures: 2, windowStartedAt: at(0) }, at(10), POLICY)).toEqual({
      failures: 1,
      windowStartedAt: at(10),
      lockedUntil: null,
      left: 2,
    });
  });

  it('holds a lock until its end', () => {
    expect(isLockedAt(at(24), at(23))).toBe(true);
    expect(isLockedAt(at(24), at(24))).toBe(false);
    expect(isLockedAt(null, at(0))).toBe(false);
  });
});
