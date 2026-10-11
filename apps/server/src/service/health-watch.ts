/**
 * When the service host gives up on a running server and starts it again (NFR-A04, P0-16b). Pure:
 * the host feeds it each health probe and asks for a verdict.
 *
 * - A server that answered and then stops answering is hung (its event loop is stuck, or it is
 *   wedged some other way): it is ended and started again.
 * - A server that never answers after starting is given longer (the first start makes the LAN
 *   certificate and connects everything).
 * - A server that answers 503 (its database is down) is left alone for longer still: the watchdog
 *   starts the database service, and the server reconnects by itself. Only if that does not happen
 *   is it started again.
 */

export type ProbeResult = 'ok' | 'degraded' | 'unanswered';

export interface HealthLimits {
  /** No answer for this long after the last one: hung. */
  readonly hungAfterMs: number;
  /** No first answer for this long after the start: hung. */
  readonly startupGraceMs: number;
  /** Answering 503 for this long: started again. */
  readonly degradedAfterMs: number;
}

export const DEFAULT_HEALTH_LIMITS: HealthLimits = {
  hungAfterMs: 20_000,
  startupGraceMs: 60_000,
  degradedAfterMs: 120_000,
};

export type HealthVerdict =
  | { readonly kind: 'starting' | 'healthy' | 'degraded' }
  | { readonly kind: 'restart'; readonly reason: string };

export class HealthWatch {
  private lastAnsweredAt: number | undefined;
  private degradedSince: number | undefined;
  private healthySince: number | undefined;

  constructor(
    private readonly startedAt: number,
    private readonly limits: HealthLimits = DEFAULT_HEALTH_LIMITS,
  ) {}

  record(result: ProbeResult, at: number): void {
    if (result === 'unanswered') return;
    this.lastAnsweredAt = at;
    if (result === 'ok') {
      this.degradedSince = undefined;
      this.healthySince ??= at;
    } else {
      this.degradedSince ??= at;
      this.healthySince = undefined;
    }
  }

  /** How long it has answered "ok" without a break; 0 when it has not. */
  healthyFor(now: number): number {
    return this.healthySince === undefined ? 0 : now - this.healthySince;
  }

  verdict(now: number): HealthVerdict {
    const seconds = (ms: number) => String(Math.round(ms / 1000));
    if (this.lastAnsweredAt === undefined) {
      return now - this.startedAt > this.limits.startupGraceMs
        ? {
            kind: 'restart',
            reason: `no answer within ${seconds(this.limits.startupGraceMs)} s of starting`,
          }
        : { kind: 'starting' };
    }
    if (now - this.lastAnsweredAt > this.limits.hungAfterMs) {
      return {
        kind: 'restart',
        reason: `no answer for ${seconds(now - this.lastAnsweredAt)} s`,
      };
    }
    if (this.degradedSince !== undefined) {
      return now - this.degradedSince > this.limits.degradedAfterMs
        ? {
            kind: 'restart',
            reason: `database unavailable for ${seconds(now - this.degradedSince)} s`,
          }
        : { kind: 'degraded' };
    }
    return { kind: 'healthy' };
  }
}

/**
 * The wait before starting a server that ended on its own: at once the first time, then longer,
 * never more than 5 s, so a crash is always recovered within the 10 s of NFR-A04.
 */
export function restartDelayMs(consecutiveFailures: number): number {
  const delays = [500, 1_000, 2_000, 4_000];
  return delays[Math.max(0, consecutiveFailures - 1)] ?? 5_000;
}

/** A server that has been healthy this long has recovered: its next end counts from one again. */
export const RECOVERED_AFTER_MS = 60_000;
