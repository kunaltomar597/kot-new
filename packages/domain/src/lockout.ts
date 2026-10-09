/**
 * Counting wrong secrets (AUTH-003): a person's PIN or password, and every wrong one typed on a
 * device (PC-S5). Failures count within a window from the first; at the limit the count starts
 * again and the lock begins.
 */

export interface LockoutPolicy {
  /** Wrong secrets within the window that lock. */
  readonly maxFailures: number;
  readonly windowMinutes: number;
  /** How long the lock lasts unless a manager lifts it. */
  readonly lockMinutes: number;
}

/** The count kept with a credential or a device. */
export interface FailureCount {
  readonly failures: number;
  readonly windowStartedAt: Date | null;
}

export interface CountedFailure extends FailureCount {
  /** Set when this failure reached the limit: locked until then. */
  readonly lockedUntil: Date | null;
  /** Wrong secrets still allowed before the lock; 0 once it is locked. */
  readonly left: number;
}

/** One more wrong secret at `now`: within the window it adds up, after it a new window starts. */
export function countFailure(
  count: FailureCount,
  now: Date,
  policy: LockoutPolicy,
): CountedFailure {
  const inWindow =
    count.windowStartedAt !== null &&
    now.getTime() - count.windowStartedAt.getTime() < policy.windowMinutes * 60_000;
  const failures = inWindow ? count.failures + 1 : 1;
  if (failures >= policy.maxFailures) {
    return {
      failures: 0,
      windowStartedAt: null,
      lockedUntil: new Date(now.getTime() + policy.lockMinutes * 60_000),
      left: 0,
    };
  }
  return {
    failures,
    windowStartedAt: inWindow ? count.windowStartedAt : now,
    lockedUntil: null,
    left: policy.maxFailures - failures,
  };
}

/** Whether a lock still holds at `now`. */
export function isLockedAt(lockedUntil: Date | null, now: Date): boolean {
  return lockedUntil !== null && lockedUntil > now;
}
