import { promisify } from 'node:util';
import { crc32, inflateRaw } from 'node:zlib';

/**
 * A .xlsx is a ZIP archive, and a small upload must not expand into gigabytes (SEC-004, PC-D4).
 * `checkZipLimits` refuses an archive whose central directory says it unpacks too large, before
 * any of it is decompressed; `unpackWorkbook` then inflates each entry the workbook reader needs
 * with a limit on what comes out, so a directory that lies is caught too, and hands the reader
 * those entries again, stored, so it never inflates anything itself. ZIP64 archives are refused
 * (a menu never needs one).
 */
export const XLSX_MAX_ENTRY_BYTES = 20 * 1024 * 1024;
export const XLSX_MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const MAX_ENTRIES = 200;

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;
/** General-purpose flags: bit 0 encrypted; bit 11 the name is UTF-8. */
const ENCRYPTED = 0x0001;
const UTF8_NAME = 0x0800;

const inflate = promisify(inflateRaw);

/** An entry as the central directory describes it. */
interface ZipEntry {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
}

type Directory =
  | { readonly ok: true; readonly entries: readonly ZipEntry[] }
  | { readonly ok: false; readonly reason: 'NOT_ZIP' | 'TOO_LARGE' };

export type ZipCheck = { ok: true } | { ok: false; reason: 'NOT_ZIP' | 'TOO_LARGE' };

export type UnpackedWorkbook =
  | { readonly ok: true; readonly archive: Buffer }
  | { readonly ok: false; readonly reason: 'NOT_ZIP' | 'TOO_LARGE' | 'DAMAGED' };

function readDirectory(data: Buffer): Directory {
  // The end record is 22 bytes plus a comment of up to 65,535 bytes.
  let end = -1;
  for (
    let offset = data.length - 22;
    offset >= Math.max(0, data.length - 22 - 65_535);
    offset -= 1
  ) {
    if (data.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      end = offset;
      break;
    }
  }
  if (end < 0) return { ok: false, reason: 'NOT_ZIP' };
  const count = data.readUInt16LE(end + 10);
  const start = data.readUInt32LE(end + 16);
  if (count === 0xffff || start === 0xffffffff) return { ok: false, reason: 'TOO_LARGE' };
  if (count > MAX_ENTRIES) return { ok: false, reason: 'TOO_LARGE' };
  const entries: ZipEntry[] = [];
  let offset = start;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY) {
      return { ok: false, reason: 'NOT_ZIP' };
    }
    const size = data.readUInt32LE(offset + 24);
    if (size === 0xffffffff || size > XLSX_MAX_ENTRY_BYTES)
      return { ok: false, reason: 'TOO_LARGE' };
    total += size;
    if (total > XLSX_MAX_TOTAL_BYTES) return { ok: false, reason: 'TOO_LARGE' };
    const nameLength = data.readUInt16LE(offset + 28);
    if (offset + 46 + nameLength > data.length) return { ok: false, reason: 'NOT_ZIP' };
    entries.push({
      name: data.toString('utf8', offset + 46, offset + 46 + nameLength),
      flags: data.readUInt16LE(offset + 8),
      method: data.readUInt16LE(offset + 10),
      crc: data.readUInt32LE(offset + 16),
      compressedSize: data.readUInt32LE(offset + 20),
      size,
      localOffset: data.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + data.readUInt16LE(offset + 30) + data.readUInt16LE(offset + 32);
  }
  return { ok: true, entries };
}

/** Refuses an archive whose central directory says it unpacks to more than the limits. */
export function checkZipLimits(data: Buffer): ZipCheck {
  const directory = readDirectory(data);
  return directory.ok ? { ok: true } : directory;
}

/** What the workbook reader reads: the XML parts and their relationships, nothing else. */
const isWorkbookPart = (name: string) => name.endsWith('.xml') || name.endsWith('.xml.rels');

/** One entry's bytes, inflated to at most the size the directory gave; undefined if damaged. */
async function contentOf(data: Buffer, entry: ZipEntry): Promise<Buffer | 'TOO_LARGE' | undefined> {
  const content = await inflatedContentOf(data, entry);
  if (content === 'TOO_LARGE' || content === undefined) return content;
  return crc32(content) === entry.crc ? content : undefined;
}

async function inflatedContentOf(
  data: Buffer,
  entry: ZipEntry,
): Promise<Buffer | 'TOO_LARGE' | undefined> {
  const at = entry.localOffset;
  if ((entry.flags & ENCRYPTED) !== 0) return undefined;
  if (at + 30 > data.length || data.readUInt32LE(at) !== LOCAL_FILE_HEADER) return undefined;
  const start = at + 30 + data.readUInt16LE(at + 26) + data.readUInt16LE(at + 28);
  const end = start + entry.compressedSize;
  if (end > data.length) return undefined;
  const raw = data.subarray(start, end);
  if (entry.method === STORED) return raw.length === entry.size ? raw : undefined;
  if (entry.method !== DEFLATED) return undefined;
  try {
    // A byte more than the directory says is already a lie; inflating stops there.
    const content = await inflate(raw, { maxOutputLength: entry.size + 1 });
    if (content.length > entry.size) return 'TOO_LARGE';
    return content.length === entry.size ? content : undefined;
  } catch (error) {
    return (error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE' ? 'TOO_LARGE' : undefined;
  }
}

/**
 * The workbook's XML parts inflated within the limits and packed again as a stored ZIP for the
 * reader. An entry that inflates to more than the directory says is refused as too large; one
 * that is shorter, fails its checksum, is encrypted, compressed another way or named twice, as
 * damaged.
 */
export async function unpackWorkbook(data: Buffer): Promise<UnpackedWorkbook> {
  const directory = readDirectory(data);
  if (!directory.ok) return directory;
  const parts = new Map<string, Buffer>();
  for (const entry of directory.entries) {
    if (!isWorkbookPart(entry.name)) continue;
    if (parts.has(entry.name)) return { ok: false, reason: 'DAMAGED' };
    const content = await contentOf(data, entry);
    if (content === 'TOO_LARGE') return { ok: false, reason: 'TOO_LARGE' };
    if (content === undefined) return { ok: false, reason: 'DAMAGED' };
    parts.set(entry.name, content);
  }
  return { ok: true, archive: storedZip(parts) };
}

/** A ZIP of the given files, stored without compression. */
export function storedZip(files: ReadonlyMap<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_FILE_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAME, 6);
    local.writeUInt16LE(STORED, 8);
    local.writeUInt16LE(0x21, 12); // 1 January 1980, the earliest date a ZIP can hold
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_DIRECTORY_ENTRY, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_NAME, 8);
    central.writeUInt16LE(STORED, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, content);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + content.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
