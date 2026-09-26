/**
 * Refuses a .xlsx (a ZIP archive) whose entries would unpack to more than the limits, before any
 * of it is decompressed: a small upload must not expand into gigabytes (SEC-004). Sizes come from
 * the central directory; ZIP64 archives are refused (a menu never needs one).
 */
export const XLSX_MAX_ENTRY_BYTES = 20 * 1024 * 1024;
export const XLSX_MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const MAX_ENTRIES = 200;

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;

export type ZipCheck = { ok: true } | { ok: false; reason: 'NOT_ZIP' | 'TOO_LARGE' };

export function checkZipLimits(data: Buffer): ZipCheck {
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
  const entries = data.readUInt16LE(end + 10);
  const start = data.readUInt32LE(end + 16);
  if (entries === 0xffff || start === 0xffffffff) return { ok: false, reason: 'TOO_LARGE' };
  if (entries > MAX_ENTRIES) return { ok: false, reason: 'TOO_LARGE' };
  let offset = start;
  let total = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY) {
      return { ok: false, reason: 'NOT_ZIP' };
    }
    const size = data.readUInt32LE(offset + 24);
    if (size === 0xffffffff || size > XLSX_MAX_ENTRY_BYTES)
      return { ok: false, reason: 'TOO_LARGE' };
    total += size;
    if (total > XLSX_MAX_TOTAL_BYTES) return { ok: false, reason: 'TOO_LARGE' };
    offset +=
      46 +
      data.readUInt16LE(offset + 28) +
      data.readUInt16LE(offset + 30) +
      data.readUInt16LE(offset + 32);
  }
  return { ok: true };
}
