import { addDays, formatRupees, type IsoDate, parseIsoDate } from '@rp/domain';
import type { Translator } from '@rp/i18n';

/**
 * The Reports area (P4-05d, RPT-016): the range every report shares, and figures as people read
 * them (rupees from paise, percent from basis points, durations from seconds).
 */

export interface ReportRange {
  readonly from: IsoDate;
  readonly to: IsoDate;
}

export const RANGE_PRESETS = ['today', 'yesterday', 'last7', 'thisMonth', 'lastMonth'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

/** The longest range a report takes (the server refuses more). */
export const MAX_RANGE_DAYS = 366;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A preset's range, counted from today's business date. */
export function presetRange(preset: RangePreset, today: IsoDate): ReportRange {
  const { year, month } = parseIsoDate(today);
  const monthStart = `${String(year)}-${String(month).padStart(2, '0')}-01`;
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const yesterday = addDays(today, -1);
      return { from: yesterday, to: yesterday };
    }
    case 'last7':
      return { from: addDays(today, -6), to: today };
    case 'thisMonth':
      return { from: monthStart, to: today };
    case 'lastMonth': {
      const lastMonthEnd = addDays(monthStart, -1);
      return { from: `${lastMonthEnd.slice(0, 8)}01`, to: lastMonthEnd };
    }
  }
}

/** The preset a range is, if any. */
export function presetOf(range: ReportRange, today: IsoDate): RangePreset | undefined {
  return RANGE_PRESETS.find((preset) => {
    const candidate = presetRange(preset, today);
    return candidate.from === range.from && candidate.to === range.to;
  });
}

/** Days from `from` to `to`, both included. */
export function daysIn(range: ReportRange): number {
  return Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1;
}

export type RangeProblem = 'DATES_REQUIRED' | 'FROM_AFTER_TO' | 'TOO_LONG';

export function checkRange(range: { from: string; to: string }): RangeProblem | undefined {
  if (!DATE.test(range.from) || !DATE.test(range.to)) return 'DATES_REQUIRED';
  if (range.from > range.to) return 'FROM_AFTER_TO';
  return daysIn(range) > MAX_RANGE_DAYS ? 'TOO_LONG' : undefined;
}

/** The range in a page address (`?from=…&to=…`), or today when it has none that works. */
export function rangeFromSearch(search: URLSearchParams, today: IsoDate): ReportRange {
  const range = { from: search.get('from') ?? '', to: search.get('to') ?? '' };
  return checkRange(range) === undefined ? range : { from: today, to: today };
}

/** Paise as rupees with the symbol and Indian grouping: 123456 → "₹1,234.56". */
export function rupees(paise: number): string {
  return formatRupees(paise);
}

/** Basis points as a percent with up to one decimal: 2500 → "25%", 3333 → "33.3%". */
export function percent(bp: number): string {
  const tenths = Math.round(bp / 10);
  const whole = Math.trunc(tenths / 10);
  const rest = Math.abs(tenths % 10);
  return rest === 0 ? `${String(whole)}%` : `${String(whole)}.${String(rest)}%`;
}

/** Seconds as minutes and seconds: 75 → "1 min 15 s", 3600 → "60 min", 40 → "40 s". */
export function duration(seconds: number, t: Translator): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return t('reportsPage.duration.seconds', { seconds: rest });
  return rest === 0
    ? t('reportsPage.duration.minutes', { minutes })
    : t('reportsPage.duration.minutesSeconds', { minutes, seconds: rest });
}

/** Rupees for a chart axis: whole rupees, thousands and lakhs shortened ("₹12k", "₹1.5L"). */
export function axisRupees(paise: number, t: Translator): string {
  const value = paise / 100;
  if (Math.abs(value) >= 100_000)
    return t('reportsPage.axis.lakh', { value: trimmed(value / 100_000) });
  if (Math.abs(value) >= 1_000)
    return t('reportsPage.axis.thousand', { value: trimmed(value / 1_000) });
  return t('reportsPage.axis.rupees', { value: String(Math.round(value)) });
}

function trimmed(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
}

/** "01 Oct" for a chart axis. */
export function shortDate(date: IsoDate, t: Translator): string {
  const { month, day } = parseIsoDate(date);
  return t('reportsPage.shortDate', {
    day: String(day).padStart(2, '0'),
    month: t(`reportsPage.month.m${String(month)}` as 'reportsPage.month.m1'),
  });
}
