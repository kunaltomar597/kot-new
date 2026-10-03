import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { type BaseBackupInfo, WAL_FILE_NAME } from '@rp/domain';
import { decryptBackup, encryptBackup } from './backup-file.js';

/**
 * The continuous backup's archive (DATA-002, P7-05c), the same under the data drive's backup
 * folder and under the second location:
 *
 *   wal/<system id>/<WAL file name>.rpwal                          the log, piece by piece
 *   base/<system id>/rp-base-<end>-<first WAL segment>.rpbase       the nightly base backups
 *
 * Every file is compressed (gzip), then encrypted with the backup key like a full backup (kind WAL
 * or BASE). The system id keeps the archives of two PostgreSQL clusters apart (a new PC starts its
 * WAL numbering again).
 */

export const WAL_SUFFIX = '.rpwal';
export const BASE_PATTERN = /^rp-base-(\d{8}T\d{6}Z)-([0-9A-F]{24})\.rpbase$/;
const SYSTEM_ID = /^\d{1,20}$/;

/** Where `wal-stage` puts the WAL files PostgreSQL hands over, per cluster. */
export function stagingFolder(dataDir: string): string {
  return join(dataDir, 'backups', 'wal-staging');
}

export function walFolder(root: string, systemId: string): string {
  return join(root, 'wal', systemId);
}

export function baseFolder(root: string, systemId: string): string {
  return join(root, 'base', systemId);
}

function stampOf(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function dateOfStamp(stamp: string): Date {
  return new Date(
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
  );
}

export function baseBackupName(endAt: Date, startSegment: string): string {
  return `rp-base-${stampOf(endAt)}-${startSegment}.rpbase`;
}

export function parseBaseBackupName(name: string, systemId: string): BaseBackupInfo | null {
  const match = BASE_PATTERN.exec(name);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { name, systemId, endAt: dateOfStamp(match[1]), startSegment: match[2] };
}

export async function sha256Of(source: Readable | AsyncIterable<Buffer>): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of source) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** The plain content of an archived file, as a stream (decrypted, then decompressed). */
export function openArchived(file: string, key: Buffer): Readable {
  const decrypted = createReadStream(file).pipe(decryptBackup(key));
  const gunzip = createGunzip();
  decrypted.on('error', (error) => gunzip.destroy(error));
  return decrypted.pipe(gunzip);
}

export async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Encrypts a staged WAL file into the archive, then reads it back and compares it with the
 * original before naming it. Archiving the same content again is fine; different content under a
 * name already archived is refused.
 */
export async function archiveWalFile(options: {
  readonly source: string;
  readonly target: string;
  readonly key: Buffer;
  readonly appVersion: string;
}): Promise<'ARCHIVED' | 'ALREADY_ARCHIVED'> {
  const original = await sha256Of(createReadStream(options.source));
  if (await exists(options.target)) {
    if ((await sha256Of(openArchived(options.target, options.key))) === original) {
      return 'ALREADY_ARCHIVED';
    }
    throw new Error(`${options.target} is archived already with different content`);
  }
  await mkdir(join(options.target, '..'), { recursive: true, mode: 0o700 });
  const partial = `${options.target}.partial`;
  try {
    await pipeline(
      createReadStream(options.source),
      createGzip({ level: 1 }),
      encryptBackup(options.key, { kind: 'WAL', appVersion: options.appVersion }),
      createWriteStream(partial, { mode: 0o600 }),
    );
    await syncFile(partial);
    if ((await sha256Of(openArchived(partial, options.key))) !== original) {
      throw new Error('The archived WAL file does not read back as it was written');
    }
    await rename(partial, options.target);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return 'ARCHIVED';
}

/**
 * Copies an archived file to another place (the second location), checking the copy byte for
 * byte before naming it. A file already there with the same content is left as it is.
 */
export async function copyArchivedFile(options: {
  readonly source: string;
  readonly target: string;
  readonly key: Buffer;
}): Promise<'COPIED' | 'ALREADY_THERE'> {
  const original = await sha256Of(createReadStream(options.source));
  if (await exists(options.target)) {
    if ((await sha256Of(createReadStream(options.target))) === original) return 'ALREADY_THERE';
    // Encrypted twice (another salt): the same once opened is the same file.
    const [there, here] = await Promise.all([
      sha256Of(openArchived(options.target, options.key)),
      sha256Of(openArchived(options.source, options.key)),
    ]);
    if (there === here) return 'ALREADY_THERE';
    throw new Error(`${options.target} holds different content`);
  }
  await mkdir(join(options.target, '..'), { recursive: true });
  const partial = `${options.target}.partial`;
  try {
    await pipeline(createReadStream(options.source), createWriteStream(partial, { mode: 0o600 }));
    await syncFile(partial);
    if ((await sha256Of(createReadStream(partial))) !== original) {
      throw new Error('The copy does not match the archived file');
    }
    await rename(partial, options.target);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return 'COPIED';
}

/** Decrypts an archived WAL file for recovery, through a partial file. */
export async function restoreWalFile(options: {
  readonly file: string;
  readonly key: Buffer;
  readonly target: string;
}): Promise<void> {
  const partial = `${options.target}.partial`;
  try {
    await pipeline(openArchived(options.file, options.key), createWriteStream(partial));
    await rename(partial, options.target);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

export interface ArchivedSystem {
  readonly systemId: string;
  /** WAL file names (without the suffix), in log order. */
  readonly wal: readonly string[];
  /** Base backups, oldest first. */
  readonly bases: readonly BaseBackupInfo[];
}

async function namesIn(folder: string): Promise<string[]> {
  try {
    return await readdir(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** What an archive holds, per cluster. Fails when the folder cannot be read (unplugged). */
export async function listArchive(root: string): Promise<ArchivedSystem[]> {
  const ids = new Set(
    [...(await namesIn(join(root, 'wal'))), ...(await namesIn(join(root, 'base')))].filter((id) =>
      SYSTEM_ID.test(id),
    ),
  );
  const systems: ArchivedSystem[] = [];
  for (const systemId of [...ids].sort()) {
    const wal = (await namesIn(walFolder(root, systemId)))
      .filter((name) => name.endsWith(WAL_SUFFIX))
      .map((name) => name.slice(0, -WAL_SUFFIX.length))
      .filter((name) => WAL_FILE_NAME.test(name))
      .sort();
    const bases = (await namesIn(baseFolder(root, systemId)))
      .flatMap((name) => parseBaseBackupName(name, systemId) ?? [])
      .sort((a, b) => a.endAt.getTime() - b.endAt.getTime());
    systems.push({ systemId, wal, bases });
  }
  return systems;
}
