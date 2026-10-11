import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { type ArchiveEntry, readArchive } from './backup-archive.js';
import { type BackupHeader, decryptBackup } from './backup-file.js';
import { pgProgram, runPgTool } from './pg-tools.js';

/** What a full backup holds, in this order (P7-05a). */
export const BACKUP_INFO = 'backup.json';
export const DATABASE_DUMP = 'database.dump';
export const SECRETS = 'secrets.json';
export const MANIFEST = 'manifest.json';
/** Files under the data folder: `files/photos/...` and `files/tls/...`. */
export const FILES_PREFIX = 'files/';

/** `backup.json`: what was backed up, for the restore to check before it starts. */
export const BackupInfo = z.object({
  format: z.literal(1),
  createdAt: z.iso.datetime(),
  kind: z.enum(['NIGHTLY', 'MANUAL', 'UPDATE']),
  appVersion: z.string(),
  /** The last database migration applied: a restore needs a server at least this new. */
  schemaVersion: z.string().nullable(),
  postgresVersion: z.string().nullable(),
  restaurants: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type BackupInfo = z.infer<typeof BackupInfo>;

/** `secrets.json`: the local secrets the data needs, so a new PC can read it (base64). */
export const BackupSecrets = z.object({
  format: z.literal(1),
  secrets: z.record(z.string(), z.base64()),
});
export type BackupSecrets = z.infer<typeof BackupSecrets>;

/** `manifest.json`, last: every other entry's size and SHA-256. */
export const BackupManifest = z.object({
  format: z.literal(1),
  entries: z.array(
    z.object({ name: z.string(), bytes: z.int().nonnegative(), sha256: z.string() }),
  ),
});
export type BackupManifest = z.infer<typeof BackupManifest>;

/** The files under a folder, as `/`-separated paths relative to it; none if it is missing. */
export async function* filesUnder(root: string, folder = root): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) yield* filesUnder(root, path);
    else if (entry.isFile()) yield relative(root, path).split(sep).join('/');
  }
}

/** Entries for the files under a data folder (`photos`, `tls`). */
export async function* folderEntries(
  dataDir: string,
  folder: string,
): AsyncGenerator<ArchiveEntry> {
  const root = join(dataDir, folder);
  for await (const path of filesUnder(root)) {
    const full = join(root, ...path.split('/'));
    // A file removed since it was listed (a photo replaced) is left out.
    if (
      !(await lstat(full).then(
        (stats) => stats.isFile(),
        () => false,
      ))
    )
      continue;
    yield { name: `${FILES_PREFIX}${folder}/${path}`, content: createReadStream(full) };
  }
}

/** Wraps entries so each one's size and SHA-256 are counted as it is written, then the manifest. */
export async function* withManifest(
  entries: AsyncIterable<ArchiveEntry> | Iterable<ArchiveEntry>,
): AsyncGenerator<ArchiveEntry> {
  const manifest: BackupManifest = { format: 1, entries: [] };
  for await (const entry of entries) {
    const hash = createHash('sha256');
    let bytes = 0;
    const counted = async function* (): AsyncGenerator<Buffer> {
      for await (const piece of entry.content) {
        const buffer = typeof piece === 'string' ? Buffer.from(piece, 'utf8') : piece;
        hash.update(buffer);
        bytes += buffer.length;
        yield buffer;
      }
      manifest.entries.push({ name: entry.name, bytes, sha256: hash.digest('hex') });
    };
    yield { name: entry.name, content: counted() };
  }
  yield { name: MANIFEST, content: [JSON.stringify(manifest)] };
}

/** Why a decrypted backup is not a usable backup. */
export class BackupContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupContentError';
  }
}

export interface VerifiedBackup {
  readonly header: BackupHeader;
  readonly info: BackupInfo;
  readonly entries: readonly string[];
}

