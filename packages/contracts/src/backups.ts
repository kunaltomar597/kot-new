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

/** How the continuous backup stands (P7-05c): see `continuousBackupState` in `@rp/domain`. */
export const ContinuousBackupState = z.enum(['NOT_SET_UP', 'OK', 'BEHIND', 'FAILING']);
export type ContinuousBackupState = z.infer<typeof ContinuousBackupState>;

/**
 * The continuous backup (DATA-002, P7-05c): the database's write-ahead log archived as it is
 * written, with a base backup every night, so it can be restored to any minute since
 * `restorableFrom`.
 */
export const ContinuousBackupView = z.object({
  state: ContinuousBackupState,
  mode: z.enum(['CONTINUOUS', 'HOURLY']),
  /** When the last piece of the log was archived. */
  lastArchivedAt: Timestamp.nullable(),
  /** Pieces of the log handed over by the database and not yet archived. */
  waiting: z.int().nonnegative(),
  /** Archived pieces not yet copied to the second location. */
  secondLocationBehind: z.int().nonnegative(),
  lastBaseBackupAt: Timestamp.nullable(),
  /** The earliest moment the database can be restored to; null before the first base backup. */
  restorableFrom: Timestamp.nullable(),
  /** What went wrong last, in plain words. */
  error: z.string().nullable(),
});
export type ContinuousBackupView = z.infer<typeof ContinuousBackupView>;

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
  continuous: ContinuousBackupView,
  /** A restore was asked for and runs when the server restarts (P7-05b). */
  restorePending: z.boolean(),
  /** How the last restore on this PC went, if there was one. */
  lastRestore: z
    .object({
      at: Timestamp,
      ok: z.boolean(),
      error: z.string().nullable(),
      backupCreatedAt: Timestamp.nullable(),
      /** For a restore to a point in time: the last change it brought back. */
      restoredTo: Timestamp.nullable(),
      /** The database as it was before, kept to go back to. */
      previousDatabase: z.string().nullable(),
    })
    .nullable(),
});
export type BackupsResponse = z.infer<typeof BackupsResponse>;

/** "Back up now": the backup started, running in the background. */
export const StartBackupResponse = z.object({ run: BackupRunView });
export type StartBackupResponse = z.infer<typeof StartBackupResponse>;

/** A backup file's name as the server makes it. */
export const BackupFileName = z.string().regex(/^rp-backup-\d{8}T\d{6}Z-(nightly|manual)\.rpbk$/);

/**
 * Restore this PC from one of its backups (DATA-004, P7-05b): the Owner, with a fresh second
 * factor and a reason. Everything after the backup's time is lost; the server restarts to do it.
 */
export const RestoreFileRequest = z.strictObject({
  location: BackupLocation,
  fileName: BackupFileName,
  reason: z.string().trim().min(3).max(200),
});
export type RestoreFileRequest = z.infer<typeof RestoreFileRequest>;

/**
 * Restore the database to a moment from the continuous backup (P7-05c): `to` null brings back
 * everything archived. Photos, TLS files and secrets come from the nightly backup before it.
 */
export const RestorePointInTimeRequest = z.strictObject({
  pointInTime: z.strictObject({ to: Timestamp.nullable() }),
  reason: z.string().trim().min(3).max(200),
});
export type RestorePointInTimeRequest = z.infer<typeof RestorePointInTimeRequest>;

export const RestoreBackupRequest = z.union([RestoreFileRequest, RestorePointInTimeRequest]);
export type RestoreBackupRequest = z.infer<typeof RestoreBackupRequest>;

export const RestoreBackupResponse = z.object({
  requestedAt: Timestamp,
  /**
   * When the backup being restored was made: what the restaurant goes back to. For a point in
   * time, the base backup it starts from.
   */
  backupCreatedAt: Timestamp,
  /** The moment asked for; null for a backup file, or for everything archived. */
  pointInTime: Timestamp.nullable(),
});
export type RestoreBackupResponse = z.infer<typeof RestoreBackupResponse>;

/**
 * The backup recovery key (P7-05b): the backup key written out for the Owner to keep on paper, to
 * read the backups on a new PC. Shown to the Owner only, with a fresh second factor; audited.
 */
export const RecoveryKeyResponse = z.object({
  /** `RPK1-XXXXX-...`: 11 groups of five letters and digits. */
  recoveryKey: z.string(),
  keyId: z.string(),
});
export type RecoveryKeyResponse = z.infer<typeof RecoveryKeyResponse>;
