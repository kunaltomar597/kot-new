import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import writeXlsxFile from 'write-excel-file/node';
import { cellText, readWorkbook } from '../../src/menu/import/workbook.js';
import { checkZipLimits, XLSX_MAX_ENTRY_BYTES } from '../../src/menu/import/zip-limits.js';

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
