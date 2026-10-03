import { describe, expect, it } from 'vitest';
import {
  backupHealth,
  backupsToRemove,
  lastNightlySlot,
  nightlyBackupDue,
  weekStartOf,
} from '../src/backups.js';

/** A backup taken at 04:30 IST on the given date. */
const at = (date: string) => ({ name: `rp-${date}`, takenAt: new Date(`${date}T04:30:00+05:30`) });

function nightly(from: string, days: number) {
  const start = new Date(`${from}T00:00:00Z`).getTime();
  return Array.from({ length: days }, (_, index) =>
    at(new Date(start + index * 86_400_000).toISOString().slice(0, 10)),
  );
}

describe('[DATA-002] backup retention', () => {
  it('finds the Monday of a week', () => {
    expect(weekStartOf('2026-10-03')).toBe('2026-09-28'); // a Saturday
    expect(weekStartOf('2026-09-28')).toBe('2026-09-28'); // a Monday
    expect(weekStartOf('2026-10-04')).toBe('2026-09-28'); // a Sunday
  });

  it('keeps 14 daily and 8 weekly backups by default', () => {
    // Every night from 1 July to 3 October 2026.
    const backups = nightly('2026-07-01', 95);
    const removed = new Set(backupsToRemove(backups, 14, 8));
    const kept = backups.filter((backup) => !removed.has(backup.name)).map((b) => b.name);
    // The last 14 nights, and the newest of each of the 8 newest weeks (the Sundays before).
    expect(kept.slice(-14)).toEqual(nightly('2026-09-20', 14).map((b) => b.name));
    expect(kept.slice(0, -14)).toEqual([
      'rp-2026-08-16',
      'rp-2026-08-23',
      'rp-2026-08-30',
      'rp-2026-09-06',
      'rp-2026-09-13',
    ]);
    expect(kept).toHaveLength(19);
    // Oldest first.
    expect([...removed][0]).toBe('rp-2026-07-01');
  });

  it('keeps the newest of a day with several backups, and always the newest one', () => {
    const morning = { name: 'manual', takenAt: new Date('2026-10-03T10:00:00+05:30') };
    const night = at('2026-10-03');
    expect(backupsToRemove([night, morning], 1, 0)).toEqual(['rp-2026-10-03']);
    expect(backupsToRemove([night], 0, 0)).toEqual([]);
  });
});

describe('[DATA-002] the nightly backup', () => {
  const now = (time: string) => new Date(`2026-10-03T${time}:00+05:30`);

  it('is scheduled for the last 04:30 in India', () => {
    expect(lastNightlySlot(now('05:00'), '04:30').toISOString()).toBe('2026-10-02T23:00:00.000Z');
    expect(lastNightlySlot(now('04:00'), '04:30').toISOString()).toBe('2026-10-01T23:00:00.000Z');
  });

  it('is due when nothing succeeded since the slot, and retried after an hour', () => {
    const base = { nightlyAt: '04:30', lastAttemptAt: null };
    expect(nightlyBackupDue({ ...base, now: now('04:31'), lastSuccessAt: null })).toBe(true);
    expect(nightlyBackupDue({ ...base, now: now('04:31'), lastSuccessAt: now('04:30') })).toBe(
      false,
    );
    // The PC was off at 04:30: it catches up when it starts.
    expect(
      nightlyBackupDue({
        ...base,
        now: now('11:00'),
        lastSuccessAt: new Date('2026-10-02T04:31:00+05:30'),
      }),
    ).toBe(true);
    // A manual backup after the slot counts.
    expect(nightlyBackupDue({ ...base, now: now('11:00'), lastSuccessAt: now('09:00') })).toBe(
      false,
    );
    // It failed at 04:30: tried again from 05:30.
    const failed = { nightlyAt: '04:30', lastSuccessAt: null, lastAttemptAt: now('04:30') };
    expect(nightlyBackupDue({ ...failed, now: now('05:00') })).toBe(false);
    expect(nightlyBackupDue({ ...failed, now: now('05:30') })).toBe(true);
  });
});

describe('[DATA-005] backup health', () => {
  const now = new Date('2026-10-03T12:00:00Z');
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

  it('is failed, overdue, none or fine', () => {
    expect(backupHealth({ now, lastSuccessAt: null, lastFailureAt: null })).toBe('NONE');
    expect(backupHealth({ now, lastSuccessAt: hoursAgo(8), lastFailureAt: null })).toBe('OK');
    expect(backupHealth({ now, lastSuccessAt: hoursAgo(27), lastFailureAt: null })).toBe('OVERDUE');
    expect(backupHealth({ now, lastSuccessAt: hoursAgo(8), lastFailureAt: hoursAgo(1) })).toBe(
      'FAILED',
    );
    expect(backupHealth({ now, lastSuccessAt: hoursAgo(1), lastFailureAt: hoursAgo(8) })).toBe(
      'OK',
    );
  });
});
