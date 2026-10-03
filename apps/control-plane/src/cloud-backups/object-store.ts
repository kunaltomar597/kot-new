/**
 * Where cloud backups are kept (DATA-003, P7-05d): object storage in India. Restaurant PCs upload
 * and download directly with short-lived signed URLs, so backups never pass through the Control
 * Plane. A file is uploaded in parts (S3 multipart): a 100 GB restaurant's backup is bigger than
 * one request may be.
 */

export interface UploadPart {
  readonly number: number;
  readonly url: string;
}

export interface StartedUpload {
  readonly uploadId: string;
  readonly partSize: number;
  readonly parts: readonly UploadPart[];
}

export interface ObjectStore {
  /** Starts a multipart upload of `sizeBytes`, with a signed URL for each part. */
  startUpload(key: string, sizeBytes: number, expiresSeconds: number): Promise<StartedUpload>;
  /** Joins the parts (with the ETags each part's PUT answered) into the object. */
  completeUpload(
    key: string,
    uploadId: string,
    parts: readonly { readonly number: number; readonly etag: string }[],
  ): Promise<void>;
  abortUpload(key: string, uploadId: string): Promise<void>;
  /** The object's size, or null when there is none. */
  sizeOf(key: string): Promise<number | null>;
  remove(key: string): Promise<void>;
  /** A signed URL to download the object. */
  downloadUrl(key: string, expiresSeconds: number): Promise<string>;
}

const MiB = 1024 * 1024;
/** S3's limits: parts of 5 MiB to 5 GiB, at most 10,000 of them. */
export const MIN_PART_BYTES = 5 * MiB;
export const MAX_PARTS = 10_000;

/** Parts of 64 MiB, larger for very large files so there are never more than 10,000. */
export function partSizeFor(sizeBytes: number): number {
  const wanted = Math.max(64 * MiB, Math.ceil(sizeBytes / MAX_PARTS / MiB) * MiB);
  return Math.max(MIN_PART_BYTES, wanted);
}

export function partCount(sizeBytes: number, partSize: number): number {
  return Math.max(1, Math.ceil(sizeBytes / partSize));
}
