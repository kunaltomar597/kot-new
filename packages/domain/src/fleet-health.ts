import {
  addDays,
  calendarDateOf,
  type IsoDate,
  timeOfDayOf,
  zonedTimeToUtc,
} from './business-date.js';
import type { UpdateSigning } from './software-update.js';

/**
 * Fleet health (VCP-005, AUD-003, DATA-005, P7-03): when a restaurant is open, which alerts a PC's
 * latest report calls for, and whether its audit chain still agrees with the heads it reported
 * before. Pure, so the Control Plane and its tests agree.
 */

export const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Open on `day` from `start` to `end` ('HH:MM'); `end` before `start` runs past midnight. */
export interface OpeningWindow {
  readonly day: Weekday;
  readonly start: string;
  readonly end: string;
}

/** The weekday of a calendar date. */
export function weekdayOf(date: IsoDate): Weekday {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  // getUTCDay: 0 is Sunday.
  return WEEKDAYS[(new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7] ?? 'MON';
}

/**
 * When the opening window that `instant` falls in began, or null when the restaurant is closed
 * then. A window that runs past midnight counts on the next morning too. Where windows overlap,
 * the earliest start wins.
 */
export function openSince(
  instant: Date,
  hours: readonly OpeningWindow[],
  timeZone: string,
): Date | null {
  const today = calendarDateOf(instant, timeZone);
  const yesterday = addDays(today, -1);
  const time = timeOfDayOf(instant, timeZone);
  let since: Date | null = null;
  const consider = (date: IsoDate, start: string) => {
    const begin = zonedTimeToUtc(date, start, timeZone);
    if (since === null || begin < since) since = begin;
  };
  for (const window of hours) {
    const overnight = window.end < window.start;
    if (window.day === weekdayOf(today)) {
      const inside = overnight ? time >= window.start : time >= window.start && time < window.end;
      if (inside) consider(today, window.start);
    }
    if (overnight && window.day === weekdayOf(yesterday) && time < window.end) {
      consider(yesterday, window.start);
    }
  }
  return since;
}

export const FLEET_ALERT_KINDS = [
  'OFFLINE',
  'DISK_FULL',
  'BACKUP_FAILED',
  'AUDIT_CHAIN_MISMATCH',
  'UPDATE_FAILED',
  'LICENCE_TAMPERING',
  'UNSIGNED_UPDATES',
] as const;
export type FleetAlertKind = (typeof FLEET_ALERT_KINDS)[number];

/**
 * Alerts opened and closed from each heartbeat's state; a chain alert and a licence tampering
 * alert need a person. A failed update (P7-04a) is opened by the rollout and closes when the PC
 * runs that version or a newer one. A PC that takes unsigned updates closes its alert once it is
 * reinstalled with a signed build.
 */
export const SELF_RESOLVING_ALERTS: readonly FleetAlertKind[] = [
  'OFFLINE',
  'DISK_FULL',
  'BACKUP_FAILED',
  'UNSIGNED_UPDATES',
];

export interface FleetHealthInput {
  readonly now: Date;
  /** The last heartbeat received; null before the first. */
  readonly lastSeenAt: Date | null;
  /** VCP-005 ⚙: 30 minutes. */
  readonly offlineAfterMinutes: number;
  /**
   * The restaurant's opening hours as its PC last reported them. Null or empty (not set up, or a
   * PC older than P7-03): every hour counts, so a silent PC is never missed.
   */
  readonly businessHours: {
    readonly timeZone: string;
    readonly hours: readonly OpeningWindow[];
  } | null;
  readonly disk: { readonly totalBytes: number; readonly freeBytes: number } | null;
  /** VCP-005 ⚙: 90 %. */
  readonly diskAlertPercent: number;
  readonly backup: {
    readonly lastSuccessAt: string | null;
    readonly lastFailureAt: string | null;
  } | null;
  /** How the PC checks its updates (P8-03b3b); null from PCs that do not say. */
  readonly updateSigning: UpdateSigning | null;
}

/** How full a disk is, in whole per cent (rounded down, so 89.9 % is 89). */
export function diskUsedPercent(disk: { totalBytes: number; freeBytes: number }): number | null {
  if (disk.totalBytes <= 0) return null;
  return Math.floor(((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100);
}

/** Minutes the PC has been silent while the restaurant was open (VCP-005). */
export function offlineMinutesDuringHours(input: FleetHealthInput): number {
  if (input.lastSeenAt === null) return 0;
  const hours = input.businessHours;
  let from = input.lastSeenAt;
  if (hours !== null && hours.hours.length > 0) {
    const opened = openSince(input.now, hours.hours, hours.timeZone);
    if (opened === null) return 0;
    if (opened > from) from = opened;
  }
  return Math.max(0, Math.floor((input.now.getTime() - from.getTime()) / 60_000));
}

/**
 * The alerts a PC's state calls for now (VCP-005, DATA-005): offline more than the threshold
 * during business hours, the data drive past the threshold, the latest backup failed, a test
 * build that takes unsigned updates (UPD-007, threat model "The update pipeline", UPDATE-E3). The
 * audit chain is checked separately, as heartbeats arrive (`checkChainHead`).
 */
export function fleetAlertsDue(input: FleetHealthInput): Set<FleetAlertKind> {
  const due = new Set<FleetAlertKind>();
  if (offlineMinutesDuringHours(input) > input.offlineAfterMinutes) due.add('OFFLINE');
  const used = input.disk === null ? null : diskUsedPercent(input.disk);
  if (used !== null && used > input.diskAlertPercent) due.add('DISK_FULL');
  const backup = input.backup;
  if (
    backup !== null &&
    backup.lastFailureAt !== null &&
    (backup.lastSuccessAt === null ||
      Date.parse(backup.lastFailureAt) > Date.parse(backup.lastSuccessAt))
  ) {
    due.add('BACKUP_FAILED');
  }
  if (input.updateSigning === 'UNSIGNED') due.add('UNSIGNED_UPDATES');
  return due;
}

export interface ChainHead {
  readonly sequence: number;
  readonly hash: string;
}

export type ChainVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** ROLLED_BACK: entries vanished from the end; REWRITTEN: an entry's hash changed. */
      readonly reason: 'ROLLED_BACK' | 'REWRITTEN' | 'EMPTIED';
      readonly sequence: number;
    };

/**
 * Compares a reported chain head with the heads the PC reported before (AUD-003). The local log
 * only grows, so a head with a lower sequence than one seen, or a different hash at a sequence
 * seen, means the local database was changed. Purging old entries (P7-06) never moves the head.
 */
export function checkChainHead(
  known: readonly ChainHead[],
  reported: ChainHead | null,
): ChainVerdict {
  if (known.length === 0) return { ok: true };
  const latest = known.reduce((a, b) => (b.sequence > a.sequence ? b : a));
  if (reported === null) return { ok: false, reason: 'EMPTIED', sequence: latest.sequence };
  if (reported.sequence < latest.sequence) {
    return { ok: false, reason: 'ROLLED_BACK', sequence: reported.sequence };
  }
  const same = known.find((head) => head.sequence === reported.sequence);
  if (same !== undefined && same.hash !== reported.hash) {
    return { ok: false, reason: 'REWRITTEN', sequence: reported.sequence };
  }
  return { ok: true };
}

/** The PC's answer to "what is the hash of entry N?": null when it no longer has the entry. */
export interface ChainCheckpoint {
  readonly sequence: number;
  readonly hash: string | null;
  /** The oldest entry it still holds: entries before it were purged (P7-06). */
  readonly oldestSequence: number | null;
}

/**
 * Checks the PC's answer for an earlier head (AUD-003): rewriting an old entry changes every hash
 * after it, so the hash held for a sequence reported earlier must still be the same. An entry
 * archived and purged (P7-06) is not tampering; a missing one that was not purged is.
 */
export function checkCheckpoint(
  known: ChainHead,
  answer: ChainCheckpoint,
): ChainVerdict | 'PURGED' {
  if (answer.hash === null) {
    return answer.oldestSequence !== null && answer.oldestSequence > known.sequence
      ? 'PURGED'
      : { ok: false, reason: 'ROLLED_BACK', sequence: known.sequence };
  }
  return answer.hash === known.hash
    ? { ok: true }
    : { ok: false, reason: 'REWRITTEN', sequence: known.sequence };
}

/**
 * What a PC reports as tampering (LIC-007) that alerts at once (SEC-015): a licence file or the
 * sealed record changed, or the licence on another PC. A reactivation code the vendor never
 * issued alerts too (`tamperAlertDue`'s `unissuedCode`).
 */
export const SERIOUS_TAMPER_KINDS: readonly string[] = [
  'LICENCE_TAMPERED',
  'RECORD_TAMPERED',
  'OTHER_PC',
  'CODE_MODIFIED',
];
/** The clock's reports (set back, held back, far from the Control Plane's) alert when repeated. */
export const CLOCK_TAMPER_KINDS: readonly string[] = ['CLOCK_ROLLBACK', 'CLOCK_SKEW'];
/** SEC-015's "repeated tamper events": this many clock reports within the window. */
export const CLOCK_TAMPER_REPEATS = 3;
export const CLOCK_TAMPER_WINDOW_DAYS = 7;

export interface TamperReport {
  readonly kind: string;
  /** When the Control Plane received it (the PC's own time may be what is wrong). */
  readonly at: string;
}

/**
 * Whether a PC's tamper reports call for a fleet alert (SEC-015, LIC-007), and for which kinds.
 * `reports` are those the Control Plane received since the last alert of this kind was closed,
 * the new ones included; `now` is when the newest arrived. A serious kind, or a reactivation code
 * the vendor never issued, alerts at once; the clock's kinds once reported on
 * `CLOCK_TAMPER_REPEATS` occasions within `CLOCK_TAMPER_WINDOW_DAYS` (a PC reports each kind once
 * a day at most), since a PC with a flat clock battery is more common than a customer holding the
 * clock back, and a person should not be called for one report.
 */
export function tamperAlertDue(
  reports: readonly TamperReport[],
  now: Date,
  unissuedCode = false,
): readonly string[] {
  const kinds = new Set<string>();
  if (unissuedCode) kinds.add('REACTIVATION_CODE_NOT_ISSUED');
  for (const report of reports) {
    if (SERIOUS_TAMPER_KINDS.includes(report.kind)) kinds.add(report.kind);
  }
  const since = now.getTime() - CLOCK_TAMPER_WINDOW_DAYS * 86_400_000;
  const clock = reports.filter(
    (report) => CLOCK_TAMPER_KINDS.includes(report.kind) && Date.parse(report.at) > since,
  );
  if (clock.length >= CLOCK_TAMPER_REPEATS) {
    for (const report of clock) kinds.add(report.kind);
  }
  return [...kinds].sort();
}
