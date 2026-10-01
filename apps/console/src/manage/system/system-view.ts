/**
 * The System page (P4-04): sizes and durations as people read them. Sizes use the units Windows
 * shows (1 KB = 1,024 bytes), so they match what the Owner sees in Explorer.
 */

export const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
export type ByteUnit = (typeof BYTE_UNITS)[number];

/** A size in its largest unit, with one decimal below 10 ("4.2 GB", "120 GB", "512 B"). */
export function bytesParts(bytes: number): { readonly value: string; readonly unit: ByteUnit } {
  let value = Math.max(0, bytes);
  let index = 0;
  while (value >= 1_024 && index < BYTE_UNITS.length - 1) {
    value /= 1_024;
    index += 1;
  }
  const unit = BYTE_UNITS[index] ?? 'B';
  const text = index === 0 || value >= 10 ? String(Math.round(value)) : value.toFixed(1);
  return { value: text.replace(/\.0$/, ''), unit };
}

/** Uptime as days and hours, hours and minutes, or minutes. */
export function uptimeParts(
  seconds: number,
):
  | { readonly kind: 'days'; readonly days: number; readonly hours: number }
  | { readonly kind: 'hours'; readonly hours: number; readonly minutes: number }
  | { readonly kind: 'minutes'; readonly minutes: number } {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return { kind: 'days', days, hours: hours % 24 };
  if (hours > 0) return { kind: 'hours', hours, minutes: minutes % 60 };
  return { kind: 'minutes', minutes };
}
