/**
 * The automatic retention of BRD §9.3 (DATA-007, DATA-011, P7-06a): when each kind of data is old
 * enough to be removed or anonymised. Pure; the server applies it once a day.
 */

const DAY_MS = 24 * 60 * 60_000;

/** The same moment `months` calendar months earlier (the last day of a shorter month). */
export function monthsBefore(now: Date, months: number): Date {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() - months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(now.getUTCDate(), lastDay),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  );
}

export interface RetentionSettings {
  /** `retention.operationalDays` (90): alerts, service requests, notices, logs, temporary files. */
  readonly operationalDays: number;
  /** `retention.dinerContactMonths` (24): a diner's number without a visit. */
  readonly dinerContactMonths: number;
  /** `retention.feedbackMonths` (24): feedback comments. */
  readonly feedbackMonths: number;
}

export interface RetentionCutoffs {
  /** Operational data last changed before this is removed. */
  readonly operationalBefore: Date;
  /** A diner whose last visit was before this is anonymised. */
  readonly dinerContactsBefore: Date;
  /** Feedback given before this loses its comment and its diner. */
  readonly feedbackBefore: Date;
}

export function retentionCutoffs(now: Date, settings: RetentionSettings): RetentionCutoffs {
  return {
    operationalBefore: new Date(now.getTime() - settings.operationalDays * DAY_MS),
    dinerContactsBefore: monthsBefore(now, settings.dinerContactMonths),
    feedbackBefore: monthsBefore(now, settings.feedbackMonths),
  };
}

/** A diner's last visit: when they gave their number, or their latest feedback after it. */
export function lastVisitOf(consentGivenAt: Date, feedbackAt: readonly Date[]): Date {
  return feedbackAt.reduce(
    (latest, at) => (at.getTime() > latest.getTime() ? at : latest),
    consentGivenAt,
  );
}
