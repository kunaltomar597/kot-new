import { displayDateTime, formatDisplayDate, type IsoDate } from '@rp/domain';

/** An instant as vendor staff in India read it: DD-MM-YYYY HH:MM, IST (NFR-L03). */
export function when(iso: string): string {
  const { date, time } = displayDateTime(new Date(iso));
  return `${date} ${time}`;
}

/** An instant, or a dash when there is none. */
export function whenOrDash(iso: string | null): string {
  return iso === null ? '—' : when(iso);
}

/** A calendar date as DD-MM-YYYY. */
export function day(date: IsoDate): string {
  return formatDisplayDate(date);
}