/** Writes to a program's input until it stops reading (pg_restore --list reads only the start). */
function inputOf(stdin: NodeJS.WritableStream & { destroyed: boolean; writableEnded: boolean }) {
  let closed = false;
  const stop = () => {
    closed = true;
  };
  stdin.on('close', stop);
  // EPIPE once it stops reading: expected, and its exit status says whether the dump was good.
  stdin.on('error', stop);
  return {
    async write(bytes: Buffer): Promise<void> {
      if (closed || stdin.destroyed) return;
      if (!stdin.write(bytes)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            stdin.off('drain', done);
            stdin.off('close', done);
            stdin.off('error', done);
            resolve();
          };
          stdin.on('drain', done);
          stdin.on('close', done);
          stdin.on('error', done);
        });
      }
    },
    end(): void {
      if (!closed && !stdin.writableEnded) stdin.end();
    },
  };
}

/**
 * Checks a backup file end to end (DATA-002): every chunk decrypts and authenticates, every entry
 * matches the manifest, the required entries are there, and `pg_restore --list` reads the
 * database dump. Throws `BackupFileError`, `ArchiveFormatError`, `BackupContentError` or
 * `PgToolError`.
 */
export async function verifyBackupFile(
  source: Readable,
  key: Buffer,
  options: { readonly pgBin: string | undefined; readonly databaseUrl: string },
): Promise<VerifiedBackup> {
  let header: BackupHeader | undefined;
  const decrypted = decryptBackup(key, {
    onHeader: (value) => {
      header = value;
    },
  });
  const seen: { name: string; bytes: number; sha256: string }[] = [];
  let info: BackupInfo | undefined;
  let manifest: BackupManifest | undefined;
  let dumpCheck: Promise<void> | undefined;
  let dumpInput: ReturnType<typeof inputOf> | undefined;

  const reading = readArchive(decrypted, (name) => {
    const hash = createHash('sha256');
    let bytes = 0;
    const parts: Buffer[] = [];
    const keep = name === BACKUP_INFO || name === MANIFEST;
    let input: ReturnType<typeof inputOf> | undefined;
    if (name === DATABASE_DUMP && dumpCheck === undefined) {
      const restore = runPgTool(
        pgProgram('pg_restore', options.pgBin),
        ['--list'],
        options.databaseUrl,
      );
      input = inputOf(restore.stdin as never);
      dumpInput = input;
      dumpCheck = restore.done;
      // Awaited below; never an unhandled rejection if the check stops early.
      dumpCheck.catch(() => undefined);
      // Read and drop what it lists.
      restore.stdout.resume();
    }
    return {
      async write(part) {
        hash.update(part);
        bytes += part.length;
        if (keep) parts.push(part);
        await input?.write(part);
      },
      end() {
        input?.end();
        if (name === MANIFEST) {
          manifest = parseJson(BackupManifest, Buffer.concat(parts), 'manifest');
          return;
        }
        seen.push({ name, bytes, sha256: hash.digest('hex') });
        if (name === BACKUP_INFO) info = parseJson(BackupInfo, Buffer.concat(parts), 'info');
      },
    };
  });
  let names: string[];
  try {
    [names] = await Promise.all([reading, pipeline(source, decrypted)]);
  } catch (error) {
    decrypted.destroy();
    source.destroy();
    throw error;
  } finally {
    // pg_restore must not wait for input that will never come.
    dumpInput?.end();
  }
  if (dumpCheck === undefined) throw new BackupContentError('The backup has no database.');
  await dumpCheck;
  if (header === undefined || info === undefined || manifest === undefined) {
    throw new BackupContentError('The backup is missing its description or manifest.');
  }
  if (names.at(-1) !== MANIFEST || !names.includes(SECRETS)) {
    throw new BackupContentError('The backup is incomplete.');
  }
  const expected = JSON.stringify(manifest.entries);
  if (JSON.stringify(seen) !== expected) {
    throw new BackupContentError('The backup does not match its manifest.');
  }
  return { header, info, entries: names };
}

function parseJson<T>(schema: z.ZodType<T>, bytes: Buffer, what: string): T {
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new BackupContentError(`The backup's ${what} is not readable.`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new BackupContentError(`The backup's ${what} is not readable.`);
  return parsed.data;
}

/** A readable for a list of strings and buffers (tests, small entries). */
export function readableOf(parts: readonly (Buffer | string)[]): Readable {
  return Readable.from(parts.map((part) => (typeof part === 'string' ? Buffer.from(part) : part)));
}
