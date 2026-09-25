import { DomainError } from './errors.js';

/** A calendar date as 'YYYY-MM-DD'. */
export type IsoDate = string;

/**
 * A restaurant's business day. Night service after midnight belongs to the previous business
 * date until the cut-off time (BRD §9.4, ONB-004 step 1, default 04:00 ⚙).
 */
export interface BusinessDayConfig {
  /** IANA time zone. v1 is India only, so this is Asia/Kolkata (NFR-L03). */
  readonly timeZone: string;
  /** Local cut-off time 'HH:MM', 24-hour. */
  readonly cutoff: string;
}

export const DEFAULT_TIME_ZONE = 'Asia/Kolkata';
export const DEFAULT_BUSINESS_DAY: BusinessDayConfig = {
  timeZone: DEFAULT_TIME_ZONE,
  cutoff: '04:00',
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface LocalDateTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function assertValidInstant(instant: Date): void {
  if (Number.isNaN(instant.getTime())) {
    throw new DomainError('INVALID_DATE', 'Invalid date/time value');
  }
}

/** The wall-clock date and time of `instant` in `timeZone`. */
export function toLocalDateTime(instant: Date, timeZone: string): LocalDateTime {
  assertValidInstant(instant);
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

export function parseCutoff(cutoff: string): { hour: number; minute: number } {
  const match = HH_MM.exec(cutoff);
  if (!match)
    throw new DomainError('INVALID_TIME', `"${cutoff}" is not a valid HH:MM time`, { cutoff });
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function parseIsoDate(date: IsoDate): { year: number; month: number; day: number } {
  const match = ISO_DATE.exec(date);
  if (!match) throw new DomainError('INVALID_DATE', `"${date}" is not a YYYY-MM-DD date`, { date });
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new DomainError('INVALID_DATE', `"${date}" is not a real calendar date`, { date });
  }
  return { year, month, day };
}

export function formatIsoDate(year: number, month: number, day: number): IsoDate {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Adds (or subtracts) whole days to a calendar date. */
export function addDays(date: IsoDate, days: number): IsoDate {
  const { year, month, day } = parseIsoDate(date);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return formatIsoDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** The calendar date of `instant` in `timeZone`. */
export function calendarDateOf(instant: Date, timeZone: string = DEFAULT_TIME_ZONE): IsoDate {
  const local = toLocalDateTime(instant, timeZone);
  return formatIsoDate(local.year, local.month, local.day);
}

/** The business date an event at `instant` belongs to. */
export function businessDateOf(
  instant: Date,
  config: BusinessDayConfig = DEFAULT_BUSINESS_DAY,
): IsoDate {
  const cutoff = parseCutoff(config.cutoff);
  const local = toLocalDateTime(instant, config.timeZone);
  const date = formatIsoDate(local.year, local.month, local.day);
  const beforeCutoff =
    local.hour < cutoff.hour || (local.hour === cutoff.hour && local.minute < cutoff.minute);
  return beforeCutoff ? addDays(date, -1) : date;
}

/**
 * Converts a local wall-clock time in `timeZone` to a UTC instant. Handles zones with
 * offset changes by re-checking the offset once; India has no DST, so this is exact there.
 */
export function zonedTimeToUtc(date: IsoDate, time: string, timeZone: string): Date {
  const { year, month, day } = parseIsoDate(date);
  const { hour, minute } = parseCutoff(time);
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (utcMillis: number): number => {
    const local = toLocalDateTime(new Date(utcMillis), timeZone);
    return (
      Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) -
      utcMillis
    );
  };
  const firstGuess = wallAsUtc - offsetAt(wallAsUtc);
  return new Date(wallAsUtc - offsetAt(firstGuess));
}

/** The instant a business date starts (its cut-off time on that calendar date). */
export function businessDayStart(
  businessDate: IsoDate,
  config: BusinessDayConfig = DEFAULT_BUSINESS_DAY,
): Date {
  return zonedTimeToUtc(businessDate, config.cutoff, config.timeZone);
}

/** The start of the next business day after `instant` (used by LIC-005 "next business day"). */
export function nextBusinessDayStart(
  instant: Date,
  config: BusinessDayConfig = DEFAULT_BUSINESS_DAY,
): Date {
  return businessDayStart(addDays(businessDateOf(instant, config), 1), config);
}

/** Indian financial year, 1 April to 31 March. */
export interface FinancialYear {
  /** Calendar year in which the financial year starts (FY 2026-27 → 2026). */
  readonly startYear: number;
  /** "2026-27" */
  readonly label: string;
  /** "26-27", compact form for invoice numbers. */
  readonly shortLabel: string;
  readonly startDate: IsoDate;
  readonly endDate: IsoDate;
}

export function financialYearFromStart(startYear: number): FinancialYear {
  if (!Number.isSafeInteger(startYear) || startYear < 2000 || startYear > 2998) {
    throw new DomainError('INVALID_DATE', 'Financial year start must be between 2000 and 2998', {
      startYear,
    });
  }
  const endShort = String((startYear + 1) % 100).padStart(2, '0');
  return {
    startYear,
    label: `${startYear}-${endShort}`,
    shortLabel: `${String(startYear % 100).padStart(2, '0')}-${endShort}`,
    startDate: formatIsoDate(startYear, 4, 1),
    endDate: formatIsoDate(startYear + 1, 3, 31),
  };
}

/** The financial year containing a calendar date. */
export function financialYearOf(date: IsoDate): FinancialYear {
  const { year, month } = parseIsoDate(date);
  return financialYearFromStart(month >= 4 ? year : year - 1);
}
