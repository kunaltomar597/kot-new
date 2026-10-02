/**
 * Clock-rollback detection (LIC-007): the licence is judged by a time that never goes back, the
 * clock or the last time seen, whichever is later; a clock set back noticeably, or far from the
 * Control Plane's, is a tamper event to report.
 */

/** A clock set back by more than this is reported; a few minutes are NTP corrections. */
export const CLOCK_ROLLBACK_TOLERANCE_MS = 5 * 60 * 1_000;
/** A clock further than this from the Control Plane's is reported. */
export const CLOCK_SKEW_TOLERANCE_MS = 10 * 60 * 1_000;

/** The time to judge the licence by, and whether the clock was set back. */
export function guardedNow(
  clock: Date,
  lastSeen: Date | undefined,
): { readonly now: Date; readonly rolledBack: boolean } {
  if (lastSeen === undefined) return { now: clock, rolledBack: false };
  return {
    now: new Date(Math.max(clock.getTime(), lastSeen.getTime())),
    rolledBack: lastSeen.getTime() - clock.getTime() > CLOCK_ROLLBACK_TOLERANCE_MS,
  };
}

/** Whether the PC's clock is far from the Control Plane's (from a heartbeat's answer). */
export function clockSkewed(local: Date, controlPlane: Date): boolean {
  return Math.abs(local.getTime() - controlPlane.getTime()) > CLOCK_SKEW_TOLERANCE_MS;
}
