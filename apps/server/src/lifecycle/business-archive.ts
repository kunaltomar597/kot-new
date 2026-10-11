import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { readArchive } from '../backups/backup-archive.js';
import { BackupContentError, BackupManifest, MANIFEST } from '../backups/backup-contents.js';
import { decryptBackup } from '../backups/backup-file.js';

/**
 * The archive of a financial year's business records (DATA-008, P7-06b): one encrypted file,
 * the backup file format (kind ARCHIVE), holding
 *
 *   archive.json            the year, when, which server, the restaurants, the count per table
 *   tables/<table>.jsonl    every row of the year, one JSON object per line, as PostgreSQL
 *                           returns it (`row_to_json`)
 *   manifest.json           the size and SHA-256 of every other entry
 *
 * The archive viewer (P7-06c) reads it without restoring anything into the live database.
 */

export const ARCHIVE_INFO = 'archive.json';
export const TABLES_PREFIX = 'tables/';

export const ArchiveInfo = z.object({
  format: z.literal(1),
  financialYear: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  createdAt: z.iso.datetime(),
  appVersion: z.string(),
  schemaVersion: z.string().nullable(),
  restaurants: z.array(z.object({ id: z.string(), name: z.string() })),
  /** Rows per table, in the order they are deleted. */
  counts: z.record(z.string(), z.int().nonnegative()),
  /** The audit log entries archived: the start of the chain up to this one. */
  auditChain: z.object({ to: z.int().nullable(), hash: z.string().nullable() }),
});
export type ArchiveInfo = z.infer<typeof ArchiveInfo>;

/** Rows as JSON lines, from an iterator of row batches. */
export async function* jsonLines(
  batches: AsyncIterable<readonly unknown[]>,
  count: (rows: number) => void,
): AsyncGenerator<string> {
  for await (const batch of batches) {
    if (batch.length === 0) continue;
    count(batch.length);
    yield `${batch.map((row) => JSON.stringify(row)).join('\n')}\n`;
  }
}

/**
 * Reads an archive back in full (DATA-008 step 3): every chunk decrypts and authenticates, every
 * entry matches the manifest, every table has the rows the description says. Returns the
 * description.
 */
export async function verifyBusinessArchive(file: string, key: Buffer): Promise<ArchiveInfo> {
  const seen = new Map<string, { bytes: number; lines: number; sha256: string }>();
  let info: ArchiveInfo | undefined;
  let manifest: BackupManifest | undefined;
  await readArchive(createReadStream(file).pipe(decryptBackup(key)), (name) => {
    const hash = createHash('sha256');
    const parts: Buffer[] = [];
    let bytes = 0;
    let lines = 0;
    const keep = name === ARCHIVE_INFO || name === MANIFEST;
    return {
      write(part: Buffer) {
        hash.update(part);
        bytes += part.length;
        for (const byte of part) if (byte === 0x0a) lines += 1;
        if (keep) parts.push(part);
      },
      end() {
        if (name === MANIFEST) {
          manifest = BackupManifest.parse(JSON.parse(Buffer.concat(parts).toString('utf8')));
          return;
        }
        seen.set(name, { bytes, lines, sha256: hash.digest('hex') });
        if (name === ARCHIVE_INFO) {
          info = ArchiveInfo.parse(JSON.parse(Buffer.concat(parts).toString('utf8')));
        }
      },
    };
  });
  if (info === undefined || manifest === undefined) {
    throw new BackupContentError('The archive is missing its description or manifest.');
  }
  for (const entry of manifest.entries) {
    const got = seen.get(entry.name);
    if (got?.bytes !== entry.bytes || got.sha256 !== entry.sha256) {
      throw new BackupContentError(`The archive's ${entry.name} does not match its manifest.`);
    }
  }
  for (const [table, rows] of Object.entries(info.counts)) {
    const got = seen.get(`${TABLES_PREFIX}${table}.jsonl`)?.lines ?? 0;
    if (got !== rows) {
      throw new BackupContentError(
        `The archive holds ${String(got)} rows of ${table}, not ${String(rows)}.`,
      );
    }
  }
  return info;
}
