import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { ByteQueue } from './backup-file.js';

/**
 * Reads the tar archive `pg_basebackup --format=tar` writes (P7-05c): files and folders, with
 * ustar prefixes, PAX and GNU long names, and GNU base-256 sizes. Links are refused: a base
 * backup of a cluster without tablespaces has none, and one could point a later file outside
 * the folder it is extracted into.
 */

const BLOCK = 512;

export class TarFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarFormatError';
  }
}

export interface TarEntry {
  /** A relative path with `/`, without a leading `./`. */
  readonly name: string;
  readonly type: 'file' | 'directory';
  readonly size: number;
}

/** Where a file's bytes go; undefined skips them. */
export interface TarSink {
  write(bytes: Buffer): Promise<void> | void;
  end(): Promise<void> | void;
}

function text(header: Buffer, offset: number, length: number): string {
  const raw = header.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? raw.length : end).toString('utf8');
}

function number(header: Buffer, offset: number, length: number): number {
  const raw = header.subarray(offset, offset + length);
  // GNU base-256, for sizes of 8 GB and more.
  if (((raw[0] ?? 0) & 0x80) !== 0) {
    let value = (raw[0] ?? 0) & 0x7f;
    for (let index = 1; index < raw.length; index += 1) value = value * 256 + (raw[index] ?? 0);
    return value;
  }
  const digits = text(header, offset, length).trim();
  if (digits === '') return 0;
  if (!/^[0-7]+$/.test(digits)) throw new TarFormatError('A file header is damaged.');
  return Number.parseInt(digits, 8);
}

function checksumOk(header: Buffer): boolean {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
  }
  return sum === number(header, 148, 8);
}

/** The `path` record of a PAX extended header. */
function paxPath(data: Buffer): string | undefined {
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const length = Number.parseInt(data.subarray(offset, space).toString('utf8'), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0 && record.slice(0, equals) === 'path') return record.slice(equals + 1);
    offset += length;
  }
  return undefined;
}

/** `./pg_wal/x` → `pg_wal/x`; refuses absolute paths and `..`. */
function cleanName(raw: string): string {
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.');
  if (raw.startsWith('/') || parts.some((part) => part === '..' || part.includes('\\'))) {
    throw new TarFormatError(`A path leaves the folder: ${raw}`);
  }
  return parts.join('/');
}

/**
 * Reads a tar stream to its end marker, handing each file's bytes to the sink `open` returns.
 * Returns the entries in order. Fails with `TarFormatError` on anything malformed or cut short.
 */
export async function readTar(
  source: AsyncIterable<Buffer>,
  open: (entry: TarEntry) => Promise<TarSink | undefined> | TarSink | undefined,
): Promise<TarEntry[]> {
  const iterator = source[Symbol.asyncIterator]();
  const queue = new ByteQueue();
  let ended = false;
  const fill = async (count: number): Promise<void> => {
    while (queue.size < count && !ended) {
      const next = await iterator.next();
      if (next.done === true) ended = true;
      else queue.push(next.value);
    }
  };
  const need = async (count: number): Promise<Buffer> => {
    await fill(count);
    if (queue.size < count) throw new TarFormatError('The archive is cut short.');
    return queue.take(count);
  };
  const entries: TarEntry[] = [];
  let longName: string | undefined;
  for (;;) {
    const header = await need(BLOCK);
    if (header.every((byte) => byte === 0)) break;
    if (!checksumOk(header)) throw new TarFormatError('A file header is damaged.');
    const type = String.fromCharCode(header[156] ?? 0);
    const size = number(header, 124, 12);
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x' || type === 'L' || type === 'g') {
      const data = (await need(padded)).subarray(0, size);
      if (type === 'L') longName = text(data, 0, size);
      else if (type === 'x') longName = paxPath(data) ?? longName;
      continue;
    }
    const prefix = text(header, 345, 155);
    const short = text(header, 0, 100);
    const name = cleanName(longName ?? (prefix === '' ? short : `${prefix}/${short}`));
    longName = undefined;
    if (type === '5') {
      if (name !== '') entries.push({ name, type: 'directory', size: 0 });
      continue;
    }
    if (type !== '0' && type !== '\0' && type !== '7') {
      throw new TarFormatError(`The archive holds a link or special file: ${name}`);
    }
    if (name === '') throw new TarFormatError('A file has no name.');
    const entry: TarEntry = { name, type: 'file', size };
    const sink = await open(entry);
    let left = size;
    while (left > 0) {
      const chunk = await need(Math.min(left, 1024 * 1024));
      await sink?.write(chunk);
      left -= chunk.length;
    }
    await sink?.end();
    if (padded > size) await need(padded - size);
    entries.push(entry);
  }
  // After the end marker only zero padding may follow.
  for (;;) {
    await fill(BLOCK);
    if (queue.size === 0) break;
    if (!queue.take(BLOCK).every((byte) => byte === 0)) {
      throw new TarFormatError('The archive has data after its end.');
    }
  }
  return entries;
}

/** Extracts a tar stream into `folder` (made, private); returns the entries. */
export async function extractTar(
  source: AsyncIterable<Buffer>,
  folder: string,
): Promise<TarEntry[]> {
  const root = resolve(folder);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const inside = (name: string): string => {
    const path = resolve(root, ...name.split('/'));
    if (path !== root && !path.startsWith(root + sep)) {
      throw new TarFormatError(`A path leaves the folder: ${name}`);
    }
    return path;
  };
  const entries = await readTar(source, async (entry) => {
    const path = inside(entry.name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const stream = createWriteStream(path, { mode: 0o600 });
    const failed = new Promise<never>((_resolve, reject) => {
      stream.once('error', reject);
    });
    failed.catch(() => undefined);
    return {
      async write(bytes: Buffer) {
        if (!stream.write(bytes)) {
          await Promise.race([
            new Promise<void>((ready) => {
              stream.once('drain', () => {
                ready();
              });
            }),
            failed,
          ]);
        }
      },
      async end() {
        await Promise.race([
          new Promise<void>((done) => {
            stream.end(() => {
              done();
            });
          }),
          failed,
        ]);
      },
    };
  });
  for (const entry of entries) {
    if (entry.type === 'directory')
      await mkdir(inside(entry.name), { recursive: true, mode: 0o700 });
  }
  return entries;
}
