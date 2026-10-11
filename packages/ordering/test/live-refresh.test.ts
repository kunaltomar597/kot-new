import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_REFRESH_DELAY_MS, liveRefresh } from '../src/live-refresh.js';

describe('[NFR-P01] [NFR-P04] when a live screen reads again', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads once for a burst, 250 ms after its first event', () => {
    const read = vi.fn();
    const refresh = liveRefresh(read);
    refresh.notify();
    vi.advanceTimersByTime(100);
    refresh.notify();
    refresh.notify();
    vi.advanceTimersByTime(LIVE_REFRESH_DELAY_MS - 101);
    expect(read).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(read).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('keeps reading during a steady stream of events, never more than 250 ms behind one', () => {
    const read = vi.fn();
    const refresh = liveRefresh(read);
    for (let at = 0; at < 1_000; at += 100) {
      refresh.notify();
      vi.advanceTimersByTime(100);
    }
    // Reads at 250, 550 and 850 ms: the stream does not hold the screen back.
    expect(read).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(LIVE_REFRESH_DELAY_MS);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('reads nothing once cancelled', () => {
    const read = vi.fn();
    const refresh = liveRefresh(read, 50);
    refresh.notify();
    refresh.cancel();
    vi.advanceTimersByTime(1_000);
    expect(read).not.toHaveBeenCalled();
    refresh.notify();
    vi.advanceTimersByTime(50);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
