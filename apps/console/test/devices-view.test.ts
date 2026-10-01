import { describe, expect, it } from 'vitest';
import {
  bindingOf,
  checkPairing,
  countdown,
  groupDevices,
  holderChoices,
  namesOf,
  pairingRequestOf,
  secondsLeft,
  stationChoices,
  suggestedDeviceName,
  tableChoices,
} from '../src/manage/devices/devices-view.js';
import {
  BAR,
  deviceList,
  deviceView,
  KDS_TANDOOR,
  OLD_PHONE,
  stationList,
  TANDOOR,
} from './devices-fixture.js';
import { DEVICE_ID, STAFF } from './fakes.js';
import { crew, H1, H2, RAVI, sectionsFloor, T7, T8 } from './sections-fixture.js';

const names = () => namesOf(sectionsFloor(), stationList().stations, crew());

describe('[MGR-006] the device list', () => {
  it('groups paired devices by type in floor order and keeps unpaired ones apart', () => {
    const { groups, unpaired } = groupDevices(deviceList().devices);
    expect(groups.map((group) => group.type)).toEqual([
      'POS',
      'KDS',
      'WAITER_PHONE',
      'TABLE_TABLET',
      'PAGER',
    ]);
    expect(groups[0]?.devices.map((device) => device.id)).toEqual([DEVICE_ID]);
    expect(unpaired.map((device) => device.id)).toEqual([OLD_PHONE]);
  });

  it('sorts devices of a type by name, numbers in order', () => {
    const { groups } = groupDevices([
      deviceView({ id: 'b', name: 'Tablet 10' }),
      deviceView({ id: 'a', name: 'Tablet 2' }),
    ]);
    expect(groups[0]?.devices.map((device) => device.name)).toEqual(['Tablet 2', 'Tablet 10']);
  });

  it('[AUTH-009] [KDS-002] says what each device is bound to', () => {
    const [, tablet, kds, phone, pager] = deviceList().devices;
    expect(bindingOf(tablet!, names())).toEqual({ kind: 'TABLE', label: 'T7' });
    expect(bindingOf(kds!, names())).toEqual({ kind: 'STATION', name: 'Tandoor' });
    expect(bindingOf(deviceView({ type: 'KDS', tableId: null }), names())).toEqual({
      kind: 'ALL_STATIONS',
    });
    expect(bindingOf(phone!, names())).toEqual({ kind: 'PERSON', name: 'Ravi' });
    expect(bindingOf(pager!, names())).toEqual({ kind: 'PERSON', name: 'Ravi' });
    expect(bindingOf(deviceView({ type: 'POS', tableId: null }), names())).toEqual({
      kind: 'NONE',
    });
  });
});

describe('[AUTH-007] pairing a device', () => {
  it('offers only active tables and stations, and people who take orders', () => {
    expect(tableChoices(sectionsFloor()).map((choice) => choice.value)).toEqual([H1, H2, T7, T8]);
    expect(tableChoices(sectionsFloor())[2]?.label).toBe('T7 · Terrace');
    expect(stationChoices(stationList().stations).map((choice) => choice.value)).toEqual([
      TANDOOR,
      BAR,
    ]);
    const holders = holderChoices(crew()).map((choice) => choice.label);
    expect(holders).toContain('Ravi');
    expect(holders).not.toContain('Priya');
    expect(holders).not.toContain(STAFF.KITCHEN.displayName);
  });

  it('[AUTH-009] needs a name, and a table for a table tablet', () => {
    const form = {
      type: 'TABLE_TABLET' as const,
      name: ' ',
      tableId: '',
      stationId: '',
      staffId: '',
    };
    expect(checkPairing(form)).toEqual({ name: 'nameRequired', tableId: 'tableRequired' });
    expect(checkPairing({ ...form, name: 'Tablet', tableId: T7 })).toEqual({});
    expect(checkPairing({ ...form, type: 'KDS', name: 'Screen' })).toEqual({});
  });

  it('sends only the binding the type uses', () => {
    const form = { name: ' Screen ', tableId: T7, stationId: TANDOOR, staffId: RAVI };
    expect(pairingRequestOf({ ...form, type: 'KDS' })).toEqual({
      type: 'KDS',
      name: 'Screen',
      stationId: TANDOOR,
    });
    expect(pairingRequestOf({ ...form, type: 'TABLE_TABLET' })).toEqual({
      type: 'TABLE_TABLET',
      name: 'Screen',
      tableId: T7,
    });
    expect(pairingRequestOf({ ...form, type: 'WAITER_PHONE', staffId: '' })).toEqual({
      type: 'WAITER_PHONE',
      name: 'Screen',
    });
    expect(pairingRequestOf({ ...form, type: 'POS' })).toEqual({ type: 'POS', name: 'Screen' });
  });

  it('suggests the first free name, ignoring unpaired devices', () => {
    const devices = [
      deviceView({ name: 'Kitchen screen 1', id: KDS_TANDOOR }),
      deviceView({ name: 'Kitchen screen 2', status: 'REVOKED' }),
    ];
    expect(suggestedDeviceName(devices, (n) => `Kitchen screen ${String(n)}`)).toBe(
      'Kitchen screen 2',
    );
  });

  it('counts the code down and never below zero', () => {
    const expires = '2026-09-28T10:10:00.000Z';
    expect(secondsLeft(expires, Date.parse('2026-09-28T10:00:00.000Z'))).toBe(600);
    expect(secondsLeft(expires, Date.parse('2026-09-28T10:10:05.000Z'))).toBe(0);
    expect(countdown(600)).toBe('10:00');
    expect(countdown(65)).toBe('1:05');
  });
});
