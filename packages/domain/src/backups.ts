import {
  addDays,
  calendarDateOf,
  DEFAULT_TIME_ZONE,
  type IsoDate,
  parseIsoDate,
  zonedTimeToUtc,
} from './business-date.js';

/**
 * Backups (DATA-002, DATA-005, P7-05a): which backups the retention keeps, when the nightly
 * backup is due, and whether the backups are healthy. Pure; the server runs and stores them.
 */

export interface BackupFileInfo {
  readonly name: string;
  readonly takenAt: Date;
}

/** The Monday of a date's week (ISO weeks start on Monday). */
export function weekStartOf(date: IsoDate): IsoDate {
  const { year, month, day } = parseIsoDate(date);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

/**
 * Retention (DATA-002, default 14 daily + 8 weekly): the newest backup of each of the last
 * `keepDaily` days that have one, and the newest of each of the last `keepWeekly` weeks. The
 * newest backup is always kept. Returns the names to remove, oldest first.
 */
export function backupsToRemove(
  backups: readonly BackupFileInfo[],
  keepDaily: number,
  keepWeekly: number,
  timeZone: string = DEFAULT_TIME_ZONE,
): string[] {
  const newestFirst = [...backups].sort(
    (a, b) => b.takenAt.getTime() - a.takenAt.getTime() || b.name.localeCompare(a.name),
  );
  const keep = new Set<string>();
  const days = new Set<IsoDate>();
  const weeks = new Set<IsoDate>();
  for (const backup of newestFirst) {
    const day = calendarDateOf(backup.takenAt, timeZone);
    const week = weekStartOf(day);
    if (!days.has(day) && days.size < Math.max(1, keepDaily)) {
      days.add(day);
      keep.add(backup.name);
    }
    if (!weeks.has(week) && weeks.size < keepWeekly) {
      weeks.add(week);
      keep.add(backup.name);
    }
  }
  return newestFirst
    .filter((backup) => !keep.has(backup.name))
    .map((backup) => backup.name)
    .reverse();
}

/** The latest time the nightly backup was scheduled for, at or before `now`. */
export function lastNightlySlot(
  now: Date,
  nightlyAt: string,
  timeZone: string = DEFAULT_TIME_ZONE,
): Date {
  const today = calendarDateOf(now, timeZone);
  const slot = zonedTimeToUtc(today, nightlyAt, timeZone);
  return slot.getTime() <= now.getTime()
    ? slot
    : zonedTimeToUtc(addDays(today, -1), nightlyAt, timeZone);
}

/** A failed nightly backup is tried again after this long. */
export const BACKUP_RETRY_MS = 60 * 60_000;

/**
 * Whether the nightly backup should run now: nothing succeeded since the last slot (a PC that was
 * off then catches up when it starts), and nothing was tried in the last hour.
 */
export function nightlyBackupDue(input: {
  readonly now: Date;
  readonly nightlyAt: string;
  readonly lastSuccessAt: Date | null;
  readonly lastAttemptAt: Date | null;
  readonly timeZone?: string;
}): boolean {
  const slot = lastNightlySlot(input.now, input.nightlyAt, input.timeZone);
  if (input.lastSuccessAt !== null && input.lastSuccessAt.getTime() >= slot.getTime()) {
    return false;
  }
  return (
    input.lastAttemptAt === null ||
    input.now.getTime() - input.lastAttemptAt.getTime() >= BACKUP_RETRY_MS
  );
}

/** No successful backup for this long is overdue (a day, and a little for a late night). */
export const BACKUP_OVERDUE_MS = 26 * 60 * 60_000;

export type BackupHealth = 'OK' | 'FAILED' | 'OVERDUE' | 'NONE';

/** How the backups stand (DATA-005): the latest attempt failed, none for a day, or fine. */
export function backupHealth(input: {
  readonly now: Date;
  readonly lastSuccessAt: Date | null;
  readonly lastFailureAt: Date | null;
}): BackupHealth {
  const { now, lastSuccessAt, lastFailureAt } = input;
  if (lastFailureAt !== null && (lastSuccessAt === null || lastFailureAt > lastSuccessAt)) {
    return 'FAILED';
  }
  if (lastSuccessAt === null) return 'NONE';
  return now.getTime() - lastSuccessAt.getTime() > BACKUP_OVERDUE_MS ? 'OVERDUE' : 'OK';
}
