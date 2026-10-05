import { describe, expect, it } from 'vitest';
import {
  PAGER_FIRMWARE_RULES,
  type PagerFirmwareAttempt,
  type PagerFirmwareInput,
  type PagerFirmwarePager,
  pagerFirmwareTimedOut,
  pagerFirmwareVerdict,
} from '../src/pager-firmware.js';

const now = new Date('2026-10-05T10:00:00Z');
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

const free: PagerFirmwarePager = {
  connected: true,
  firmware: '1.0.0',
  batteryPercent: 80,
  charging: false,
  worn: false,
  openAlerts: 0,
};

function verdict(
  pager: Partial<PagerFirmwarePager> = {},
  rest: Partial<Omit<PagerFirmwareInput, 'pager'>> = {},
) {
  return pagerFirmwareVerdict({
    pager: { ...free, ...pager },
    served: '1.1.0',
    attempt: null,
    now,
    inMaintenanceWindow: false,
    updatingNow: 0,
    ...rest,
  });
}

const attempt = (
  state: PagerFirmwareAttempt['state'],
  minutes: number,
  attempts = 1,
  requestedAt: Date | null = null,
): PagerFirmwareAttempt => ({ state, attempts, changedAt: minutesAgo(minutes), requestedAt });

describe('[PGR-011] which pagers the PC offers its firmware to', () => {
  it('offers newer firmware to a free pager', () => {
    expect(verdict()).toEqual({ kind: 'OFFER' });
    // A prototype's version that does not parse counts as older.
    expect(verdict({ firmware: 'proto-3' })).toEqual({ kind: 'OFFER' });
  });

  it('leaves a pager on the same or a newer version alone', () => {
    expect(verdict({ firmware: '1.1.0' })).toEqual({ kind: 'UP_TO_DATE' });
    expect(verdict({ firmware: '1.2.0' })).toEqual({ kind: 'UP_TO_DATE' });
    // Even one that is not connected: nothing to do.
    expect(verdict({ firmware: '1.1.0', connected: false })).toEqual({ kind: 'UP_TO_DATE' });
  });

  it('waits for a pager that is not connected', () => {
    expect(verdict({ connected: false })).toEqual({ kind: 'WAIT', waitFor: 'NOT_CONNECTED' });
  });

  it('waits for a pager off its charger with too little battery', () => {
    const min = PAGER_FIRMWARE_RULES.minBatteryPercent;
    expect(verdict({ batteryPercent: min - 1 })).toEqual({ kind: 'WAIT', waitFor: 'BATTERY' });
    expect(verdict({ batteryPercent: null })).toEqual({ kind: 'WAIT', waitFor: 'BATTERY' });
    expect(verdict({ batteryPercent: min })).toEqual({ kind: 'OFFER' });
    expect(verdict({ batteryPercent: 5, charging: true })).toEqual({ kind: 'OFFER' });
  });

  it('[NTF-004] never reboots a pager with an alert its wearer has not acknowledged', () => {
    expect(verdict({ worn: true, openAlerts: 1 }, { inMaintenanceWindow: true })).toEqual({
      kind: 'WAIT',
      waitFor: 'ALERTS',
    });
  });

  it('[UPD-004] updates a worn pager only in the maintenance window or on "Update now"', () => {
    expect(verdict({ worn: true })).toEqual({ kind: 'WAIT', waitFor: 'IN_SERVICE' });
    expect(verdict({ worn: true }, { inMaintenanceWindow: true })).toEqual({ kind: 'OFFER' });
    expect(verdict({ worn: true }, { attempt: attempt('WAITING', 1, 0, minutesAgo(1)) })).toEqual({
      kind: 'OFFER',
    });
    // The request lasts for the version, also for a retry after a failure.
    expect(verdict({ worn: true }, { attempt: attempt('FAILED', 60, 1, minutesAgo(90)) })).toEqual({
      kind: 'OFFER',
    });
  });

  it('updates a few pagers at a time', () => {
    const max = PAGER_FIRMWARE_RULES.maxConcurrent;
    expect(verdict({}, { updatingNow: max })).toEqual({ kind: 'WAIT', waitFor: 'OTHERS_UPDATING' });
    expect(verdict({}, { updatingNow: max - 1 })).toEqual({ kind: 'OFFER' });
  });

  it('waits for an offer in progress until it times out', () => {
    expect(verdict({}, { attempt: attempt('OFFERED', 14) })).toEqual({ kind: 'IN_PROGRESS' });
    expect(verdict({}, { attempt: attempt('DOWNLOADING', 14) })).toEqual({ kind: 'IN_PROGRESS' });
    expect(pagerFirmwareTimedOut(attempt('OFFERED', 15), now)).toBe(true);
    expect(pagerFirmwareTimedOut(attempt('FAILED', 60), now)).toBe(false);
    // Timed out at 15 minutes, so tried again 30 minutes after that.
    expect(verdict({}, { attempt: attempt('OFFERED', 44) })).toEqual({
      kind: 'WAIT',
      waitFor: 'RETRY_LATER',
    });
    expect(verdict({}, { attempt: attempt('OFFERED', 45) })).toEqual({ kind: 'OFFER' });
  });

  it('tries a failed pager again later, a few times', () => {
    expect(verdict({}, { attempt: attempt('FAILED', 29) })).toEqual({
      kind: 'WAIT',
      waitFor: 'RETRY_LATER',
    });
    expect(verdict({}, { attempt: attempt('FAILED', 30, 2) })).toEqual({ kind: 'OFFER' });
    const max = PAGER_FIRMWARE_RULES.maxAttempts;
    expect(verdict({}, { attempt: attempt('FAILED', 600, max) })).toEqual({ kind: 'GAVE_UP' });
    expect(verdict({}, { attempt: attempt('OFFERED', 600, max) })).toEqual({ kind: 'GAVE_UP' });
  });

  it('never offers a version again to a pager that rolled back from it', () => {
    expect(verdict({}, { attempt: attempt('ROLLED_BACK', 6_000) })).toEqual({ kind: 'GAVE_UP' });
  });

  it('counts a pager that runs the version as up to date whatever its attempt says', () => {
    expect(verdict({ firmware: '1.1.0' }, { attempt: attempt('OFFERED', 1) })).toEqual({
      kind: 'UP_TO_DATE',
    });
  });
});
