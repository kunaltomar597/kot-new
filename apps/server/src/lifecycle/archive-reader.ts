import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { readArchive } from '../backups/backup-archive.js';
import { decryptBackup } from '../backups/backup-file.js';
import { ARCHIVE_INFO, ArchiveInfo, TABLES_PREFIX } from './business-archive.js';

/**
 * Reads an archived year without restoring it (DATA-009, P7-06c): the archive is decrypted and
 * streamed once, and each row of the tables asked for is handed over as it is read. A year at
 * design capacity is a few hundred MB, read in seconds; nothing is kept but what the handlers
 * keep.
 */

/** A row of an archived table as PostgreSQL wrote it (`row_to_json`, snake_case). */
export type ArchivedRow = Record<string, unknown>;

export interface TableScan {
  /** A cheap test on the raw line before it is parsed (an id, a date, a number). */
  readonly hint?: string;
  readonly each: (row: ArchivedRow) => void;
}

/** Streams the archive once through the handlers; returns its description. */
export async function scanArchive(
  file: string,
  key: Buffer,
  tables: Readonly<Record<string, TableScan>>,
): Promise<ArchiveInfo | undefined> {
  let info: ArchiveInfo | undefined;
  await readArchive(createReadStream(file).pipe(decryptBackup(key)), (name) => {
    if (name === ARCHIVE_INFO) {
      const parts: Buffer[] = [];
      return {
        write: (bytes: Buffer) => {
          parts.push(bytes);
        },
        end: () => {
          info = ArchiveInfo.parse(JSON.parse(Buffer.concat(parts).toString('utf8')));
        },
      };
    }
    const table = name.startsWith(TABLES_PREFIX)
      ? name.slice(TABLES_PREFIX.length).replace(/\.jsonl$/, '')
      : '';
    const scan = tables[table];
    if (scan === undefined) return { write: () => undefined, end: () => undefined };
    let carry = '';
    // A chunk may end inside a character; the decoder keeps its first bytes for the next one.
    const decoder = new StringDecoder('utf8');
    const take = (line: string) => {
      if (line === '') return;
      if (scan.hint !== undefined && !line.includes(scan.hint)) return;
      scan.each(JSON.parse(line) as ArchivedRow);
    };
    return {
      write: (bytes: Buffer) => {
        const lines = (carry + decoder.write(bytes)).split('\n');
        carry = lines.pop() ?? '';
        for (const line of lines) take(line);
      },
      end: () => {
        take(carry + decoder.end());
      },
    };
  });
  return info;
}

/** A snake_case archived row as the camelCase record the app reads, with its dates as dates. */
export function camelRow(row: ArchivedRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const name = key.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
    out[name] =
      typeof value === 'string' && /(At|Date)$/.test(name) && !Number.isNaN(Date.parse(value))
        ? new Date(value)
        : value;
  }
  return out;
}
