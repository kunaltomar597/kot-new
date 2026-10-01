import type { RecommendationEventInput } from '@rp/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SuggestionTracker } from '../src/index.js';

const ITEM = '0199a0e0-0000-7000-8000-00000000e101';
const shown = (n: number): RecommendationEventInput => ({
  kind: 'IMPRESSION',
  itemId: `0199a0e0-0000-7000-8000-${String(n).padStart(12, '0')}`,
  layer: 'BEST_SELLER',
  ruleId: null,
});

describe('[REC-008] tracking what happens to suggestions', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends events together after a moment, in batches the server takes', async () => {
    vi.useFakeTimers();
    const sent: RecommendationEventInput[][] = [];
    const tracker = new SuggestionTracker({
      send: (events) => {
        sent.push(events);
        return Promise.resolve();
      },
    });
    tracker.record(shown(1));
    tracker.record({ kind: 'TAP', itemId: ITEM, layer: 'BEST_SELLER', ruleId: null });
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(2);
    for (let n = 0; n < 120; n += 1) tracker.record(shown(n));
    await tracker.flush();
    expect(sent.slice(1).map((batch) => batch.length)).toEqual([50, 50, 20]);
  });

  it('keeps events when the server cannot be reached and sends them later', async () => {
    let up = false;
    const sent: RecommendationEventInput[][] = [];
    const errors: unknown[] = [];
    const tracker = new SuggestionTracker({
      send: (events) => {
        if (!up) return Promise.reject(new Error('offline'));
        sent.push(events);
        return Promise.resolve();
      },
      onError: (error) => errors.push(error),
    });
    tracker.record(shown(1));
    await tracker.flush();
    expect(errors).toHaveLength(1);
    up = true;
    await tracker.stop();
    expect(sent).toEqual([[shown(1)]]);
  });
});
