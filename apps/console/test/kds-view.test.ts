import { describe, expect, it } from 'vitest';
import {
  ageTone,
  allDaySummary,
  arrivals,
  canBump,
  groupLines,
  linesFor,
  minutesBetween,
  nextStep,
  notCollected,
  ticketStep,
} from '../src/kds/kds-view.js';
import { board, line, minutesAgo, NOW, ticket } from './kds-fixture.js';

const now = Date.parse(NOW);
const { settings } = board([]);

describe('[KDS-004] ticket age', () => {
  it('turns amber and red at the configured minutes, never negative', () => {
    expect(minutesBetween(minutesAgo(9.9), now)).toBe(9);
    expect(minutesBetween(minutesAgo(-1), now)).toBe(0);
    expect([9, 10, 19, 20].map((minutes) => ageTone(minutes, settings))).toEqual([
      'fresh',
      'amber',
      'amber',
      'red',
    ]);
  });
});

describe('[KDS-005] [KDS-007] kitchen steps and bump', () => {
  it('offers the next step per item and for the whole ticket', () => {
    expect(
      ['SENT', 'PREPARING', 'READY', 'PICKED_UP', 'CANCELLED'].map((state) =>
        nextStep(state as never),
      ),
    ).toEqual(['START_PREPARING', 'MARK_READY', 'PICK_UP', undefined, undefined]);
    const mixed = ticket(1, {
      lines: [
        line(1, { state: 'SENT' }),
        line(2, { state: 'PREPARING' }),
        line(3, { state: 'READY' }),
      ],
    });
    expect(ticketStep(mixed)).toBe('START_PREPARING');
    expect(linesFor(mixed, 'START_PREPARING').map((entry) => entry.name)).toEqual(['Dish 1']);
    expect(linesFor(mixed, 'MARK_READY').map((entry) => entry.name)).toEqual(['Dish 2']);
    expect(ticketStep(ticket(2, { lines: [line(4, { state: 'PREPARING' })] }))).toBe('MARK_READY');
    expect(ticketStep(ticket(3, { lines: [line(5, { state: 'READY' })] }))).toBeUndefined();
    expect(ticketStep(ticket(4, { kind: 'CANCELLED' }))).toBeUndefined();
  });

  it('bumps only when nothing is waiting or cooking; slips any time', () => {
    expect(canBump(ticket(1))).toBe(false);
    expect(
      canBump(ticket(2, { lines: [line(1, { state: 'READY' }), line(2, { state: 'CANCELLED' })] })),
    ).toBe(true);
    expect(canBump(ticket(3, { kind: 'MODIFIED' }))).toBe(true);
  });
});

describe('[KDS-003] [KDS-006] [KDS-009] [KDS-010] the board', () => {
  it('groups combo parts under their combo, in order', () => {
    const groups = groupLines([
      line(1),
      line(2, { comboName: 'Thali' }),
      line(3, { comboName: 'Thali' }),
      line(4),
    ]);
    expect(groups.map((group) => [group.comboName, group.lines.length])).toEqual([
      [null, 1],
      ['Thali', 2],
      [null, 1],
    ]);
  });

  it('flags ready food waiting longer than the setting', () => {
    const waiting = (minutes: number) =>
      ticket(1, { lines: [line(1, { state: 'READY', readyAt: minutesAgo(minutes) })] });
    expect(notCollected(waiting(2), now, settings)).toBe(false);
    expect(notCollected(waiting(3), now, settings)).toBe(true);
    expect(notCollected(ticket(2), now, settings)).toBe(false);
  });

  it('sums what is still to cook, variants apart', () => {
    const summary = allDaySummary([
      ticket(1, {
        lines: [line(1, { name: 'Dal', quantity: 2 }), line(2, { name: 'Naan', state: 'READY' })],
      }),
      ticket(2, {
        lines: [
          line(3, { name: 'Dal', state: 'PREPARING' }),
          line(4, { name: 'Tikka', variantName: 'Half' }),
        ],
      }),
      ticket(3, { kind: 'CANCELLED', lines: [line(5, { name: 'Dal', quantity: 5 })] }),
    ]);
    expect(summary).toEqual([
      { name: 'Dal', quantity: 3 },
      { name: 'Tikka (Half)', quantity: 1 },
    ]);
  });

  it('sounds only for tickets not seen before, never on the first read', () => {
    const first = [ticket(1)];
    expect(arrivals(undefined, first)).toEqual({ newTickets: 0, changes: 0 });
    const known = new Set([ticket(1).kotId, ticket(9).kotId]);
    expect(
      arrivals(known, [ticket(1), ticket(2), ticket(3, { kind: 'CANCELLED' }), ticket(9)]),
    ).toEqual({
      newTickets: 1,
      changes: 1,
    });
  });
});
