import { describe, expect, it } from 'vitest';
import {
  bindingNamesOf,
  bindingOf,
  checkPairing,
  deviceBatteryOf,
  deviceGroups,
  holderChoices,
  lastSeenOf,
  nameProblem,
  newlyPaired,
  type PairForm,
  pairingRequestOf,
  reasonProblem,
  shortDateOf,
  stationChoices,
  suggestedName,
  tableChoices,
} from '../src/manage/devices/devices-view.js';
import {
  CURRY,
  device,
  devices,
  GONE,
  KDS_1,
  KDS_2,
  OFFICE,
  PHONE_1,
  stationList,
  TABLET_1,
  TANDOOR,
} from './devices-fixture.js';
import { DEVICE_ID } from './fakes.js';
import { H1, H2, PAGER_1, RAVI, sectionsFloor, SUNIL, T7, T8 } from './sections-fixture.js';
import { team } from './staff-fixture.js';

const names = () => bindingNamesOf(sectionsFloor(), stationList().stations, [...team(), SUNIL]);

describe('[MGR-006] the device list', () => {
  it('groups paired devices by type in the order a restaurant sets them up, each by name', () => {
    const groups = deviceGroups([
      ...devices(),
      device({ id: 'kds-10', type: 'KDS', name: 'Screen 10' }),
      device({ id: 'kds-9', type: 'KDS', name: 'Screen 9' }),
    ]);
    expect(groups.map((group) => group.type)).toEqual([
      'POS',
      'MANAGER_BROWSER',
      'KDS',
      'WAITER_PHONE',
      'TABLE_TABLET',
      'PAGER',
    ]);
    // Unpaired devices are gone; numbers sort as numbers.
    expect(groups[0]?.devices.map((entry) => entry.id)).toEqual([DEVICE_ID]);
    expect(groups.flatMap((group) => group.devices).some((entry) => entry.id === GONE)).toBe(false);
    expect(groups[2]?.devices.map((entry) => entry.name)).toEqual([
      'Pass screen',
      'Screen 9',
      'Screen 10',
      'Tandoor screen',
    ]);
    expect(deviceGroups([])).toEqual([]);
  });

  it('says what each device is bound to, even when the name is no longer known', () => {
    const all = new Map(devices().map((entry) => [entry.id, entry]));
    const of = (id: string) => bindingOf(all.get(id) ?? device(), names());
    expect(of(DEVICE_ID)).toEqual({ kind: 'NONE' });
    expect(of(OFFICE)).toEqual({ kind: 'NONE' });
    expect(of(KDS_1)).toEqual({ kind: 'STATION', station: 'Tandoor' });
    expect(of(KDS_2)).toEqual({ kind: 'ALL_STATIONS' });
    expect(of(PHONE_1)).toEqual({ kind: 'HOLDER', name: 'Ravi' });
    expect(of(TABLET_1)).toEqual({ kind: 'TABLE', table: 'H1' });
    expect(of(PAGER_1)).toEqual({ kind: 'WEARER', name: 'Ravi' });
    expect(bindingOf(device({ type: 'WAITER_PHONE' }), names())).toEqual({ kind: 'NO_HOLDER' });
    expect(bindingOf(device({ type: 'PAGER' }), names())).toEqual({ kind: 'NOT_WORN' });
    const empty = bindingNamesOf(undefined, [], []);
    expect(bindingOf(device({ type: 'TABLE_TABLET', tableId: H1 }), empty)).toEqual({
      kind: 'TABLE',
      table: undefined,
    });
    expect(bindingOf(device({ type: 'PAGER', staffId: RAVI }), empty)).toEqual({
      kind: 'WEARER',
      name: undefined,
    });
  });

  it('[TAB-015] gives the battery in words, low by the server’s level for the type', () => {
    expect(deviceBatteryOf(device())).toEqual({ kind: 'UNKNOWN' });
    expect(deviceBatteryOf(device({ batteryPercent: 18, batteryLow: true }))).toEqual({
      kind: 'LOW',
      percent: 18,
    });
    expect(deviceBatteryOf(device({ batteryPercent: 80 }))).toEqual({ kind: 'OK', percent: 80 });
  });

  it('says when a device was last seen in the restaurant’s time: today, or the day before', () => {
    // 10:30 in the restaurant (IST) on 28 September.
    const now = new Date('2026-09-28T05:00:00.000Z');
    expect(lastSeenOf(null, now)).toEqual({ kind: 'NEVER' });
    expect(lastSeenOf('2026-09-28T04:30:00.000Z', now)).toEqual({ kind: 'TODAY', time: '10:00' });
    // 23:00 IST on the 27th, although it is the 27th in UTC too…
    expect(lastSeenOf('2026-09-27T17:30:00.000Z', now)).toEqual({
      kind: 'EARLIER',
      date: '2026-09-27',
      time: '23:00',
    });
    // …and 00:15 IST on the 28th is today, although it is still the 27th in UTC.
    expect(lastSeenOf('2026-09-27T18:45:00.000Z', now)).toEqual({ kind: 'TODAY', time: '00:15' });
    expect(shortDateOf('2026-09-27', 'en-IN')).toMatch(/^27 Sep/);
  });
});

