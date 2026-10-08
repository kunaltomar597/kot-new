import { describe, expect, it } from 'vitest';
import {
  CreatePagerRequest,
  PAGER_QR_PREFIX,
  PagerSerial,
  pagerQrText,
  pagerSerialFromQr,
} from '../src/index.js';

describe("[PGR-012] a pager's QR code", () => {
  it('holds RP-PAGER: and the serial, in QR alphanumeric characters', () => {
    expect(PAGER_QR_PREFIX).toBe('RP-PAGER:');
    expect(pagerQrText('3C84279A1B2C')).toBe('RP-PAGER:3C84279A1B2C');
    // Upper-case letters, digits, "-" and ":" are QR's alphanumeric mode: a smaller code.
    expect(pagerQrText('3C84279A1B2C')).toMatch(/^[0-9A-Z $%*+\-./:]+$/);
  });

  it('gives back the serial of a pager code, with the prefix in any case', () => {
    expect(pagerSerialFromQr('RP-PAGER:3C84279A1B2C')).toBe('3C84279A1B2C');
    expect(pagerSerialFromQr('rp-pager:PGR-0042')).toBe('PGR-0042');
    expect(pagerSerialFromQr('  RP-PAGER:PGR-0042\r\n')).toBe('PGR-0042');
    expect(pagerSerialFromQr(pagerQrText('pgr-7'))).toBe('pgr-7');
  });

  it("reads a supplier's label with the bare serial too", () => {
    expect(pagerSerialFromQr('TWATCH-S3-0001')).toBe('TWATCH-S3-0001');
    expect(pagerSerialFromQr('PGR1\n')).toBe('PGR1');
  });

  it("refuses codes that are not a pager's", () => {
    for (const text of [
      '',
      'RP-PAGER:',
      'RP-PAGER:abc',
      'RP-PAGER:PGR 0042',
      'RP-PAGER:PGR_0042',
      `RP-PAGER:${'A'.repeat(33)}`,
      'https://menu.example.com/t/ABCD1234',
      '{"v":1,"code":"K7Q2-M9XD"}',
      'otpauth://totp/Spice%20Route:Asha?secret=JBSWY3DPEHPK3PXP',
      'RP-TABLE:T1',
    ]) {
      expect(pagerSerialFromQr(text), text).toBeUndefined();
    }
  });

  it('checks the serial the same way as registering a pager', () => {
    expect(CreatePagerRequest.shape.serial).toBe(PagerSerial);
    const scanned = pagerSerialFromQr('RP-PAGER:PGR-0042');
    expect(
      CreatePagerRequest.safeParse({ serial: scanned, name: 'Pager 1', staffId: null }).success,
    ).toBe(true);
  });
});
