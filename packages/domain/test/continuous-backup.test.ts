import { describe, expect, it } from 'vitest';
import {
  type BaseBackupInfo,
  baseBackupsToRemove,
  continuousBackupState,
  walFilesToRemove,
  walPosition,
  walSwitchEveryMs,
} from '../src/continuous-backup.js';

const now = new Date('2026-10-03T12:00:00Z');
const hours = (count: number) => new Date(now.getTime() - count * 60 * 60_000);
const base = (name: string, endAt: Date, startSegment = '000000010000000000000010') =>
  ({ name, systemId: '7692286420070071139', endAt, startSegment }) satisfies BaseBackupInfo;

describe('[DATA-002] [DATA-004] continuous backup retention', () => {
  it('keeps the base backups of the last days and the newest one before them', () => {
    const backups = [
      base('d5', hours(5 * 24)),
      base('d4', hours(4 * 24)),
      base('d3', hours(3 * 24)),
      base('d2', hours(2 * 24 - 1)),
      base('d1', hours(24)),
      base('d0', hours(1)),
    ];
    // Two days: d2, d1 and d0 are inside; d3 is the newest before, so 2 days ago is covered.
    expect(baseBackupsToRemove(backups, now, 2)).toEqual(['d5', 'd4']);
    expect(baseBackupsToRemove(backups, now, 14)).toEqual([]);
  });

  it('always keeps the newest base backup, however old', () => {
    expect(
      baseBackupsToRemove([base('old', hours(500)), base('older', hours(600))], now, 1),
    ).toEqual(['older']);
    expect(baseBackupsToRemove([], now, 2)).toEqual([]);
  });

  it('removes the WAL before the oldest kept base backup and keeps timeline history', () => {
    const names = [
      '00000001000000000000000E',
      '00000001000000000000000F',
      '00000001000000000000000F.00000028.backup',
      '000000010000000000000010',
      '000000010000000000000011.partial',
      '00000002.history',
      '000000020000000000000012',
      'notes.txt',
    ];
    expect(walFilesToRemove(names, '000000010000000000000010')).toEqual([
      '00000001000000000000000E',
      '00000001000000000000000F',
      '00000001000000000000000F.00000028.backup',
    ]);
    // A cluster with no base backup left: its WAL is no use.
    expect(walFilesToRemove(names, null)).toEqual(names.filter((name) => name !== 'notes.txt'));
  });

  it('orders WAL by log position across timelines', () => {
    expect(walPosition('000000020000000100000003')).toBe('0000000100000003');
    expect(walPosition('00000002.history')).toBeNull();
    expect(walPosition('not-wal')).toBeNull();
  });
});

describe('[DATA-002] [DATA-005] continuous backup state', () => {
  const healthy = {
    setUp: true,
    now,
    mode: 'CONTINUOUS' as const,
    archiverFailing: false,
    lastError: null,
    oldestWaitingAt: null,
    lastBaseBackupAt: hours(3),
    secondLocationBehind: 0,
  };

  it('closes the log every 5 minutes, or every hour', () => {
    expect(walSwitchEveryMs('CONTINUOUS')).toBe(5 * 60_000);
    expect(walSwitchEveryMs('HOURLY')).toBe(60 * 60_000);
  });

  it('is OK when the archive keeps up and a base backup is recent', () => {
    expect(continuousBackupState(healthy)).toBe('OK');
    expect(continuousBackupState({ ...healthy, oldestWaitingAt: hours(0.2) })).toBe('OK');
  });

  it('is not set up until the installer turns archiving on', () => {
    expect(continuousBackupState({ ...healthy, setUp: false, archiverFailing: true })).toBe(
      'NOT_SET_UP',
    );
  });

  it('fails when PostgreSQL cannot hand over WAL or the archiving fails', () => {
    expect(continuousBackupState({ ...healthy, archiverFailing: true })).toBe('FAILING');
    expect(continuousBackupState({ ...healthy, lastError: 'disk full' })).toBe('FAILING');
  });

  it('is behind without a recent base backup, with WAL waiting or a second copy missing', () => {
    expect(continuousBackupState({ ...healthy, lastBaseBackupAt: null })).toBe('BEHIND');
    expect(continuousBackupState({ ...healthy, lastBaseBackupAt: hours(27) })).toBe('BEHIND');
    expect(continuousBackupState({ ...healthy, oldestWaitingAt: hours(0.5) })).toBe('BEHIND');
    expect(continuousBackupState({ ...healthy, mode: 'HOURLY', oldestWaitingAt: hours(0.5) })).toBe(
      'OK',
    );
    expect(continuousBackupState({ ...healthy, secondLocationBehind: 3 })).toBe('BEHIND');
  });
});
