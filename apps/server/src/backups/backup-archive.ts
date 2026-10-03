import { ByteQueue } from './backup-file.js';

/**
 * The files inside a backup (P7-05a), before encryption: named entries, each a run of framed
 * bytes, so an entry of unknown length (the database dump as `pg_dump` writes it) streams
 * straight in.
 *
 *   entry:  name length (u32) | name (UTF-8) | frames: length (u32) | bytes ... | 0 (u32)
 *   end:    0 (u32) where the next name length would be
 */

const FRAME_BYTES = 256 * 1024;
const MAX_NAME_BYTES = 1024;

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

export interface ArchiveEntry {
  /** A relative path with `/`, e.g. `database.dump` or `files/photos/ab/cd.webp`. */
  readonly name: string;
  readonly content: AsyncIterable<Buffer | string> | Iterable<Buffer | string>;
}

/** A safe entry name: relative, `/`-separated, no `..`, no empty parts. */
export function isSafeEntryName(name: string): boolean {
  if (name === '' || Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) return false;
  if (name.includes('\\') || name.includes('\0')) return false;
  return name.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** The archive's bytes, entry after entry. */
export async function* writeArchive(
  entries: AsyncIterable<ArchiveEntry> | Iterable<ArchiveEntry>,
): AsyncGenerator<Buffer> {
  for await (const entry of entries) {
    if (!isSafeEntryName(entry.name)) throw new Error(`Unsafe backup entry name: ${entry.name}`);
    const name = Buffer.from(entry.name, 'utf8');
    yield Buffer.concat([u32(name.length), name]);
    for await (const piece of entry.content) {
      const bytes = typeof piece === 'string' ? Buffer.from(piece, 'utf8') : piece;
      for (let offset = 0; offset < bytes.length; offset += FRAME_BYTES) {
        const frame = bytes.subarray(offset, offset + FRAME_BYTES);
        yield Buffer.concat([u32(frame.length), frame]);
      }
    }
    yield u32(0);
  }
  yield u32(0);
}

/** What to do with one entry's bytes as they are read. */
export interface EntrySink {
  write(bytes: Buffer): Promise<void> | void;
  end(): Promise<void> | void;
}

/** Thrown when the archive inside a (correctly decrypted) backup is malformed. */
export class ArchiveFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveFormatError';
  }
}

/**
 * Reads an archive, handing each entry's bytes to the sink `open` returns for its name. The
 * archive must end with its end marker and nothing after it.
 */
export async function readArchive(
  source: AsyncIterable<Buffer>,
  open: (name: string) => Promise<EntrySink> | EntrySink,
): Promise<string[]> {
  const iterator = source[Symbol.asyncIterator]();
  const queue = new ByteQueue();
  let done = false;
  const need = async (count: number): Promise<Buffer> => {
    while (queue.size < count && !done) {
      const next = await iterator.next();
      if (next.done === true) done = true;
      else queue.push(next.value);
    }
    if (queue.size < count)
      throw new ArchiveFormatError('The backup ends in the middle of a file.');
    return queue.take(count);
  };
  const names: string[] = [];
  for (;;) {
    const nameLength = (await need(4)).readUInt32BE(0);
    if (nameLength === 0) break;
    if (nameLength > MAX_NAME_BYTES) throw new ArchiveFormatError('A file name is too long.');
    const name = (await need(nameLength)).toString('utf8');
    if (!isSafeEntryName(name)) throw new ArchiveFormatError(`Unsafe file name: ${name}`);
    const sink = await open(name);
    for (;;) {
      const length = (await need(4)).readUInt32BE(0);
      if (length === 0) break;
      if (length > FRAME_BYTES) throw new ArchiveFormatError('A frame is too long.');
      await sink.write(await need(length));
    }
    await sink.end();
    names.push(name);
  }
  // Nothing may follow the end marker.
  if (queue.size > 0) throw new ArchiveFormatError('The backup has data after its end.');
  for (;;) {
    const next = await iterator.next();
    if (next.done === true) break;
    if (next.value.length > 0) throw new ArchiveFormatError('The backup has data after its end.');
  }
  return names;
}
