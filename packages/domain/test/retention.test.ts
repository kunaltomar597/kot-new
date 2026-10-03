import { describe, expect, it } from 'vitest';
import { lastVisitOf, monthsBefore, retentionCutoffs } from '../src/retention.js';

describe('[DATA-007] [DATA-011] retention cut-offs (BRD §9.3)', () => {
  it('counts calendar months back, keeping the time and the last day of a shorter month', () => {
    expect(monthsBefore(new Date('2026-10-03T10:00:00Z'), 24).toISOString()).toBe(
      '2024-10-03T10:00:00.000Z',
    );
    expect(monthsBefore(new Date('2026-03-31T00:00:00Z'), 1).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
    expect(monthsBefore(new Date('2026-01-15T00:00:00Z'), 13).toISOString()).toBe(
      '2024-12-15T00:00:00.000Z',
    );
  });

  it('removes operational data after 90 days and anonymises diners after 24 months', () => {
    const now = new Date('2026-10-03T00:00:00Z');
    expect(
      retentionCutoffs(now, { operationalDays: 90, dinerContactMonths: 24, feedbackMonths: 12 }),
    ).toEqual({
      operationalBefore: new Date('2026-07-05T00:00:00Z'),
      dinerContactsBefore: new Date('2024-10-03T00:00:00Z'),
      feedbackBefore: new Date('2025-10-03T00:00:00Z'),
    });
  });

  it('takes a diner’s last visit from their latest feedback', () => {
    const given = new Date('2024-01-01T00:00:00Z');
    expect(lastVisitOf(given, [])).toBe(given);
    expect(
      lastVisitOf(given, [new Date('2025-06-01T00:00:00Z'), new Date('2024-06-01T00:00:00Z')]),
    ).toEqual(new Date('2025-06-01T00:00:00Z'));
  });
});
