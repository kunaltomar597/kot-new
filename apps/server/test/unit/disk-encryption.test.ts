import { beforeEach, describe, expect, it } from 'vitest';
import {
  diskEncryption,
  driveOf,
  forgetDiskEncryption,
  parseProtectionStatus,
} from '../../src/system/disk-encryption.js';

describe('[SEC-007] the data drive’s encryption (PC-I5)', () => {
  beforeEach(forgetDiskEncryption);

  it('reads BitLocker’s protection status, suspended protection being not protected', () => {
    expect(parseProtectionStatus('On\r\n')).toBe('ENCRYPTED');
    expect(parseProtectionStatus('1')).toBe('ENCRYPTED');
    expect(parseProtectionStatus('Off')).toBe('NOT_ENCRYPTED');
    expect(parseProtectionStatus('0')).toBe('NOT_ENCRYPTED');
    expect(parseProtectionStatus('')).toBe('UNKNOWN');
    expect(parseProtectionStatus('Unknown')).toBe('UNKNOWN');
  });

  it('is UNKNOWN off Windows without asking', async () => {
    const probe = () => Promise.reject(new Error('must not run'));
    expect(await diskEncryption('/data', { platform: 'darwin', probe })).toBe('UNKNOWN');
  });

  it('asks about the data folder’s drive, remembers the answer, and says UNKNOWN when Windows cannot say', async () => {
    const asked: string[] = [];
    const probe = (drive: string) => {
      asked.push(drive);
      return Promise.resolve('Off');
    };
    const options = { platform: 'win32' as const, probe, now: 1_000 };
    expect(await diskEncryption('/data', options)).toBe('NOT_ENCRYPTED');
    expect(await diskEncryption('/data', { ...options, now: 2_000 })).toBe('NOT_ENCRYPTED');
    expect(asked).toEqual([driveOf('/data')]);
    expect(await diskEncryption('/data', { ...options, now: 1_000 + 11 * 60_000 })).toBe(
      'NOT_ENCRYPTED',
    );
    expect(asked).toHaveLength(2);

    forgetDiskEncryption();
    const failing = () => Promise.reject(new Error('Access denied'));
    expect(await diskEncryption('/data', { ...options, probe: failing })).toBe('UNKNOWN');
  });
});
