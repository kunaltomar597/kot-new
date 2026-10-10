import { describe, expect, it } from 'vitest';
import {
  isNewerVersion,
  UPDATE_DOWNLOAD_RETRY_MAX_MS,
  updateDownloadRetryMs,
  updateSigningOf,
  updateTiming,
  type UpdateTimingInput,
} from '../src/software-update.js';

const IST = 'Asia/Kolkata';
/** A moment at `HH:MM` IST on 5 October 2026. */
const at = (time: string) => new Date(`2026-10-05T${time}:00+05:30`);

function input(overrides: Partial<UpdateTimingInput> = {}): UpdateTimingInput {
  return {
    now: at('04:00'),
    timeZone: IST,
    window: { start: '03:00', end: '06:00' },
    release: { version: '1.2.0', securityCritical: false },
    approval: null,
    openTables: 0,
    lastFailure: null,
    ...overrides,
  };
}

const approved = (version = '1.2.0', time = '12:00') => ({ version, approvedAt: at(time) });

describe('[UPD-004] when an update installs', () => {
  it('installs inside the maintenance window, start included and end excluded', () => {
    expect(updateTiming(input({ now: at('03:00') }))).toEqual({ install: true, trigger: 'WINDOW' });
    expect(updateTiming(input({ now: at('05:59') }))).toEqual({ install: true, trigger: 'WINDOW' });
    expect(updateTiming(input({ now: at('06:00') }))).toEqual({
      install: false,
      waitFor: 'WINDOW',
    });
    expect(updateTiming(input({ now: at('14:30') }))).toEqual({
      install: false,
      waitFor: 'WINDOW',
    });
  });

  it('reads the window in the restaurant’s time zone', () => {
    // 04:00 IST is 22:30 UTC the day before.
    expect(updateTiming(input({ now: new Date('2026-10-04T22:30:00Z') })).install).toBe(true);
    expect(updateTiming(input({ now: new Date('2026-10-05T04:00:00Z') })).install).toBe(false);
  });

  it('follows a window that runs past midnight', () => {
    const window = { start: '23:30', end: '02:00' };
    expect(updateTiming(input({ window, now: at('23:45') })).install).toBe(true);
    expect(updateTiming(input({ window, now: at('01:59') })).install).toBe(true);
    expect(updateTiming(input({ window, now: at('02:00') })).install).toBe(false);
  });

  it('installs outside the window when a manager pressed "Install now" for this version', () => {
    expect(updateTiming(input({ now: at('14:30'), approval: approved() }))).toEqual({
      install: true,
      trigger: 'APPROVED',
    });
    // An approval for another version does not count.
    expect(updateTiming(input({ now: at('14:30'), approval: approved('1.1.0') })).install).toBe(
      false,
    );
  });

  it('never installs while tables are open, in the window or approved', () => {
    expect(updateTiming(input({ openTables: 1 }))).toEqual({
      install: false,
      waitFor: 'OPEN_TABLES',
    });
    expect(updateTiming(input({ now: at('14:30'), openTables: 3, approval: approved() }))).toEqual({
      install: false,
      waitFor: 'OPEN_TABLES',
    });
  });

  it('installs a security-critical release with open tables only when a manager approved it', () => {
    const release = { version: '1.2.0', securityCritical: true };
    expect(updateTiming(input({ release, openTables: 2 }))).toEqual({
      install: false,
      waitFor: 'OPEN_TABLES',
    });
    expect(updateTiming(input({ release, openTables: 2, approval: approved() }))).toEqual({
      install: true,
      trigger: 'APPROVED',
    });
  });

  it('[UPD-005] does not try a version that failed here again by itself', () => {
    const lastFailure = { version: '1.2.0', at: at('03:20') };
    expect(updateTiming(input({ lastFailure }))).toEqual({
      install: false,
      waitFor: 'RETRY_APPROVAL',
    });
    // An approval given before the failure does not count again.
    expect(
      updateTiming(input({ lastFailure, approval: { version: '1.2.0', approvedAt: at('03:10') } })),
    ).toEqual({ install: false, waitFor: 'RETRY_APPROVAL' });
    // "Install now" after the failure tries again.
    expect(updateTiming(input({ lastFailure, approval: approved('1.2.0', '09:00') }))).toEqual({
      install: true,
      trigger: 'APPROVED',
    });
    // A failure of another version changes nothing.
    expect(
      updateTiming(input({ lastFailure: { version: '1.1.9', at: at('03:20') } })).install,
    ).toBe(true);
  });
});

describe('[UPD-002] versions and downloads', () => {
  it('moves only to a newer version', () => {
    expect(isNewerVersion('1.2.0', '1.1.9')).toBe(true);
    expect(isNewerVersion('1.2.0', '1.2.0')).toBe(false);
    expect(isNewerVersion('1.1.0', '1.2.0')).toBe(false);
    expect(isNewerVersion('1.2.0', '1.2.0-rc.1')).toBe(true);
    expect(isNewerVersion('not-a-version', '1.0.0')).toBe(false);
  });

  it('waits longer after each failed download, up to six hours', () => {
    expect(updateDownloadRetryMs(1)).toBe(5 * 60_000);
    expect(updateDownloadRetryMs(2)).toBe(10 * 60_000);
    expect(updateDownloadRetryMs(4)).toBe(40 * 60_000);
    expect(updateDownloadRetryMs(50)).toBe(UPDATE_DOWNLOAD_RETRY_MAX_MS);
    expect(updateDownloadRetryMs(0)).toBe(5 * 60_000);
  });
});

describe('[UPD-007] how a PC checks its updates', () => {
  it('says whether it takes only the vendor’s signature, unsigned installers too, or none', () => {
    const vendor = 'CN=Restaurant Platform Pvt Ltd, C=IN';
    expect(updateSigningOf({ publisher: vendor, allowUnsigned: false })).toBe('VENDOR');
    expect(updateSigningOf({ publisher: null, allowUnsigned: true })).toBe('UNSIGNED');
    // Unsigned installers pass even where a publisher is named, so that build counts as unsigned.
    expect(updateSigningOf({ publisher: vendor, allowUnsigned: true })).toBe('UNSIGNED');
    expect(updateSigningOf({ publisher: null, allowUnsigned: false })).toBe('NONE');
  });
});
