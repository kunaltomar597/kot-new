import { describe, expect, it } from 'vitest';
import { parseMac, parseWindows } from '../../src/licensing/pc-fingerprint.js';

describe('[LIC-004] reading the PC’s identifiers', () => {
  it('reads the five from the Windows script, blanks as unread', () => {
    expect(
      parseWindows(
        JSON.stringify({
          MACHINE_ID: '6c1f2b0e-0000',
          BOARD_SERIAL: ' BSN-12 ',
          BIOS_UUID: '4C4C4544-0035',
          DISK_SERIAL: '',
          CPU_ID: 'BFEBFBFF000906EA',
        }),
      ),
    ).toEqual({
      MACHINE_ID: '6c1f2b0e-0000',
      BOARD_SERIAL: 'BSN-12',
      BIOS_UUID: '4C4C4544-0035',
      DISK_SERIAL: null,
      CPU_ID: 'BFEBFBFF000906EA',
    });
    expect(parseWindows('not json')).toEqual({});
  });

  it('reads what a Mac gives without privileges', () => {
    const ioreg = [
      '  "IOPlatformUUID" = "ABCDEF-1234"',
      '  "IOPlatformSerialNumber" = "C02XYZ"',
      '  "model" = <"MacBookPro18,3">',
    ].join('\n');
    expect(parseMac(ioreg, '   Volume UUID:   1111-2222\n', 'Apple M1 Pro\n')).toEqual({
      MACHINE_ID: 'ABCDEF-1234',
      BOARD_SERIAL: 'C02XYZ',
      BIOS_UUID: null,
      DISK_SERIAL: '1111-2222',
      CPU_ID: 'Apple M1 Pro',
    });
  });
});
