import { afterEach, describe, expect, it, vi } from 'vitest';
import { PacedLoop } from '../../src/relay/paced-loop.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('the relay sync loop', () => {
  it('runs on its own schedule, sooner after a change, and backs off after failures', async () => {
    vi.useFakeTimers();
    const runs: number[] = [];
    let fail = false;
    const loop = new PacedLoop(
      () => {
        runs.push(Date.now());
        return fail ? Promise.reject(new Error('offline')) : Promise.resolve(30_000);
      },
      { retryBaseMs: 1_000, retryMaxMs: 4_000 },
      () => undefined,
    );
    const start = Date.now();
    loop.start(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(runs.map((at) => at - start)).toEqual([100]);
    loop.soon(50);
    await vi.advanceTimersByTimeAsync(50);
    expect(runs).toHaveLength(2);
    fail = true;
    loop.soon(10);
    await vi.advanceTimersByTimeAsync(10);
    expect(loop.failing).toBe(1);
    // Backing off: a change does not bring it forward; the retries double up to the cap.
    loop.soon(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(runs).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(runs).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(runs).toHaveLength(6);
    fail = false;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(loop.failing).toBe(0);
    await loop.stop();
  });

  it('[QR-009] keeps a change that came during the run that ended a back-off', async () => {
    vi.useFakeTimers();
    const runs: number[] = [];
    let fail = true;
    let release: (() => void) | undefined;
    const loop = new PacedLoop(
      async () => {
        runs.push(Date.now());
        if (fail) throw new Error('offline');
        // The run that works takes a while; a ring comes meanwhile.
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return 3_600_000;
      },
      { retryBaseMs: 1_000, retryMaxMs: 1_000 },
      () => undefined,
    );
    loop.start(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(loop.failing).toBe(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs).toHaveLength(2);
    loop.soon(20);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(loop.failing).toBe(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(runs).toHaveLength(3);
    release?.();
    await loop.stop();
  });

  it('runs once more for callers who came during a run, and they share it', async () => {
    let release: () => void = () => undefined;
    let count = 0;
    const loop = new PacedLoop(
      async () => {
        count += 1;
        if (count === 1) await new Promise<void>((resolve) => (release = resolve));
        return 60_000;
      },
      { retryBaseMs: 1_000, retryMaxMs: 4_000 },
      () => undefined,
    );
    const first = loop.run();
    const second = loop.run();
    const third = loop.run();
    expect(second).toBe(third);
    release();
    await Promise.all([first, second, third]);
    expect(count).toBe(2);
    await loop.stop();
  });
});
