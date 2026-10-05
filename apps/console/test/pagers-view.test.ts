import { describe, expect, it } from 'vitest';
import {
  batteryOf,
  checkPager,
  createPagerRequestOf,
  mayUpdateNow,
  pagerStateOf,
  suggestedName,
  wearersFor,
} from '../src/manage/staff/pagers-view.js';
import { crew, pager, RAVI, SUNIL } from './sections-fixture.js';

const nameFor = (number: number) => `Pager ${String(number)}`;

describe('[PGR-012] registering a pager', () => {
  it('suggests the first free pager number', () => {
    expect(suggestedName([], nameFor)).toBe('Pager 1');
    expect(
      suggestedName([pager(), pager({ name: 'pager 2' }), pager({ name: 'Pager 4' })], nameFor),
    ).toBe('Pager 3');
  });

  it('checks the serial and the name like the server', () => {
    const form = { serial: 'WP-0002', name: 'Pager 2', staffId: '' };
    expect(checkPager(form)).toEqual({});
    expect(checkPager({ ...form, serial: 'WP 2' })).toEqual({ serial: 'serialInvalid' });
    expect(checkPager({ ...form, serial: 'WP' })).toEqual({ serial: 'serialInvalid' });
    expect(checkPager({ ...form, name: '  ' })).toEqual({ name: 'nameRequired' });
    expect(createPagerRequestOf({ ...form, serial: ' WP-0002 ' })).toEqual({
      serial: 'WP-0002',
      name: 'Pager 2',
      staffId: null,
    });
    expect(createPagerRequestOf({ ...form, staffId: RAVI }).staffId).toBe(RAVI);
  });
});

describe('[PGR-013] [PGR-014] a pager’s row', () => {
  it('says whether it is connected and when it was last seen', () => {
    expect(pagerStateOf(pager())).toEqual({ kind: 'CONNECTED' });
    expect(pagerStateOf(pager({ online: false }))).toEqual({
      kind: 'NOT_CONNECTED',
      lastSeenAt: '2026-09-20T10:00:00.000Z',
    });
  });

  it('shows the battery against the restaurant’s low level, also while not connected', () => {
    expect(batteryOf(pager(), 15)).toEqual({ kind: 'OK', percent: 80 });
    expect(batteryOf(pager({ batteryPercent: 15, online: false }), 15)).toEqual({
      kind: 'LOW',
      percent: 15,
    });
    expect(batteryOf(pager({ batteryPercent: null }), 15)).toEqual({ kind: 'UNKNOWN' });
  });

  it('offers anyone active but the wearer, managers included, by name', () => {
    expect(wearersFor(crew(), pager()).map((person) => person.displayName)).toEqual([
      'Asha',
      'Imran',
      'Kunal',
      'Meera',
      'Sunil',
    ]);
    expect(wearersFor(crew()).map((person) => person.id)).toContain(RAVI);
    expect(wearersFor(crew()).map((person) => person.id)).toContain(SUNIL.id);
  });
});

describe('[PGR-011] [UPD-004] "Update now" for a pager', () => {
  const served = {
    version: '1.2.0',
    sha256: 'a'.repeat(64),
    sizeBytes: 1_500_000,
    acceptedAt: '2026-10-05T04:00:00.000Z',
    halted: false,
  };
  const update = (overrides: Partial<Parameters<typeof mayUpdateNow>[1] & object> = {}) => ({
    deviceId: 'p1',
    status: 'WAITING' as const,
    waitFor: 'IN_SERVICE' as const,
    attempts: 0,
    rolledBack: false,
    error: null,
    requested: false,
    ...overrides,
  });

  it('is offered for a pager that waits or was given up on', () => {
    expect(mayUpdateNow(served, update())).toBe(true);
    expect(mayUpdateNow(served, update({ status: 'GAVE_UP', waitFor: null }))).toBe(true);
  });

  it('is not offered while it updates, runs the firmware, was asked already, or is halted', () => {
    expect(mayUpdateNow(served, update({ status: 'UPDATING', waitFor: null }))).toBe(false);
    expect(mayUpdateNow(served, update({ status: 'UP_TO_DATE', waitFor: null }))).toBe(false);
    expect(mayUpdateNow(served, update({ requested: true, waitFor: 'BATTERY' }))).toBe(false);
    expect(mayUpdateNow({ ...served, halted: true }, update())).toBe(false);
    expect(mayUpdateNow(null, update())).toBe(false);
    expect(mayUpdateNow(served, undefined)).toBe(false);
  });
});
