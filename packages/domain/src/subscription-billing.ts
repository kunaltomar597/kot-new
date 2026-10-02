import { addDays, type IsoDate } from './business-date.js';
import type { LicenseState } from './machines/license.js';

/**
 * The vendor's subscription billing (VCP-003, LIC-005, P7-02c): billing periods, how overdue an
 * invoice is, and the licence state that follows. Pure, so the Control Plane and its tests agree.
 */

/** `date` plus whole months, clamped to the month's last day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: IsoDate, months: number): IsoDate {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The period an invoice starting on `start` covers: `months` months, ending the day before. */
export function billingPeriod(start: IsoDate, months: number): { start: IsoDate; end: IsoDate } {
  return { start, end: addDays(addMonths(start, months), -1) };
}

/**
 * How far behind a restaurant is, from its oldest unpaid invoice (LIC-005): `NONE` when nothing is
 * past due, `DUE` once it is, `GRACE` once it is more than `graceAfterDays` past due.
 */
export type OverdueStage = 'NONE' | 'DUE' | 'GRACE';

export function overdueStage(
  oldestUnpaidDueOn: IsoDate | undefined,
  today: IsoDate,
  graceAfterDays: number,
): OverdueStage {
  if (oldestUnpaidDueOn === undefined) return 'NONE';
  const overdue = daysBetween(oldestUnpaidDueOn, today);
  if (overdue <= 0) return 'NONE';
  return overdue > graceAfterDays ? 'GRACE' : 'DUE';
}

/**
 * The licence state billing moves an installation to next, or undefined to leave it (LIC-005):
 * payment due, then grace, then restricted when grace is over; back to active once nothing is
 * overdue, or once only an invoice just past due is left (then on to payment due: apply until it
 * settles). Only from a state billing set itself, never over a vendor's own decision. A
 * terminated contract stays terminated.
 */
export function billingLicenceState(input: {
  readonly current: LicenseState;
  /** Whether billing set the current state (not a person). */
  readonly setByBilling: boolean;
  readonly stage: OverdueStage;
  /** The grace days of the licence are over. */
  readonly graceOver: boolean;
}): LicenseState | undefined {
  const { current, setByBilling, stage, graceOver } = input;
  if (current === 'TERMINATED') return undefined;
  if (stage === 'NONE') {
    return setByBilling && current !== 'ACTIVE' ? 'ACTIVE' : undefined;
  }
  // A vendor's own restriction or grace is left as it is.
  if (!setByBilling && current !== 'ACTIVE' && current !== 'PAYMENT_DUE') return undefined;
  // Paid down to an invoice only just past due: billing's grace or restriction is lifted (the
  // next step takes it to payment due; LIC-005 goes back to active on a payment).
  if (stage === 'DUE' && (current === 'GRACE' || current === 'RESTRICTED')) return 'ACTIVE';
  if (current === 'GRACE') return graceOver ? 'RESTRICTED' : undefined;
  if (current === 'RESTRICTED') return undefined;
  if (stage === 'GRACE') return 'GRACE';
  return current === 'ACTIVE' ? 'PAYMENT_DUE' : undefined;
}
