import { constants, createHash, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { ApiError } from '@rp/contracts';
import { CloudRestoreResponse } from '@rp/contracts/control-plane';
import type { WritableSecretStore } from '../auth/secret-store.js';
import { backupKeyId } from './backup-file.js';
import { type RestoreResult, restoreBackup } from './restore.js';

export interface CloudRestoreOptions {
  readonly controlPlaneUrl: string;
  /** The restore code the vendor gave the Owner. */
  readonly code: string;
  readonly databaseUrl: string;
  readonly adminUrl: string;
  readonly dataDir: string;
  readonly secrets: WritableSecretStore;
  readonly pgBin: string | undefined;
  readonly fetch?: typeof fetch;
  readonly log?: (message: string) => void;
}

/** Why the vendor would not release the backups. */
export class CloudRestoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CloudRestoreError';
  }
}

/**
 * Restore from the cloud onto a new PC (DATA-004, P7-05e), when the PC and its backup drive are
 * both gone. With the restore code the vendor gave the Owner after verifying them:
 *
 * 1. a key pair is made here; the Control Plane releases the escrowed backup key wrapped for its
 *    public half, so the key never crosses in the clear, with each cloud backup's address;
 * 2. the newest backup is downloaded and checked against its SHA-256;
 * 3. it is restored as P7-05b does (the backup's secrets, photos and TLS files come with it).
 */
export async function restoreFromCloud(
  options: CloudRestoreOptions,
): Promise<RestoreResult & { readonly fileName: string; readonly tenantName: string }> {
  const log = options.log ?? (() => undefined);
  const doFetch = options.fetch ?? fetch;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  log('Asking the vendor for the backup key');
  const response = await doFetch(new URL('/v1/cloud-restores', options.controlPlaneUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      code: options.code,
      publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    }),
    redirect: 'error',
  });
  const json: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = ApiError.safeParse(json);
    throw error.success
      ? new CloudRestoreError(error.data.code, error.data.message)
      : new CloudRestoreError(
          `HTTP_${String(response.status)}`,
          `The vendor answered ${String(response.status)}.`,
        );
  }
  const answer = CloudRestoreResponse.parse(json);
  const keys = new Map(
    answer.keys.map((entry) => [
      entry.keyId,
      privateDecrypt(
        { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(entry.wrappedKey, 'base64'),
      ),
    ]),
  );
  const newest = answer.backups.find((backup) => keys.has(backup.keyId));
  const key = newest === undefined ? undefined : keys.get(newest.keyId);
  if (newest === undefined || key === undefined || backupKeyId(key) !== newest.keyId) {
    throw new CloudRestoreError('NOTHING_TO_RESTORE', 'The vendor holds no backup this key opens.');
  }
  log(`Downloading ${newest.fileName} (${String(Math.ceil(newest.sizeBytes / 1024 ** 2))} MB)`);
  const folder = join(options.dataDir, 'backups', 'cloud');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const file = join(folder, newest.fileName);
  const partial = `${file}.partial`;
  const download = await doFetch(new URL(newest.url, `${options.controlPlaneUrl}/`), {
    redirect: 'error',
  });
  if (!download.ok || download.body === null) {
    throw new CloudRestoreError(
      'DOWNLOAD_FAILED',
      `The backup could not be downloaded (${String(download.status)}).`,
    );
  }
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    await pipeline(
      Readable.fromWeb(download.body as WebReadableStream<Uint8Array>),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          bytes += chunk.length;
          callback(null, chunk);
        },
      }),
      createWriteStream(partial, { mode: 0o600 }),
    );
    if (bytes !== newest.sizeBytes || hash.digest('hex') !== newest.sha256) {
      throw new CloudRestoreError(
        'DOWNLOAD_DAMAGED',
        'The downloaded backup does not match the one stored. Try again.',
      );
    }
    await rename(partial, file);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  const result = await restoreBackup({
    file,
    key,
    databaseUrl: options.databaseUrl,
    adminUrl: options.adminUrl,
    dataDir: options.dataDir,
    secrets: options.secrets,
    pgBin: options.pgBin,
    log,
  });
  for (const value of keys.values()) value.fill(0);
  return { ...result, fileName: newest.fileName, tenantName: answer.tenantName };
}
