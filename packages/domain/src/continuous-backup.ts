import { BACKUP_OVERDUE_MS } from './backups.js';

/**
 * Continuous backup (DATA-002, DATA-004, P7-05c): PostgreSQL's write-ahead log (WAL) archived as
 * it is written, and a base backup every night, so the database can be restored to any moment
 * since the oldest base backup kept. Which base backups and WAL files the retention keeps, how
 * often the log is closed off, and how the archiving stands. Pure; the server runs it.
 */

/** A WAL segment's name: timeline, log and segment, eight hexadecimal digits each. */
export const WAL_SEGMENT_NAME = /^[0-9A-F]{24}$/;

/** Any file PostgreSQL archives: a segment, a partial segment, a backup or timeline history. */
export const WAL_FILE_NAME =
  /^(?:[0-9A-F]{24}(?:\.partial|\.[0-9A-F]{8}\.backup)?|[0-9A-F]{8}\.history)$/;

export type WalMode = 'CONTINUOUS' | 'HOURLY';

/**
 * How often the server closes the current WAL segment so it is archived (`backups.walMode`): the
 * most a restore can lose when the data drive survives. PostgreSQL closes a full one by itself.
 */
export function walSwitchEveryMs(mode: WalMode): number {
  return mode === 'CONTINUOUS' ? 5 * 60_000 : 60 * 60_000;
}

/**
 * Where a WAL file sits in the log, regardless of timeline: log and segment numbers. Null for a
 * timeline history file, which is always kept.
 */
export function walPosition(name: string): string | null {
  if (!WAL_FILE_NAME.test(name) || name.endsWith('.history')) return null;
  return name.slice(8, 24);
}

export interface BaseBackupInfo {
  readonly name: string;
  /** The PostgreSQL cluster it was taken from (`pg_control_system()`); WAL is kept per cluster. */
  readonly systemId: string;
  /** When it finished: the earliest moment it can restore to. */
  readonly endAt: Date;
  /** The first WAL segment it needs. */
  readonly startSegment: string;
}

/**
 * Base backups the retention removes: every one that ended within the last `days` is kept, and
 * the newest one before that, so any moment in those days can be restored. The newest base backup
 * is always kept. Names, oldest first.
 */
export function baseBackupsToRemove(
  backups: readonly BaseBackupInfo[],
  now: Date,
  days: number,
): string[] {
  const sorted = [...backups].sort((a, b) => a.endAt.getTime() - b.endAt.getTime());
  const windowStart = now.getTime() - days * 24 * 60 * 60_000;
  const before = sorted.filter((backup) => backup.endAt.getTime() < windowStart);
  const keep = new Set(
    sorted.filter((backup) => backup.endAt.getTime() >= windowStart).map((backup) => backup.name),
  );
  const newestBefore = before.at(-1);
  if (newestBefore !== undefined) keep.add(newestBefore.name);
  const newest = sorted.at(-1);
  if (newest !== undefined) keep.add(newest.name);
  return sorted.filter((backup) => !keep.has(backup.name)).map((backup) => backup.name);
}

/**
 * WAL files of one cluster the retention removes: everything before the oldest kept base backup's
 * first segment. With no base backup left for the cluster, its WAL is no use and all of it goes.
 * Timeline history files stay while any base backup does.
 */
export function walFilesToRemove(
  names: readonly string[],
  oldestStartSegment: string | null,
): string[] {
  if (oldestStartSegment === null) return names.filter((name) => WAL_FILE_NAME.test(name));
  const from = oldestStartSegment.slice(8, 24);
  return names.filter((name) => {
    const position = walPosition(name);
    return position !== null && position < from;
  });
}

export type ContinuousBackupState = 'NOT_SET_UP' | 'OK' | 'BEHIND' | 'FAILING';

/** How the continuous backup stands (DATA-005); FAILING alerts like a failed backup. */
export function continuousBackupState(input: {
  /** PostgreSQL archives its WAL and the server may take base backups (installer, P0-16). */
  readonly setUp: boolean;
  readonly now: Date;
  readonly mode: WalMode;
  /** PostgreSQL could not hand over a WAL file since it last could (`pg_stat_archiver`). */
  readonly archiverFailing: boolean;
  /** The last archiving or base backup attempt failed, with what went wrong. */
  readonly lastError: string | null;
  /** The oldest WAL file handed over but not yet encrypted into the archive. */
  readonly oldestWaitingAt: Date | null;
  readonly lastBaseBackupAt: Date | null;
  /** Archived files not yet copied to the second location (0 when none is set). */
  readonly secondLocationBehind: number;
}): ContinuousBackupState {
  if (!input.setUp) return 'NOT_SET_UP';
  if (input.archiverFailing || input.lastError !== null) return 'FAILING';
  const now = input.now.getTime();
  if (
    input.lastBaseBackupAt === null ||
    now - input.lastBaseBackupAt.getTime() > BACKUP_OVERDUE_MS
  ) {
    return 'BEHIND';
  }
  const late = walSwitchEveryMs(input.mode) + 10 * 60_000;
  if (input.oldestWaitingAt !== null && now - input.oldestWaitingAt.getTime() > late) {
    return 'BEHIND';
  }
  return input.secondLocationBehind > 0 ? 'BEHIND' : 'OK';
}
