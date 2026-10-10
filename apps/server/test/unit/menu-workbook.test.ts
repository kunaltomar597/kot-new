import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import writeXlsxFile from 'write-excel-file/node';
import { cellText, readWorkbook } from '../../src/menu/import/workbook.js';
import {
  checkZipLimits,
  storedZip,
  unpackWorkbook,
  XLSX_MAX_ENTRY_BYTES,
} from '../../src/menu/import/zip-limits.js';

/** A one-entry ZIP whose central directory claims `claimedSize` uncompressed bytes. */
function zipWith(claimedSize: number): Buffer {
  const name = Buffer.from('x.xml');
  const data = deflateRawSync(Buffer.from('<x/>'));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(claimedSize, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(claimedSize, 24);
  central.writeUInt16LE(name.length, 28);
  const centralOffset = local.length + name.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

interface Part {
  readonly name: string;
  readonly content: Buffer;
  /** What the local header and the central directory say it unpacks to (default: the truth). */
  readonly claimedSize?: number;
  readonly crc?: number;
  /** Deflated (default) or stored. */
  readonly stored?: boolean;
}

/** A ZIP of `parts` whose headers say what each part claims. */
function zipOf(parts: readonly Part[]): Buffer {
  const chunks: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name);
    const data = part.stored === true ? part.content : deflateRawSync(part.content);
    const size = part.claimedSize ?? part.content.length;
    const crc = part.crc ?? crc32(part.content);
    const method = part.stored === true ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    chunks.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

/** The method of each entry of a ZIP, by name, from its central directory. */
function methodsOf(zip: Buffer): Record<string, number> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let offset = zip.readUInt32LE(end + 16);
  const methods: Record<string, number> = {};
  for (let index = 0; index < zip.readUInt16LE(end + 10); index += 1) {
    const nameLength = zip.readUInt16LE(offset + 28);
    methods[zip.toString('utf8', offset + 46, offset + 46 + nameLength)] = zip.readUInt16LE(
      offset + 10,
    );
    offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  return methods;
}

describe('[SEC-004] [ONB-005] reading a menu workbook safely', () => {
  it('refuses archives that would unpack too large, and files that are not ZIPs', () => {
    expect(checkZipLimits(zipWith(4))).toEqual({ ok: true });
    expect(checkZipLimits(zipWith(XLSX_MAX_ENTRY_BYTES + 1))).toEqual({
      ok: false,
      reason: 'TOO_LARGE',
    });
    expect(checkZipLimits(zipWith(0xffffffff))).toEqual({ ok: false, reason: 'TOO_LARGE' });
    expect(checkZipLimits(Buffer.from('not a zip at all, just text'))).toEqual({
      ok: false,
      reason: 'NOT_ZIP',
    });
  });

  it('inflates the workbook with a limit on what comes out, whatever the directory says', async () => {
    // 64 MB of zeros deflate to about 64 KB; the headers say the part is 1,000 bytes.
    const bomb = zipOf([
      { name: 'xl/workbook.xml', content: Buffer.from('<workbook/>') },
      {
        name: 'xl/worksheets/sheet1.xml',
        content: Buffer.alloc(64 * 1024 * 1024),
        claimedSize: 1000,
      },
    ]);
    expect(bomb.length).toBeLessThan(200_000);
    expect(checkZipLimits(bomb)).toEqual({ ok: true });
    const started = performance.now();
    expect(await unpackWorkbook(bomb)).toEqual({ ok: false, reason: 'TOO_LARGE' });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(await readWorkbook(bomb)).toEqual({
      ok: false,
      message: 'The workbook unpacks to more than a menu needs. Remove other sheets or pictures.',
    });
  });

  it('refuses a part shorter than it says, with a wrong checksum, or named twice', async () => {
    const part = { name: 'xl/workbook.xml', content: Buffer.from('<workbook>menu</workbook>') };
    expect(await unpackWorkbook(zipOf([part]))).toMatchObject({ ok: true });
    for (const damaged of [
      zipOf([{ ...part, claimedSize: 100 }]),
      zipOf([{ ...part, stored: true, claimedSize: 100 }]),
      zipOf([{ ...part, crc: 1234 }]),
      zipOf([part, part]),
    ]) {
      expect(await unpackWorkbook(damaged)).toEqual({ ok: false, reason: 'DAMAGED' });
      expect(await readWorkbook(damaged)).toEqual({
        ok: false,
        message: 'The workbook could not be read. Save it again as .xlsx from Excel.',
      });
    }
  });

  it('gives the reader only the XML parts, stored, so it inflates nothing itself', async () => {
    const workbook = await writeXlsxFile([
      { sheet: 'Items', data: [['Item'], ['Tikka']] },
    ]).toBuffer();
    const withPicture = zipOf([
      ...Object.entries(methodsOf(workbook)).map(([name]) => ({
        name,
        content: Buffer.from(name),
      })),
      { name: 'xl/media/image1.png', content: Buffer.alloc(1000) },
    ]);
    const unpacked = await unpackWorkbook(withPicture);
    expect(unpacked.ok).toBe(true);
    if (!unpacked.ok) return;
    const methods = methodsOf(unpacked.archive);
    expect(Object.keys(methods)).not.toContain('xl/media/image1.png');
    expect(Object.keys(methods).length).toBeGreaterThan(3);
    expect(new Set(Object.values(methods))).toEqual(new Set([0]));
    const real = await unpackWorkbook(workbook);
    expect(real.ok && (await readWorkbook(real.archive))).toMatchObject({
      ok: true,
      sheets: { Items: [['Item'], ['Tikka']] },
    });
    expect(storedZip(new Map()).length).toBe(22);
  });

  it('turns cells into the text a person typed', () => {
    expect(cellText(249.5)).toBe('249.5');
    expect(cellText(0.1 + 0.2)).toBe('0.3');
    expect(cellText(new Date(Date.UTC(2026, 9, 20)))).toBe('2026-10-20');
    expect(cellText(new Date(Date.UTC(1899, 11, 30, 7, 30)))).toBe('07:30');
    expect(cellText(true)).toBe('Yes');
    expect(cellText(false)).toBe('No');
    expect(cellText(null)).toBe('');
    expect(cellText('Paneer')).toBe('Paneer');
    expect(cellText({})).toBe('');
  });

  it('reads the template sheets by name, ignoring case and other sheets', async () => {
    const buffer = await writeXlsxFile([
      {
        sheet: 'items',
        data: [
          ['Item', 'Price'],
          ['Tikka', 250],
        ],
      },
      { sheet: 'Notes', data: [['ignored']] },
    ]).toBuffer();
    expect(await readWorkbook(buffer)).toEqual({
      ok: true,
      sheets: {
        Items: [
          ['Item', 'Price'],
          ['Tikka', '250'],
        ],
      },
    });
    const broken = await readWorkbook(zipWith(4));
    expect(broken).toMatchObject({ ok: false });
  });
});
