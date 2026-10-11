import { describe, expect, it } from 'vitest';
import {
  apkUpdateVerdict,
  mayApplyAppUpdate,
  mayInstallApkUnattended,
  otaUpdateVerdict,
} from '../src/app-update.js';

const server = (current: string, oldest: string) => ({ current, oldest });

describe('[UPD-001] [UPD-006] an over-the-air update and the server it talks to', () => {
  it('applies an update speaking the server API or the one before it', () => {
    expect(otaUpdateVerdict(server('1.4', '1.3'), '1.4')).toBe('APPLY');
    expect(otaUpdateVerdict(server('1.4', '1.3'), '1.3')).toBe('APPLY');
    expect(otaUpdateVerdict(server('1.0', '1.0'), '1.0')).toBe('APPLY');
  });

  it('waits for the restaurant PC when the update speaks a newer API', () => {
    expect(otaUpdateVerdict(server('1.4', '1.3'), '1.5')).toBe('WAIT_FOR_SERVER');
    expect(otaUpdateVerdict(server('1.4', '1.3'), '2.0')).toBe('WAIT_FOR_SERVER');
  });

  it('never takes an update the server no longer serves', () => {
    expect(otaUpdateVerdict(server('1.4', '1.3'), '1.2')).toBe('NOT_SERVED');
    expect(otaUpdateVerdict(server('2.0', '2.0'), '1.9')).toBe('NOT_SERVED');
  });

  it('follows the range the server says, not one it works out', () => {
    // A server may serve a narrower range than N-1 (a new major serves only itself).
    expect(otaUpdateVerdict(server('1.4', '1.4'), '1.3')).toBe('NOT_SERVED');
  });

  it('does not take an update when either API is unknown', () => {
    expect(otaUpdateVerdict(undefined, '1.4')).toBe('UNKNOWN');
    expect(otaUpdateVerdict(server('1.4', '1.3'), undefined)).toBe('UNKNOWN');
    expect(otaUpdateVerdict(server('1.4', '1.3'), '1.4.0')).toBe('UNKNOWN');
    expect(otaUpdateVerdict(server('v1', '1.3'), '1.4')).toBe('UNKNOWN');
    expect(otaUpdateVerdict(server('1.4', ''), '1.4')).toBe('UNKNOWN');
  });
});

describe('[UPD-001] when a downloaded update restarts the app', () => {
  it('waits while the device is in use', () => {
    expect(mayApplyAppUpdate({ refused: false, busy: true })).toBe(false);
    expect(mayApplyAppUpdate({ refused: false, busy: false })).toBe(true);
  });

  it('switches at once when the server refuses the app as it is', () => {
    expect(mayApplyAppUpdate({ refused: true, busy: true })).toBe(true);
  });
});

describe('[WTR-001] [UPD-001] a new APK from the restaurant PC (P7-04e2)', () => {
  const build = { version: '1.5.0', clientApi: '1.4' };

  it('offers a newer build the server speaks', () => {
    expect(apkUpdateVerdict(server('1.4', '1.3'), '1.4.2', build)).toBe('OFFER');
    expect(apkUpdateVerdict(server('1.4', '1.3'), '1.5.0-rc.1', build)).toBe('OFFER');
  });

  it('leaves an app that is up to date, or newer, as it is', () => {
    expect(apkUpdateVerdict(server('1.4', '1.3'), '1.5.0', build)).toBe('UP_TO_DATE');
    expect(apkUpdateVerdict(server('1.4', '1.3'), '1.6.0', build)).toBe('UP_TO_DATE');
  });

  it('never installs a build whose client API the server does not serve', () => {
    expect(apkUpdateVerdict(server('1.3', '1.2'), '1.4.2', build)).toBe('NOT_SERVED');
    expect(apkUpdateVerdict(server('1.6', '1.5'), '1.4.2', build)).toBe('NOT_SERVED');
    expect(apkUpdateVerdict(undefined, '1.4.2', build)).toBe('NOT_SERVED');
  });

  it('installs nothing when the app does not know its own version', () => {
    expect(apkUpdateVerdict(server('1.4', '1.3'), undefined, build)).toBe('UNKNOWN');
  });

  it('[TAB-001] installs by itself only on a device-owner tablet, between guests or when refused', () => {
    expect(mayInstallApkUnattended({ silent: true, refused: false, busy: false })).toBe(true);
    expect(mayInstallApkUnattended({ silent: true, refused: true, busy: true })).toBe(true);
    expect(mayInstallApkUnattended({ silent: true, refused: false, busy: true })).toBe(false);
    // A phone, or a tablet without device owner: Android asks a person.
    expect(mayInstallApkUnattended({ silent: false, refused: true, busy: false })).toBe(false);
  });
});
