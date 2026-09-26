import { describe, expect, it } from 'vitest';
import {
  addDays,
  businessDateOf,
  businessDayStart,
  calendarDateOf,
  cutoffChangeMovesBusinessDate,
  DEFAULT_INVOICE_SERIES,
  financialYearFromStart,
  financialYearOf,
  formatInvoiceNumber,
  maxSequenceFor,
  nextBusinessDayStart,
  parseCutoff,
  parseIsoDate,
  sequenceDigitsAvailable,
  validateInvoiceSeries,
  zonedTimeToUtc,
} from '../src/index.js';

describe('[ONB-004] business date with cut-off (BRD §9.4)', () => {
  it('assigns after-midnight service to the previous business date', () => {
    // 01:30 IST on 26 Sep
    expect(businessDateOf(new Date('2026-09-25T20:00:00Z'))).toBe('2026-09-25');
    // 03:59 IST
    expect(businessDateOf(new Date('2026-09-25T22:29:00Z'))).toBe('2026-09-25');
    // 04:00 IST: new business day
    expect(businessDateOf(new Date('2026-09-25T22:30:00Z'))).toBe('2026-09-26');
    // 20:30 IST
    expect(businessDateOf(new Date('2026-09-25T15:00:00Z'))).toBe('2026-09-25');
  });

  it('supports a custom cut-off', () => {
    const config = { timeZone: 'Asia/Kolkata', cutoff: '00:00' };
    expect(businessDateOf(new Date('2026-09-25T20:00:00Z'), config)).toBe('2026-09-26');
  });

  it('gives calendar dates in IST', () => {
    expect(calendarDateOf(new Date('2026-09-25T20:00:00Z'))).toBe('2026-09-26');
  });

  it('converts local times to UTC instants', () => {
    expect(zonedTimeToUtc('2026-09-26', '04:00', 'Asia/Kolkata').toISOString()).toBe(
      '2026-09-25T22:30:00.000Z',
    );
    expect(zonedTimeToUtc('2026-07-01', '09:00', 'Europe/London').toISOString()).toBe(
      '2026-07-01T08:00:00.000Z',
    );
    expect(businessDayStart('2026-09-26').toISOString()).toBe('2026-09-25T22:30:00.000Z');
  });

  it('[LIC-005] finds the start of the next business day', () => {
    expect(nextBusinessDayStart(new Date('2026-09-25T15:00:00Z')).toISOString()).toBe(
      '2026-09-25T22:30:00.000Z',
    );
    // 02:00 IST on 26 Sep is still business date 25 Sep, so the next start is 04:00 on 26 Sep.
    expect(nextBusinessDayStart(new Date('2026-09-25T20:30:00Z')).toISOString()).toBe(
      '2026-09-25T22:30:00.000Z',
    );
  });

  it('adds days across month and leap-year boundaries', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('rejects invalid values', () => {
    expect(() => parseIsoDate('2026-02-30')).toThrow();
    expect(() => parseIsoDate('26-02-01')).toThrow();
    expect(() => parseCutoff('24:00')).toThrow();
    expect(() => parseCutoff('4:00')).toThrow();
    expect(() => businessDateOf(new Date('invalid'))).toThrow();
  });

  it('[NFR-L03] knows when a new cut-off would move the business date', () => {
    const threeAm = new Date('2026-09-25T21:30:00Z'); // 03:00 IST on 26 September
    // Before the 04:00 cut-off it is still the 25th; a 02:00 cut-off would make it the 26th.
    expect(cutoffChangeMovesBusinessDate(threeAm, '04:00', '02:00')).toBe(true);
    expect(cutoffChangeMovesBusinessDate(threeAm, '04:00', '05:00')).toBe(false);
    expect(cutoffChangeMovesBusinessDate(threeAm, '04:00', '03:01')).toBe(false);
    expect(cutoffChangeMovesBusinessDate(threeAm, '04:00', '03:00')).toBe(true);
    const tenAm = new Date('2026-09-26T04:30:00Z'); // 10:00 IST
    expect(cutoffChangeMovesBusinessDate(tenAm, '04:00', '11:00')).toBe(true);
    expect(cutoffChangeMovesBusinessDate(tenAm, '04:00', '06:00')).toBe(false);
    // In the afternoon every morning cut-off keeps the date.
    const threePm = new Date('2026-09-26T09:30:00Z');
    for (const cutoff of ['00:00', '02:00', '06:00', '11:59']) {
      expect(cutoffChangeMovesBusinessDate(threePm, '04:00', cutoff), cutoff).toBe(false);
    }
  });
});

describe('financial year (April to March)', () => {
  it('finds the financial year of a date', () => {
    expect(financialYearOf('2026-03-31').label).toBe('2025-26');
    const fy = financialYearOf('2026-04-01');
    expect(fy).toEqual({
      startYear: 2026,
      label: '2026-27',
      shortLabel: '26-27',
      startDate: '2026-04-01',
      endDate: '2027-03-31',
    });
    expect(financialYearFromStart(2099).shortLabel).toBe('99-00');
    expect(() => financialYearFromStart(1999)).toThrow();
  });
});

describe('[BILL-003] GST invoice numbering', () => {
  const fy = financialYearFromStart(2026);

  it('formats numbers within 16 characters', () => {
    expect(formatInvoiceNumber(DEFAULT_INVOICE_SERIES, fy, 123)).toBe('INV/26-27/000123');
    expect(formatInvoiceNumber(DEFAULT_INVOICE_SERIES, fy, 999_999)).toHaveLength(16);
    expect(
      formatInvoiceNumber(
        { prefix: '', includeFinancialYear: false, separator: '-', sequencePadding: 4 },
        fy,
        7,
      ),
    ).toBe('0007');
    expect(
      formatInvoiceNumber({ ...DEFAULT_INVOICE_SERIES, prefix: 'TA', separator: '-' }, fy, 42),
    ).toBe('TA-26-27-000042');
  });

  it('refuses numbers GST would reject', () => {
    expect(() => formatInvoiceNumber(DEFAULT_INVOICE_SERIES, fy, 1_000_000)).toThrow(
      /16 characters/,
    );
    expect(() => formatInvoiceNumber({ ...DEFAULT_INVOICE_SERIES, prefix: 'IN V' }, fy, 1)).toThrow(
      /characters/,
    );
    expect(() => formatInvoiceNumber(DEFAULT_INVOICE_SERIES, fy, 0)).toThrow();
  });

  it('reports capacity and validates series settings', () => {
    expect(sequenceDigitsAvailable(DEFAULT_INVOICE_SERIES)).toBe(6);
    expect(maxSequenceFor(DEFAULT_INVOICE_SERIES)).toBe(999_999);
    expect(
      maxSequenceFor({
        prefix: 'ABCDEFGHIJ',
        includeFinancialYear: true,
        separator: '/',
        sequencePadding: 1,
      }),
    ).toBe(0);
    expect(validateInvoiceSeries(DEFAULT_INVOICE_SERIES)).toEqual([]);
    expect(
      validateInvoiceSeries({ ...DEFAULT_INVOICE_SERIES, prefix: 'RESTAURANT' }).length,
    ).toBeGreaterThan(0);
    expect(validateInvoiceSeries({ ...DEFAULT_INVOICE_SERIES, prefix: 'A/B' })).toContain(
      'Prefix may contain only letters and digits',
    );
    expect(validateInvoiceSeries({ ...DEFAULT_INVOICE_SERIES, sequencePadding: 0 })).toContain(
      'Sequence padding must be at least 1',
    );
  });
});
