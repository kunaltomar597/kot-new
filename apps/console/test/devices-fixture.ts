import type {
  DeviceListResponse,
  DeviceView,
  PairingCodeResponse,
  StationListResponse,
} from '@rp/contracts';
import { DEVICE_ID, RESTAURANT_ID } from './fakes.js';
import { H1, PAGER_1, RAVI, SUNIL, T7 } from './sections-fixture.js';

/** Devices of every type for the Devices page (P4-02c). */

const uuid = (n: number) => `0199a0e0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const PAIRED_AT = '2026-09-20T10:00:00.000Z';

export const TANDOOR = uuid(901);
export const CURRY = uuid(902);
/** Archived: the old grill station. */
export const GRILL = uuid(903);

export const KDS_1 = uuid(911);
export const KDS_2 = uuid(912);
export const PHONE_1 = uuid(921);
export const TABLET_1 = uuid(931);
export const OFFICE = uuid(941);
export const GONE = uuid(951);

export function device(overrides: Partial<DeviceView> = {}): DeviceView {
  return {
    id: DEVICE_ID,
    type: 'POS',
    name: 'Counter POS',
    status: 'ACTIVE',
    tableId: null,
    stationId: null,
    staffId: null,
    pairedAt: PAIRED_AT,
    lastSeenAt: '2026-09-28T04:30:00.000Z',
    appVersion: '0.1.0',
    online: true,
    batteryPercent: null,
    batteryLow: false,
    firmwareVersion: null,
    serial: null,
    ...overrides,
  };
}

/**
 * This console (the Counter POS), a manager's laptop that was never connected, two kitchen screens
 * (one for the tandoor, one for every station), a waiter phone alerting Ravi, a tablet at H1 on a
 * low battery and last seen yesterday, Ravi's pager, and an unpaired POS that is not shown.
 */
export function devices(): DeviceView[] {
  return [
    device(),
    device({
      id: OFFICE,
      type: 'MANAGER_BROWSER',
      name: 'Office laptop',
      online: false,
      lastSeenAt: null,
      appVersion: null,
    }),
    device({ id: KDS_1, type: 'KDS', name: 'Tandoor screen', stationId: TANDOOR }),
    device({
      id: KDS_2,
      type: 'KDS',
      name: 'Pass screen',
      online: false,
      lastSeenAt: '2026-09-28T05:15:00.000Z',
    }),
    device({ id: PHONE_1, type: 'WAITER_PHONE', name: 'Waiter phone 1', staffId: RAVI }),
    device({
      id: TABLET_1,
      type: 'TABLE_TABLET',
      name: 'Table H1 tablet',
      tableId: H1,
      online: false,
      batteryPercent: 18,
      batteryLow: true,
      lastSeenAt: '2026-09-27T15:45:00.000Z',
      appVersion: '0.3.0',
    }),
    device({
      id: PAGER_1,
      type: 'PAGER',
      name: 'Pager 1',
      staffId: RAVI,
      batteryPercent: 80,
      appVersion: null,
      firmwareVersion: '1.0.3',
      serial: 'WP-0001',
    }),
    device({ id: GONE, name: 'Old POS', status: 'REVOKED', online: false }),
  ];
}

export function deviceList(list: DeviceView[] = devices()): DeviceListResponse {
  return { devices: list };
}

export function stationList(): StationListResponse {
  const station = (id: string, name: string, archived = false) => ({
    id,
    name,
    mode: 'SCREEN' as const,
    printerId: null,
    archivedAt: archived ? PAIRED_AT : null,
  });
  return {
    stations: [station(TANDOOR, 'Tandoor'), station(CURRY, 'Curry'), station(GRILL, 'Grill', true)],
  };
}

/** A pairing code as the server issues it, valid for `minutes` from now. */
export function pairingCode(overrides: Partial<PairingCodeResponse> = {}): PairingCodeResponse {
  const code = overrides.code ?? 'ABCD-EFGH';
  return {
    code,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    caSha256:
      '3A:7F:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD',
    serverUrls: ['https://192.168.1.20:8443', 'https://pos.local:8443'],
    qrPayload: JSON.stringify({ v: 1, code, urls: ['https://192.168.1.20:8443'] }),
    ...overrides,
  };
}

/** `DeviceLocateRequested` for a device, as the live connection delivers it. */
export function locateRequested(sequence: number, deviceId: string, name: string) {
  return {
    sequence,
    event: {
      eventId: `0199a0e0-0000-7000-8000-0000000009${String(sequence).padStart(2, '0')}`,
      type: 'DeviceLocateRequested',
      version: 1,
      occurredAt: new Date(Date.now() + sequence).toISOString(),
      restaurantId: RESTAURANT_ID,
      businessDate: '2026-09-28',
      payload: { deviceId, deviceType: 'POS', name },
    },
  };
}

export { H1, SUNIL, T7 };
