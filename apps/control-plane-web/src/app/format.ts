import {
  displayDateTime,
  formatDisplayDate,
  formatRupees,
  type IsoDate,
  parseRupees,
} from '@rp/domain';

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

/** Paise as rupees, Indian grouping: ₹2,499.00 (BRD §9.4: money is integer paise). */
export function rupees(paise: number): string {
  return formatRupees(paise);
}

/** A typed rupee amount as paise, or undefined when it is not one (empty text included). */
export function paiseOf(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  try {
    return parseRupees(text);
  } catch {
    return undefined;
  }
}

/** Paise as the text a rupee field starts with: "2499" or "2499.50". */
export function rupeeText(paise: number): string {
  return formatRupees(paise, { symbol: false }).replace(/,/g, '').replace(/\.00$/, '');
}
