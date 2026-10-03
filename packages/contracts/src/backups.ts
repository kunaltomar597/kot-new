import { z } from 'zod';
import { Id, Timestamp } from './common.js';

/** How the backups stand (DATA-005): see `backupHealth` in `@rp/domain`. */
export const BackupHealth = z.enum(['OK', 'FAILED', 'OVERDUE', 'NONE']);
export type BackupHealth = z.infer<typeof BackupHealth>;

export const BackupKind = z.enum(['NIGHTLY', 'MANUAL']);
export type BackupKind = z.infer<typeof BackupKind>;

/** PARTIAL: made and checked on the data drive, but not copied to the second location. */
export const BackupStatus = z.enum(['RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED']);
export type BackupStatus = z.infer<typeof BackupStatus>;

/** One backup (DATA-002): when, how it went, the file and the copy at the second location. */
export const BackupRunView = z.object({
  id: Id,
  kind: BackupKind,
  status: BackupStatus,
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
  fileName: z.string().nullable(),
  sizeBytes: z.int().nonnegative().nullable(),
  secondCopy: z.enum(['COPIED', 'NOT_SET', 'FAILED']).nullable(),
  /** What went wrong, in plain words. */
  error: z.string().nullable(),
  /** Who pressed "Back up now"; null for the nightly backup. */
  requestedBy: z.string().nullable(),
});
export type BackupRunView = z.infer<typeof BackupRunView>;

export const BackupLocation = z.enum(['DATA_DRIVE', 'SECOND']);
export type BackupLocation = z.infer<typeof BackupLocation>;

/** The Backups part of the System page (DATA-002, DATA-005, P7-05a). */
export const BackupsResponse = z.object({
  health: BackupHealth,
  lastSuccessAt: Timestamp.nullable(),
  /** When the next nightly backup starts (`backups.nightlyAt`). */
  nextNightlyAt: Timestamp,
  running: z.boolean(),
  /** The backup files kept in each place, newest first. */
  locations: z.array(
    z.object({
      location: BackupLocation,
      /** The folder; null for a second location that is not set. */
      path: z.string().nullable(),
      /** The folder can be read now (a USB drive may be unplugged). */
      available: z.boolean(),
      files: z.array(
        z.object({ name: z.string(), takenAt: Timestamp, sizeBytes: z.int().nonnegative() }),
      ),
    }),
  ),
  /** The latest backups, newest first. */
  runs: z.array(BackupRunView),
  /** Which backup key this PC's backups need (not the key). */
  keyId: z.string(),
});
export type BackupsResponse = z.infer<typeof BackupsResponse>;

/** "Back up now": the backup started, running in the background. */
export const StartBackupResponse = z.object({ run: BackupRunView });
export type StartBackupResponse = z.infer<typeof StartBackupResponse>;
