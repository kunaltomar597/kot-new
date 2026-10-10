/**
 * Clock-rollback detection (LIC-007): the licence is judged by a time that never goes back and
 * moves on while the server runs, whatever the PC's clock says. A clock set back noticeably, held
 * back behind the time judged, or far from the Control Plane's, is a tamper event to report.
 */

/** A clock set back by more than this is reported; a few minutes are NTP corrections. */
export const CLOCK_ROLLBACK_TOLERANCE_MS = 5 * 60 * 1_000;
/**
 * A clock this far behind the time judged is reported as held back. Larger than the rollback
 * tolerance: the server's monotonic clock and an NTP-disciplined wall clock drift apart by a few
 * seconds a day at most, so only a clock kept back on purpose gets this far behind.
 */
export const CLOCK_HELD_BACK_TOLERANCE_MS = 60 * 60 * 1_000;
/** A clock further than this from the Control Plane's is reported. */
export const CLOCK_SKEW_TOLERANCE_MS = 10 * 60 * 1_000;

export interface ClockReading {
  /** The PC's clock now. */
  readonly clock: Date;
  /** What the last check recorded (sealed): the time it judged by and the clock it read. */
  readonly last?: { readonly judged: Date; readonly clock: Date } | undefined;
  /**
   * How long the server has run since that check, by a monotonic clock that no one can set;
   * undefined when it was not this run of the server (it restarted since).
   */
  readonly elapsedMs?: number | undefined;
  /**
   * Times known to have passed, which the vendor signed: the issue time of the licence held and of
   * the newest accepted. The judged time never falls behind them. (A heartbeat answer's server
   * time is not signed, so it is never one: a wrong one could push the PC's time years ahead.)
   */
  readonly floors?: readonly (Date | undefined)[];
}

/**
 * The time to judge the licence by, and whether the clock was set back (LIC-007): the latest of
 * the clock, the last judged time moved on by the time the server has run since, and the floors.
 * So a clock set back, or held back while the server runs, never holds the licence's end off;
 * only while the server is stopped does the judged time stand still.
 */
export function guardedNow(reading: ClockReading): {
  readonly now: Date;
  readonly rolledBack: boolean;
} {
  const { clock, last } = reading;
  const elapsed = Math.max(0, reading.elapsedMs ?? 0);
  const candidates = [
    clock.getTime(),
    ...(last === undefined ? [] : [last.judged.getTime() + elapsed]),
    ...(reading.floors ?? []).flatMap((floor) => (floor === undefined ? [] : [floor.getTime()])),
  ];
  const now = Math.max(...candidates);
  // Set back: behind where the last clock reading says it should be by now. Held back: far
  // behind the time judged (each minute's step is small, but they add up).
  const setBack =
    last !== undefined &&
    last.clock.getTime() + elapsed - clock.getTime() > CLOCK_ROLLBACK_TOLERANCE_MS;
  const heldBack = now - clock.getTime() > CLOCK_HELD_BACK_TOLERANCE_MS;
  return { now: new Date(now), rolledBack: setBack || heldBack };
}

/** Whether the PC's clock is far from the Control Plane's (from a heartbeat's answer). */
export function clockSkewed(local: Date, controlPlane: Date): boolean {
  return Math.abs(local.getTime() - controlPlane.getTime()) > CLOCK_SKEW_TOLERANCE_MS;
}
