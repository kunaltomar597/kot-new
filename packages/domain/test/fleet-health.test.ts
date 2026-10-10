import { describe, expect, it } from 'vitest';
import {
  checkChainHead,
  checkCheckpoint,
  diskUsedPercent,
  type FleetHealthInput,
  fleetAlertsDue,
  offlineMinutesDuringHours,
  openSince,
  SELF_RESOLVING_ALERTS,
  tamperAlertDue,
  weekdayOf,
} from '../src/fleet-health.js';

const IST = 'Asia/Kolkata';
/** An IST wall-clock time as an instant. */
const ist = (local: string) => new Date(`${local}+05:30`);
// 2026-10-02 is a Friday.
const HOURS = [
  { day: 'FRI', start: '11:00', end: '15:00' },
  { day: 'FRI', start: '19:00', end: '01:00' },
  { day: 'SAT', start: '11:00', end: '23:30' },
] as const;

const healthy = (overrides: Partial<FleetHealthInput> = {}): FleetHealthInput => ({
  now: ist('2026-10-02T13:00:00'),
  lastSeenAt: ist('2026-10-02T12:58:00'),
  offlineAfterMinutes: 30,
  businessHours: { timeZone: IST, hours: HOURS },
  disk: { totalBytes: 500, freeBytes: 250 },
  diskAlertPercent: 90,
  backup: { lastSuccessAt: '2026-10-02T00:30:00.000Z', lastFailureAt: null },
  updateSigning: 'VENDOR',
  ...overrides,
});

describe('business hours', () => {
  it('names weekdays', () => {
    expect(weekdayOf('2026-10-02')).toBe('FRI');
    expect(weekdayOf('2026-10-04')).toBe('SUN');
    expect(weekdayOf('2026-10-05')).toBe('MON');
  });

  it('[VCP-005] knows when the current opening began, past midnight too', () => {
    expect(openSince(ist('2026-10-02T13:00:00'), HOURS, IST)).toEqual(ist('2026-10-02T11:00:00'));
    expect(openSince(ist('2026-10-02T16:00:00'), HOURS, IST)).toBeNull();
    expect(openSince(ist('2026-10-02T23:00:00'), HOURS, IST)).toEqual(ist('2026-10-02T19:00:00'));
    // Friday's late window runs into Saturday morning.
    expect(openSince(ist('2026-10-03T00:30:00'), HOURS, IST)).toEqual(ist('2026-10-02T19:00:00'));
    expect(openSince(ist('2026-10-03T01:00:00'), HOURS, IST)).toBeNull();
    expect(openSince(ist('2026-10-04T12:00:00'), HOURS, IST)).toBeNull();
  });
});

describe('[VCP-005] [DATA-005] fleet alert rules', () => {
  it('raises nothing for a healthy PC', () => {
    expect(fleetAlertsDue(healthy())).toEqual(new Set());
  });

  it('counts only silence while the restaurant is open', () => {
    // Silent since 10:00; open since 11:00: 120 minutes of business hours at 13:00.
    const silent = healthy({ lastSeenAt: ist('2026-10-02T10:00:00') });
    expect(offlineMinutesDuringHours(silent)).toBe(120);
    expect(fleetAlertsDue(silent)).toEqual(new Set(['OFFLINE']));
    // Closed in the afternoon: no alert however long it has been silent.
    expect(fleetAlertsDue({ ...silent, now: ist('2026-10-02T17:00:00') })).toEqual(new Set());
    // 19:20: silent since 10:00 but only 20 minutes of the evening opening so far.
    expect(fleetAlertsDue({ ...silent, now: ist('2026-10-02T19:20:00') })).toEqual(new Set());
    expect(fleetAlertsDue({ ...silent, now: ist('2026-10-02T19:31:00') })).toEqual(
      new Set(['OFFLINE']),
    );
  });

  it('treats a PC without hours as always open, and alerts only after the threshold', () => {
    const unknown = healthy({ businessHours: null, now: ist('2026-10-02T17:00:00') });
    expect(fleetAlertsDue({ ...unknown, lastSeenAt: ist('2026-10-02T16:30:00') })).toEqual(
      new Set(),
    );
    expect(fleetAlertsDue({ ...unknown, lastSeenAt: ist('2026-10-02T16:29:00') })).toEqual(
      new Set(['OFFLINE']),
    );
    const none = healthy({
      businessHours: { timeZone: IST, hours: [] },
      lastSeenAt: ist('2026-10-01T00:00:00'),
    });
    expect(fleetAlertsDue(none).has('OFFLINE')).toBe(true);
    expect(fleetAlertsDue(healthy({ lastSeenAt: null })).has('OFFLINE')).toBe(false);
  });

  it('alerts when the data drive is more than 90 % full', () => {
    expect(diskUsedPercent({ totalBytes: 1000, freeBytes: 101 })).toBe(89);
    expect(diskUsedPercent({ totalBytes: 0, freeBytes: 0 })).toBeNull();
    expect(fleetAlertsDue(healthy({ disk: { totalBytes: 1000, freeBytes: 100 } }))).toEqual(
      new Set(),
    );
    expect(fleetAlertsDue(healthy({ disk: { totalBytes: 1000, freeBytes: 89 } }))).toEqual(
      new Set(['DISK_FULL']),
    );
    expect(fleetAlertsDue(healthy({ disk: null }))).toEqual(new Set());
  });

  it('alerts while the latest backup failed, until one succeeds', () => {
    const failed = {
      lastSuccessAt: '2026-10-01T00:30:00.000Z',
      lastFailureAt: '2026-10-02T00:30:00.000Z',
    };
    expect(fleetAlertsDue(healthy({ backup: failed }))).toEqual(new Set(['BACKUP_FAILED']));
    expect(fleetAlertsDue(healthy({ backup: { ...failed, lastSuccessAt: null } }))).toEqual(
      new Set(['BACKUP_FAILED']),
    );
    expect(
      fleetAlertsDue(healthy({ backup: { ...failed, lastSuccessAt: '2026-10-02T01:00:00.000Z' } })),
    ).toEqual(new Set());
    expect(fleetAlertsDue(healthy({ backup: null }))).toEqual(new Set());
  });

  it('[UPD-007] alerts while a PC takes unsigned updates, a test build at a restaurant', () => {
    expect(fleetAlertsDue(healthy({ updateSigning: 'UNSIGNED' }))).toEqual(
      new Set(['UNSIGNED_UPDATES']),
    );
    // A build that installs no update at all, or a PC that does not say, is no such risk.
    expect(fleetAlertsDue(healthy({ updateSigning: 'NONE' }))).toEqual(new Set());
    expect(fleetAlertsDue(healthy({ updateSigning: null }))).toEqual(new Set());
    expect(SELF_RESOLVING_ALERTS).toContain('UNSIGNED_UPDATES');
  });
});

