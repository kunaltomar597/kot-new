import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  checkFirmwareImage,
  FirmwareImageError,
  readFirmwareImage,
  verifyFirmwareSignature,
} from '../../src/pager-firmware/firmware-image.js';
import {
  type FirmwareKey,
  firmwareImage,
  firmwareKey,
  signFirmware,
} from '../helpers/pager-firmware.js';

/**
 * `rp-pager-1.0.0.bin` was signed by espsecure 5.4 (`sign-data --version 2`, RSA-3072); this is
 * its key's digest from `digest-sbv2-public-key`. The private key was thrown away.
 */
const ESPSECURE_IMAGE = readFileSync(
  join(import.meta.dirname, '../fixtures/pager-firmware/rp-pager-1.0.0.bin'),
);
const ESPSECURE_KEY = '0738aa2b81505436763f30e0e9e980a552a06cf50b8ec751bee88b963e63d719';

function problemOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof FirmwareImageError) return error.problem;
    throw error;
  }
  return undefined;
}

let key: FirmwareKey;
let other: FirmwareKey;

beforeAll(() => {
  key = firmwareKey();
  other = firmwareKey();
});

describe('[PGR-011] [UPD-007] checking pager firmware before passing it on', () => {
  it('reads the app description of an ESP-IDF image', () => {
    expect(readFirmwareImage(ESPSECURE_IMAGE)).toEqual({
      version: '1.0.0',
      projectName: 'rp-pager',
      chipId: 9,
      secureVersion: 0,
      idfVersion: 'v5.5.1',
    });
  });

  it('verifies the secure boot signature espsecure wrote, against the trusted key digest', () => {
    expect(verifyFirmwareSignature(ESPSECURE_IMAGE, [ESPSECURE_KEY])).toBe(ESPSECURE_KEY);
    expect(
      checkFirmwareImage(ESPSECURE_IMAGE, { version: '1.0.0' }, [ESPSECURE_KEY.toUpperCase()]),
    ).toMatchObject({ keyDigest: ESPSECURE_KEY, info: { version: '1.0.0' } });
  });

  it('refuses an image signed with a key the pagers do not trust, or when it trusts none', () => {
    expect(problemOf(() => verifyFirmwareSignature(ESPSECURE_IMAGE, [key.digest]))).toBe(
      'UNTRUSTED_KEY',
    );
    expect(problemOf(() => verifyFirmwareSignature(ESPSECURE_IMAGE, []))).toBe('NO_TRUSTED_KEY');
  });

  it('refuses a changed image or a forged signature block', () => {
    const changed = Buffer.from(ESPSECURE_IMAGE);
    changed[600] = (changed[600] ?? 0) ^ 0x01;
    expect(problemOf(() => verifyFirmwareSignature(changed, [ESPSECURE_KEY]))).toBe(
      'BAD_SIGNATURE',
    );
    // A block whose CRC does not match is no signature at all.
    const broken = Buffer.from(ESPSECURE_IMAGE);
    const sector = broken.length - 4096;
    broken[sector + 900] = (broken[sector + 900] ?? 0) ^ 0x01;
    expect(problemOf(() => verifyFirmwareSignature(broken, [ESPSECURE_KEY]))).toBe('NOT_SIGNED');
  });

  it('refuses an unsigned image', () => {
    const plain = firmwareImage({ version: '1.0.0' });
    expect(problemOf(() => verifyFirmwareSignature(plain, [key.digest]))).toBe('NOT_SIGNED');
    const padded = Buffer.concat([plain, Buffer.alloc(8192 - plain.length, 0xff)]);
    expect(problemOf(() => verifyFirmwareSignature(padded, [key.digest]))).toBe('NOT_SIGNED');
  });

  it('accepts any trusted block of the three, so a key can be rotated', () => {
    const signed = signFirmware(firmwareImage({ version: '1.2.0' }), other, key);
    expect(verifyFirmwareSignature(signed, [key.digest])).toBe(key.digest);
    expect(verifyFirmwareSignature(signed, [other.digest, key.digest])).toBe(other.digest);
  });

  it('refuses another chip, another project or another version than the release', () => {
    const check = (image: Buffer, version = '1.2.0') =>
      problemOf(() => checkFirmwareImage(signFirmware(image, key), { version }, [key.digest]));
    expect(check(firmwareImage({ version: '1.2.0' }))).toBeUndefined();
    expect(check(firmwareImage({ version: '1.2.0', chipId: 0 }))).toBe('WRONG_CHIP');
    expect(check(firmwareImage({ version: '1.2.0', project: 'blink' }))).toBe('WRONG_PROJECT');
    expect(check(firmwareImage({ version: '1.2.0' }), '1.3.0')).toBe('VERSION_MISMATCH');
    expect(problemOf(() => readFirmwareImage(Buffer.from('MZ not firmware')))).toBe('NOT_AN_IMAGE');
  });
});
