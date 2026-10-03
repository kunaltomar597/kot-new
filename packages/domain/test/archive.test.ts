import { describe, expect, it } from 'vitest';
import {
  financialYearOfLabel,
  purgeableYears,
  statutoryRetentionEnd,
  withinStatutoryPeriod,
} from '../src/archive.js';
import { financialYearFromStart } from '../src/business-date.js';

describe('[DATA-008] which years may be archived and purged', () => {
  it('keeps GST records 72 months from the annual return’s due date (BRD §12)', () => {
    // FY 2019-20 ends 31 March 2020; its annual return is due 31 December 2020.
    const year = financialYearFromStart(2019);
    expect(statutoryRetentionEnd(year)).toBe('2026-12-31');
    expect(withinStatutoryPeriod(year, '2026-12-31')).toBe(true);
    expect(withinStatutoryPeriod(year, '2027-01-01')).toBe(false);
  });

  it('offers each whole year that has ended, oldest first, from the oldest record', () => {
    expect(
      purgeableYears({ oldestRecordDate: '2022-08-15', today: '2026-10-03' }).map((y) => y.label),
    ).toEqual(['2022-23', '2023-24', '2024-25', '2025-26']);
    // The current year never.
    expect(purgeableYears({ oldestRecordDate: '2026-04-02', today: '2026-10-03' })).toEqual([]);
    expect(purgeableYears({ oldestRecordDate: null, today: '2026-10-03' })).toEqual([]);
  });

  it('reads a year as people write it', () => {
    expect(financialYearOfLabel('2023-24')).toMatchObject({
      startDate: '2023-04-01',
      endDate: '2024-03-31',
    });
    expect(() => financialYearOfLabel('2023-25')).toThrow(/not a financial year/);
    expect(() => financialYearOfLabel('23-24')).toThrow(/not a financial year/);
  });
});
