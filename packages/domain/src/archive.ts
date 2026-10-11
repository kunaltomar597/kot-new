import {
  type FinancialYear,
  financialYearFromStart,
  financialYearOf,
  type IsoDate,
} from './business-date.js';
import { DomainError } from './errors.js';

/**
 * Archive-then-purge (DATA-008, P7-06b): which financial years may be archived and purged, and
 * whether a year is still within the statutory retention period (BRD §12: GST records are kept
 * 72 months from the due date of the year's annual return, 31 December after the year ends).
 */

/** The last day GST law asks the year's records to be kept (the restaurant keeps the archive). */
export function statutoryRetentionEnd(year: FinancialYear): IsoDate {
  return `${String(year.startYear + 7)}-12-31`;
}

export function withinStatutoryPeriod(year: FinancialYear, today: IsoDate): boolean {
  return today <= statutoryRetentionEnd(year);
}

/**
 * The years that may be archived and purged now, oldest first: each whole year that has ended,
 * from the oldest still holding records. Years go oldest first, so what stays is always a
 * contiguous stretch (the audit chain keeps its tail).
 */
export function purgeableYears(input: {
  /** The business date of the oldest record still in the database; null when there is none. */
  readonly oldestRecordDate: IsoDate | null;
  readonly today: IsoDate;
}): FinancialYear[] {
  if (input.oldestRecordDate === null) return [];
  const current = financialYearOf(input.today);
  const years: FinancialYear[] = [];
  for (
    let start = financialYearOf(input.oldestRecordDate).startYear;
    start < current.startYear;
    start += 1
  ) {
    years.push(financialYearFromStart(start));
  }
  return years;
}

/** "2023-24" as a financial year; throws when it is not one. */
export function financialYearOfLabel(label: string): FinancialYear {
  const match = /^(\d{4})-(\d{2})$/.exec(label);
  const year = match?.[1] === undefined ? undefined : financialYearFromStart(Number(match[1]));
  if (year?.label !== label) {
    throw new DomainError('INVALID_DATE', `"${label}" is not a financial year like 2023-24`, {
      label,
    });
  }
  return year;
}
