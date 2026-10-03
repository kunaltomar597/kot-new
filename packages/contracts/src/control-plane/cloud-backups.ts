import { z } from 'zod';
import { Id, Timestamp } from '../common.js';
import { Sha256Hex } from './schemas.js';

/**
 * The encrypted cloud backup (DATA-003, P7-05d): each night the restaurant PC uploads its newest
 * full backup, already encrypted with its backup key (AES-256-GCM), to object storage in India.
 * The Control Plane hands out short-lived signed URLs for the parts and keeps the record; the
 * bytes never pass through it, and it cannot read them.
 */

/** The largest backup file taken: S3's 10,000 parts of up to 5 GiB, with room to spare. */
export const CLOUD_BACKUP_MAX_BYTES = 2 * 1024 ** 4;

/** A full backup's file name, as the restaurant PC makes it (P7-05a). */
export const CloudBackupFileName = z
  .string()
  .regex(/^rp-backup-\d{8}T\d{6}Z-(nightly|manual)\.rpbk$/);

/** The PC starts an upload: what the file is. */
export const StartCloudBackupRequest = z.strictObject({
  fileName: CloudBackupFileName,
  /** When the backup was made (its header's time). */
  backupCreatedAt: Timestamp,
  sizeBytes: z.int().positive().max(CLOUD_BACKUP_MAX_BYTES),
  sha256: Sha256Hex,
  /** Which backup key opens it (not the key). */
  keyId: z.string().regex(/^[0-9a-f]{16}$/),
});
export type StartCloudBackupRequest = z.infer<typeof StartCloudBackupRequest>;

export const CloudBackupStatus = z.enum(['UPLOADING', 'COMPLETE', 'ABORTED', 'DELETED']);
export type CloudBackupStatus = z.infer<typeof CloudBackupStatus>;

/**
 * Where to put each part: PUT the part's bytes, with its `Content-MD5`, to its URL (absolute, or
 * relative to the Control Plane's address), and keep the `ETag` it answers. Empty when the same
 * file is stored already.
 */
export const StartCloudBackupResponse = z.object({
  id: Id,
  status: CloudBackupStatus,
  partSize: z.int().positive(),
  parts: z.array(z.object({ number: z.int().min(1).max(10_000), url: z.string().min(1) })),
  /** The URLs stop working after this. */
  expiresAt: Timestamp,
});
export type StartCloudBackupResponse = z.infer<typeof StartCloudBackupResponse>;

export const CloudBackupParams = z.object({ id: Id });
export type CloudBackupParams = z.infer<typeof CloudBackupParams>;

export const CompleteCloudBackupRequest = z.strictObject({
  parts: z
    .array(
      z.strictObject({
        number: z.int().min(1).max(10_000),
        etag: z.string().min(1).max(200),
      }),
    )
    .min(1)
    .max(10_000),
});
export type CompleteCloudBackupRequest = z.infer<typeof CompleteCloudBackupRequest>;

/** A backup kept in the cloud. */
export const CloudBackupView = z.object({
  id: Id,
  installationId: Id,
  fileName: CloudBackupFileName,
  backupCreatedAt: Timestamp,
  sizeBytes: z.int().nonnegative(),
  sha256: Sha256Hex,
  keyId: z.string(),
  status: CloudBackupStatus,
  startedAt: Timestamp,
  completedAt: Timestamp.nullable(),
});
export type CloudBackupView = z.infer<typeof CloudBackupView>;

/** The backups kept in the cloud, newest first. */
export const CloudBackupListResponse = z.object({ backups: z.array(CloudBackupView) });
export type CloudBackupListResponse = z.infer<typeof CloudBackupListResponse>;