describe('[AUTH-007] [AUTH-009] pairing a device', () => {
  const form = (overrides: Partial<PairForm> = {}): PairForm => ({
    type: 'POS',
    name: 'POS 2',
    tableId: '',
    stationId: '',
    staffId: '',
    ...overrides,
  });

  it('needs a name, and a table for a table tablet', () => {
    expect(checkPairing(form())).toEqual({});
    expect(checkPairing(form({ name: '   ' }))).toEqual({ name: 'nameRequired' });
    expect(checkPairing(form({ type: 'TABLE_TABLET' }))).toEqual({ tableId: 'tableRequired' });
    expect(checkPairing(form({ type: 'TABLE_TABLET', tableId: H1 }))).toEqual({});
    expect(checkPairing(form({ name: 'x'.repeat(61) }))).toEqual({ name: 'nameRequired' });
  });

  it('sends only the binding the type uses, so a leftover choice never is', () => {
    const leftovers = { tableId: H1, stationId: TANDOOR, staffId: RAVI };
    expect(pairingRequestOf(form({ ...leftovers, name: ' POS 2 ' }))).toEqual({
      type: 'POS',
      name: 'POS 2',
    });
    expect(pairingRequestOf(form({ ...leftovers, type: 'TABLE_TABLET' }))).toEqual({
      type: 'TABLE_TABLET',
      name: 'POS 2',
      tableId: H1,
    });
    expect(pairingRequestOf(form({ ...leftovers, type: 'KDS' }))).toMatchObject({
      stationId: TANDOOR,
    });
    expect(pairingRequestOf(form({ type: 'KDS' }))).toEqual({ type: 'KDS', name: 'POS 2' });
    expect(pairingRequestOf(form({ ...leftovers, type: 'WAITER_PHONE' }))).toMatchObject({
      staffId: RAVI,
    });
  });

  it('suggests the first free number and finds the device that took the code', () => {
    const nameFor = (number: number) => `POS ${String(number)}`;
    expect(suggestedName([], nameFor)).toBe('POS 1');
    expect(suggestedName([{ name: 'pos 1' }, { name: 'POS 3' }], nameFor)).toBe('POS 2');

    const known = new Set(devices().map((entry) => entry.id));
    const paired = device({ id: 'new-pos', name: 'POS 2' });
    const request = { type: 'POS' as const, name: 'POS 2' };
    expect(newlyPaired(known, devices(), request)).toBeUndefined();
    expect(newlyPaired(known, [...devices(), paired], request)).toBe(paired);
    // Not another type or name, and not one unpaired since.
    expect(newlyPaired(known, [...devices(), { ...paired, type: 'KDS' }], request)).toBeUndefined();
    expect(
      newlyPaired(known, [...devices(), { ...paired, status: 'REVOKED' }], request),
    ).toBeUndefined();
  });

  it('offers tables, stations and people in use, not a tablet’s own table', () => {
    expect(tableChoices(sectionsFloor()).map((table) => table.id)).toEqual([H1, H2, T7, T8]);
    expect(tableChoices(sectionsFloor(), H1)).toEqual([
      { id: H2, label: 'H2', section: 'Hall' },
      { id: T7, label: 'T7', section: 'Terrace' },
      { id: T8, label: 'T8', section: 'Terrace' },
    ]);
    expect(tableChoices(undefined)).toEqual([]);
    expect(stationChoices(stationList().stations).map((station) => station.id)).toEqual([
      TANDOOR,
      CURRY,
    ]);
    const people = holderChoices([...team(), SUNIL]);
    expect(people.every((person) => person.active)).toBe(true);
    expect(people.map((person) => person.displayName)).toEqual(
      [...people.map((person) => person.displayName)].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('[MGR-006] [AUTH-008] checks a new name and the reason for unpairing like the server', () => {
    expect(nameProblem('Bar POS')).toBeUndefined();
    expect(nameProblem(' ')).toBe('nameRequired');
    expect(reasonProblem('Lost')).toBeUndefined();
    expect(reasonProblem(' ab ')).toBe('reasonRequired');
  });
});
