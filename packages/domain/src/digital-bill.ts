/**
 * Digital bills (BILL-011, BILL-012, P7-09): the diner's number as the provider needs it, the
 * number as staff and the vendor may see it, and when a bill that could not be sent is tried
 * again.
 */

/**
 * An Indian mobile number as +91 and ten digits, from the ways people write it ("98765 43210",
 * "+91-98765-43210", "098765 43210"); undefined when it is not one (landlines, other countries).
 */
export function indianMobile(text: string): string | undefined {
  let digits = text.replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(digits)) return undefined;
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.startsWith('+')) return undefined;
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : undefined;
}

/** A number with all but its last four digits hidden: `+91 ******3210`. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  const last = digits.slice(-4);
  const country = phone.startsWith('+91') ? '+91 ' : '';
  const hidden = Math.max(0, digits.length - (country === '' ? 0 : 2) - last.length);
  return `${country}${'*'.repeat(hidden)}${last}`;
}

/** Minutes to wait after each failed try: 1, 5, 15, 60, then every 3 hours. */
const RETRY_MINUTES = [1, 5, 15, 60, 180] as const;

/** How long a bill waits for the internet (or the vendor) before it is given up. */
export const DIGITAL_BILL_GIVE_UP_HOURS = 24;

/**
 * When to try a bill again after `attempts` failed tries, or undefined once it has waited
 * `DIGITAL_BILL_GIVE_UP_HOURS` since it was queued.
 */
export function nextDigitalBillAttempt(
  queuedAt: Date,
  attempts: number,
  now: Date,
): Date | undefined {
  const minutes = RETRY_MINUTES[Math.min(attempts, RETRY_MINUTES.length) - 1] ?? RETRY_MINUTES[0];
  const next = new Date(now.getTime() + minutes * 60_000);
  const deadline = queuedAt.getTime() + DIGITAL_BILL_GIVE_UP_HOURS * 3_600_000;
  return next.getTime() > deadline ? undefined : next;
}