describe('[AUD-003] audit chain heads', () => {
  const known = [
    { sequence: 10, hash: 'a'.repeat(64) },
    { sequence: 25, hash: 'b'.repeat(64) },
  ];

  it('accepts a head that only grew', () => {
    expect(checkChainHead([], { sequence: 1, hash: 'c'.repeat(64) })).toEqual({ ok: true });
    expect(checkChainHead(known, { sequence: 25, hash: 'b'.repeat(64) })).toEqual({ ok: true });
    expect(checkChainHead(known, { sequence: 31, hash: 'c'.repeat(64) })).toEqual({ ok: true });
  });

  it('detects a chain cut back, rewritten or emptied', () => {
    expect(checkChainHead(known, { sequence: 20, hash: 'c'.repeat(64) })).toEqual({
      ok: false,
      reason: 'ROLLED_BACK',
      sequence: 20,
    });
    expect(checkChainHead(known, { sequence: 25, hash: 'c'.repeat(64) })).toEqual({
      ok: false,
      reason: 'REWRITTEN',
      sequence: 25,
    });
    expect(checkChainHead(known, null)).toEqual({ ok: false, reason: 'EMPTIED', sequence: 25 });
  });

  it('detects an old entry rewritten by the hash the PC holds for it now', () => {
    const head = { sequence: 10, hash: 'a'.repeat(64) };
    expect(
      checkCheckpoint(head, { sequence: 10, hash: 'a'.repeat(64), oldestSequence: 1 }),
    ).toEqual({ ok: true });
    expect(
      checkCheckpoint(head, { sequence: 10, hash: 'd'.repeat(64), oldestSequence: 1 }),
    ).toEqual({
      ok: false,
      reason: 'REWRITTEN',
      sequence: 10,
    });
    // Archived and purged (P7-06): gone legitimately.
    expect(checkCheckpoint(head, { sequence: 10, hash: null, oldestSequence: 40 })).toBe('PURGED');
    // Gone, but the log says it still starts before it: deleted.
    expect(checkCheckpoint(head, { sequence: 10, hash: null, oldestSequence: 5 })).toEqual({
      ok: false,
      reason: 'ROLLED_BACK',
      sequence: 10,
    });
  });
});

describe('[SEC-015] [LIC-007] tampering that calls for a person', () => {
  const now = new Date('2026-10-10T12:00:00.000Z');
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

  it('alerts at once for a licence or record changed, another PC, or a code never issued', () => {
    expect(tamperAlertDue([{ kind: 'LICENCE_TAMPERED', at: daysAgo(0) }], now)).toEqual([
      'LICENCE_TAMPERED',
    ]);
    expect(
      tamperAlertDue(
        [
          { kind: 'OTHER_PC', at: daysAgo(0) },
          { kind: 'RECORD_TAMPERED', at: daysAgo(0) },
        ],
        now,
      ),
    ).toEqual(['OTHER_PC', 'RECORD_TAMPERED']);
    expect(tamperAlertDue([], now, true)).toEqual(['REACTIVATION_CODE_NOT_ISSUED']);
    expect(tamperAlertDue([], now)).toEqual([]);
  });

  it('alerts for the clock only when it is reported again and again within a week', () => {
    const twice = [
      { kind: 'CLOCK_SKEW', at: daysAgo(2) },
      { kind: 'CLOCK_ROLLBACK', at: daysAgo(0) },
    ];
    expect(tamperAlertDue(twice, now)).toEqual([]);
    expect(tamperAlertDue([...twice, { kind: 'CLOCK_SKEW', at: daysAgo(5) }], now)).toEqual([
      'CLOCK_ROLLBACK',
      'CLOCK_SKEW',
    ]);
    // Older than the week: not repeated any more.
    expect(tamperAlertDue([...twice, { kind: 'CLOCK_SKEW', at: daysAgo(8) }], now)).toEqual([]);
  });
});
