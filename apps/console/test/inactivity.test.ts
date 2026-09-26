import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InactivityTracker } from '../src/app/inactivity.js';

describe('[AUTH-005] inactivity sign-out on the device', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function tracker() {
    const calls = { warn: [] as number[], active: 0, expire: 0, keepAlive: 0 };
    const instance = new InactivityTracker({
      timeoutMs: 60_000,
      warnMs: 10_000,
      keepAliveMs: 20_000,
      onWarn: (seconds) => calls.warn.push(seconds),
      onActive: () => (calls.active += 1),
      onExpire: () => (calls.expire += 1),
      onKeepAlive: () => (calls.keepAlive += 1),
    });
    return { instance, calls };
  }

  it('warns with a countdown before the timeout, then signs out', () => {
    const { calls } = tracker();
    vi.advanceTimersByTime(49_000);
    expect(calls.warn).toEqual([]);
    vi.advanceTimersByTime(3_000);
    expect(calls.warn).toEqual([10, 9, 8]);
    vi.advanceTimersByTime(10_000);
    expect(calls.expire).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(calls.expire).toBe(1);
  });

  it('restarts the clock on input, ends the warning, and keeps the server session alive', () => {
    const { instance, calls } = tracker();
    vi.advanceTimersByTime(55_000);
    expect(calls.warn.length).toBeGreaterThan(0);
    instance.activity();
    expect(calls.active).toBe(1);
    expect(calls.keepAlive).toBe(1);
    instance.activity();
    expect(calls.keepAlive).toBe(1);
    vi.advanceTimersByTime(55_000);
    expect(calls.expire).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(calls.expire).toBe(1);
  });

  it('does nothing once stopped', () => {
    const { instance, calls } = tracker();
    instance.stop();
    instance.activity();
    vi.advanceTimersByTime(120_000);
    expect(calls).toEqual({ warn: [], active: 0, expire: 0, keepAlive: 0 });
  });
});
