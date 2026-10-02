import type { DeviceView, PairingCodeResponse, StationView } from '@rp/contracts';
import { DEVICE_ID } from './fakes.js';
import { H1, PAGER_1, RAVI, T7 } from './sections-fixture.js';

/** Devices of every kind for the Devices page (P4-02c). */

const uuid = (n: number) => `0199a0e0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const AT = '2026-09-28T04:30:00.000Z';

export const TANDOOR = uuid(901);
export const BAR = uuid(902);
/** Archived station: never offered for a new screen. */
export const GRILL = uuid(903);

export const TABLET_T7 = uuid(911);
export const KDS_TANDOOR = uuid(912);
export const PHONE_RAVI = uuid(913);
export const OLD_PHONE = uuid(914);

export function stationList(): { stations: StationView[] } {
  return {
    stations: [
      { id: TANDOOR, name: 'Tandoor', mode: 'SCREEN', printerId: null, archivedAt: null },
      { id: BAR, name: 'Bar', mode: 'SCREEN', printerId: null, archivedAt: null },
      { id: GRILL, name: 'Grill', mode: 'SCREEN', printerId: null, archivedAt: AT },
    ],
  };
}

export function deviceView(overrides: Partial<DeviceView> = {}): DeviceView {
  return {
    id: TABLET_T7,
    type: 'TABLE_TABLET',
    name: 'Tablet T7',
    status: 'ACTIVE',
    tableId: T7,
    stationId: null,
    stationIds: [],
    staffId: null,
    pairedAt: AT,
    lastSeenAt: AT,
    appVersion: '1.4.0',
    connected: true,
    batteryPercent: null,
    charging: null,
    network: null,
    rssi: null,
    firmwareVersion: null,
    serial: null,
    revokedAt: null,
    ...overrides,
  };
}

/** This console, a tablet, a kitchen screen, a waiter phone, a pager and an unpaired phone. */
export function deviceList(): { devices: DeviceView[] } {
  return {
    devices: [
      deviceView({
        id: DEVICE_ID,
        type: 'POS',
        name: 'Counter POS',
        tableId: null,
        appVersion: null,
      }),
      // The tablet reports its health (TAB-015).
      deviceView({ batteryPercent: 42, charging: true, network: 'WIFI', rssi: -60 }),
      deviceView({
        id: KDS_TANDOOR,
        type: 'KDS',
        name: 'Tandoor screen',
        tableId: null,
        stationId: TANDOOR,
        stationIds: [TANDOOR],
        connected: false,
        appVersion: null,
      }),
      deviceView({
        id: PHONE_RAVI,
        type: 'WAITER_PHONE',
        name: 'Waiter phone 1',
        tableId: null,
        staffId: RAVI,
        lastSeenAt: null,
        connected: false,
      }),
      deviceView({
        id: PAGER_1,
        type: 'PAGER',
        name: 'Pager 1',
        tableId: null,
        staffId: RAVI,
        batteryPercent: 80,
        firmwareVersion: '1.0.3',
        serial: 'WP-0001',
        appVersion: null,
      }),
      deviceView({
        id: OLD_PHONE,
        type: 'WAITER_PHONE',
        name: 'Old phone',
        tableId: null,
        status: 'REVOKED',
        connected: false,
        revokedAt: '2026-09-27T14:00:00.000Z',
      }),
    ],
  };
}

export function pairingCode(overrides: Partial<PairingCodeResponse> = {}): PairingCodeResponse {
  return {
    code: 'ABCD-EFGH',
    expiresAt: '2099-01-01T00:00:00.000Z',
    caSha256:
      'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89',
    serverUrls: ['https://192.168.1.20:8443'],
    qrPayload: '{"v":1,"code":"ABCD-EFGH"}',
    ...overrides,
  };
}

export { H1, T7 };
