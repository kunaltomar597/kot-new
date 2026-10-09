import { z } from 'zod';
import { Id, Timestamp } from '../common.js';

/** SHA-256, hex (as `Sha256Hex` in schemas.ts, which imports this file). */
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * The encrypted cloud backup (DATA-003, P7-05d): each night the restaurant PC uploads its newest
 * full backup, already encrypted with its backup key (AES-256-GCM), to object storage in India.
 * The Control Plane hands out short-lived signed URLs for the parts and keeps the record; the
 * bytes never pass through it, and it cannot read them.
 */

/** The largest backup file taken: S3's 10,000 parts of up to 5 GiB, with room to spare. */
export const CLOUD_BACKUP_MAX_BYTES = 2 * 1024 ** 4;

/** A full backup's file name, as the restaurant PC makes it (P7-05a). */
export const BACKUP_FILE_NAME = /^rp-backup-\d{8}T\d{6}Z-(nightly|manual)\.rpbk$/;
/** An archived financial year's file name (DATA-008, P7-06b). */
export const ARCHIVE_FILE_NAME = /^rp-archive-FY\d{4}-\d{2}-\d{8}T\d{6}Z\.rpar$/;

/** A file kept in the cloud: a nightly backup, or an archived year (kept, never pruned). */
export const CloudBackupFileName = z
  .string()
  .refine((name) => BACKUP_FILE_NAME.test(name) || ARCHIVE_FILE_NAME.test(name), {
    message: 'Not a backup or archive file name',
  });

export const CloudFileKind = z.enum(['BACKUP', 'ARCHIVE']);
export type CloudFileKind = z.infer<typeof CloudFileKind>;

export function cloudFileKindOf(fileName: string): CloudFileKind {
  return ARCHIVE_FILE_NAME.test(fileName) ? 'ARCHIVE' : 'BACKUP';
}

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
  /** An archived year is kept for good: the retention and a restore never use it. */
  kind: CloudFileKind.default('BACKUP'),
  status: CloudBackupStatus,
  startedAt: Timestamp,
  completedAt: Timestamp.nullable(),
});
export type CloudBackupView = z.infer<typeof CloudBackupView>;

/** The backups kept in the cloud, newest first. */
export const CloudBackupListResponse = z.object({ backups: z.array(CloudBackupView) });
export type CloudBackupListResponse = z.infer<typeof CloudBackupListResponse>;

/**
 * The address of the development object store's signed URL (P7-05d): an HMAC-signed grant for
 * one part or one download, as a presigned S3 URL would be.
 */
export const ObjectStoreGrantParams = z.strictObject({ grant: z.string().min(1).max(2_000) });
export type ObjectStoreGrantParams = z.infer<typeof ObjectStoreGrantParams>;

// ------------------------------------------------------------ key escrow (P7-05e, OI-10)

const KeyId = z.string().regex(/^[0-9a-f]{16}$/);
/** An RSA public key, SPKI DER in base64 (3072 or 4096 bits). */
const RsaPublicKey = z.base64().min(400).max(1_000);
/** A secret wrapped with RSA-OAEP (SHA-256): as long as the key's modulus. */
const Wrapped = z.base64().min(300).max(800);

/**
 * In a heartbeat answer, while this PC's backup key is not escrowed: the vendor's escrow public
 * key to wrap it with (RSA-OAEP, SHA-256). The private half stays in the vendor's KMS.
 */
export const EscrowOffer = z.object({
  escrowKeyId: KeyId,
  publicKey: RsaPublicKey,
});
export type EscrowOffer = z.infer<typeof EscrowOffer>;

/** The PC's backup key, wrapped with the escrow key it was offered. */
export const EscrowBackupKeyRequest = z.strictObject({
  keyId: KeyId,
  escrowKeyId: KeyId,
  wrappedKey: Wrapped,
});
export type EscrowBackupKeyRequest = z.infer<typeof EscrowBackupKeyRequest>;

/**
 * Vendor staff issue a restore code once they have verified the restaurant's Owner (OI-10): why,
 * and how the Owner was verified. Audited, and the restaurant's Owner is told.
 */
export const RestoreCodeRequest = z.strictObject({
  reason: z.string().trim().min(3).max(500),
  ownerVerification: z.string().trim().min(3).max(500),
});
export type RestoreCodeRequest = z.infer<typeof RestoreCodeRequest>;

/** The code, shown once: one use, within 24 hours, on the new PC's restore tool. */
export const RestoreCodeView = z.object({
  code: z.string().regex(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/),
  installationId: Id,
  expiresAt: Timestamp,
});
export type RestoreCodeView = z.infer<typeof RestoreCodeView>;

/** The restore tool on a new PC trades the code for the key, wrapped for a key it made now. */
export const CloudRestoreRequest = z.strictObject({
  code: z.string().min(16).max(24),
  publicKey: RsaPublicKey,
});
export type CloudRestoreRequest = z.infer<typeof CloudRestoreRequest>;

export const CloudRestoreResponse = z.object({
  installationId: Id,
  installationName: z.string(),
  tenantName: z.string(),
  /** Each escrowed backup key the backups need, wrapped for the tool's public key. */
  keys: z.array(z.object({ keyId: KeyId, wrappedKey: Wrapped })),
  /** The PC's cloud backups, newest first, each with a download address. */
  backups: z.array(
    z.object({
      fileName: CloudBackupFileName,
      backupCreatedAt: Timestamp,
      sizeBytes: z.int().positive(),
      sha256: Sha256Hex,
      keyId: KeyId,
      /** Absolute, or relative to the Control Plane's address (development). */
      url: z.string().min(1),
    }),
  ),
  /** The download addresses stop working after this. */
  expiresAt: Timestamp,
});
export type CloudRestoreResponse = z.infer<typeof CloudRestoreResponse>;

/** In a heartbeat answer: a restore code vendor staff issued for this restaurant's backups. */
export const RestoreCodeNotice = z.object({
  id: Id,
  issuedAt: Timestamp,
  /** The vendor staff member, as the restaurant sees them. */
  issuedBy: z.string().max(120),
  reason: z.string().max(500),
});
export type RestoreCodeNotice = z.infer<typeof RestoreCodeNotice>;
