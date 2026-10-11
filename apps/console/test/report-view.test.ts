import { describe, expect, it } from 'vitest';
import {
  axisRupees,
  checkRange,
  daysIn,
  duration,
  flagFigure,
  flagSubject,
  percent,
  presetOf,
  presetRange,
  rangeFromSearch,
  shortDate,
} from '../src/manage/reports/report-view.js';
import { t } from './harness.js';

describe('[RPT-016] the range every report shares', () => {
  it('works out the presets from today’s business date', () => {
    expect(presetRange('today', '2026-10-01')).toEqual({ from: '2026-10-01', to: '2026-10-01' });
    expect(presetRange('yesterday', '2026-10-01')).toEqual({
      from: '2026-09-30',
      to: '2026-09-30',
    });
    expect(presetRange('last7', '2026-10-01')).toEqual({ from: '2026-09-25', to: '2026-10-01' });
    expect(presetRange('thisMonth', '2026-10-15')).toEqual({
      from: '2026-10-01',
      to: '2026-10-15',
    });
    expect(presetRange('lastMonth', '2026-03-10')).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
    expect(presetRange('lastMonth', '2026-01-05')).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
    expect(presetOf({ from: '2026-09-25', to: '2026-10-01' }, '2026-10-01')).toBe('last7');
    expect(presetOf({ from: '2026-09-01', to: '2026-09-10' }, '2026-10-01')).toBeUndefined();
  });

  it('takes a range from the address, or today when it is not one the server takes', () => {
    const today = '2026-10-01';
    expect(rangeFromSearch(new URLSearchParams('from=2026-09-01&to=2026-09-30'), today)).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(rangeFromSearch(new URLSearchParams('from=2026-09-30&to=2026-09-01'), today)).toEqual({
      from: today,
      to: today,
    });
    expect(rangeFromSearch(new URLSearchParams(''), today)).toEqual({ from: today, to: today });
    expect(checkRange({ from: '2025-01-01', to: '2026-01-02' })).toBe('TOO_LONG');
    expect(checkRange({ from: '2025-01-02', to: '2026-01-02' })).toBeUndefined();
    expect(checkRange({ from: '', to: '2026-01-02' })).toBe('DATES_REQUIRED');
    expect(daysIn({ from: '2026-09-25', to: '2026-10-01' })).toBe(7);
  });
});

describe('[RPT-016] figures as people read them', () => {
  it('shows percent, durations, axis rupees and short dates', () => {
    expect(percent(2_500)).toBe('25%');
    expect(percent(3_333)).toBe('33.3%');
    expect(duration(40, t)).toBe('40 s');
    expect(duration(75, t)).toBe('1 min 15 s');
    expect(duration(3_600, t)).toBe('60 min');
    expect(axisRupees(50_000, t)).toBe('₹500');
    expect(axisRupees(1_250_000, t)).toBe('₹13k');
    expect(axisRupees(250_000, t)).toBe('₹2.5k');
    expect(axisRupees(15_000_000, t)).toBe('₹1.5L');
    expect(shortDate('2026-10-01', t)).toBe('01 Oct');
  });
});

describe('[RPT-014] what a suspicious-activity flag is about', () => {
  const flag = {
    flagId: 'x',
    at: '2026-10-01T10:00:00.000Z',
    businessDate: '2026-10-01',
    by: null,
    approvedBy: null,
    alsoBy: [],
    reason: null,
    orderId: null,
    invoiceId: null,
    invoiceNumber: null,
    kotNumber: null,
    item: null,
    quantity: null,
    amount: null,
    rateBp: null,
    count: null,
  };

  it('names the dish with its bill or ticket, the bill, the ticket, the shift or the drawer', () => {
    expect(
      flagSubject(
        { ...flag, kind: 'VOID_AFTER_PRINT', item: 'Water', quantity: 2, invoiceNumber: 'INV/1' },
        t,
      ),
    ).toBe('Water × 2, bill INV/1');
    expect(flagSubject({ ...flag, kind: 'VOID_AFTER_PRINT', invoiceNumber: 'INV/2' }, t)).toBe(
      'Bill INV/2',
    );
    expect(
      flagSubject(
        { ...flag, kind: 'SENT_NOT_BILLED', item: 'Lassi', quantity: 1, kotNumber: 4 },
        t,
      ),
    ).toBe('Lassi × 1, KOT 4');
    expect(flagSubject({ ...flag, kind: 'REPEATED_REPRINT', kotNumber: 9 }, t)).toBe('KOT 9');
    expect(flagSubject({ ...flag, kind: 'DISCOUNT_OVER_LIMIT', invoiceNumber: 'INV/3' }, t)).toBe(
      'Whole bill INV/3',
    );
    expect(flagSubject({ ...flag, kind: 'CASH_VARIANCE' }, t)).toBe('Shift close');
    expect(flagSubject({ ...flag, kind: 'NO_SALE_DRAWER' }, t)).toBe('Cash drawer');
  });

  it('gives the money, the rate or how often', () => {
    expect(flagFigure({ ...flag, kind: 'CASH_VARIANCE', amount: -50_000 }, t)).toBe('-₹500.00');
    expect(
      flagFigure({ ...flag, kind: 'DISCOUNT_OVER_LIMIT', rateBp: 3_000, amount: 4_800 }, t),
    ).toBe('30% · ₹48.00');
    expect(flagFigure({ ...flag, kind: 'REPEATED_REPRINT', count: 3 }, t)).toBe('3 times');
    expect(flagFigure({ ...flag, kind: 'NO_SALE_DRAWER' }, t)).toBe('–');
  });
});
