import {
  CreatePairingCodeRequest,
  type DeviceView,
  DeviceName,
  type FloorResponse,
  type StaffView,
  type StationView,
} from '@rp/contracts';

/** Devices (P4-02c, MGR-006): what the device list says and what pairing a new device asks. */

/** Types a manager pairs from this page. Pagers are registered by serial on the Pagers page. */
export const PAIRABLE_TYPES = [
  'TABLE_TABLET',
  'WAITER_PHONE',
  'KDS',
  'POS',
  'MANAGER_BROWSER',
] as const;
export type PairableType = (typeof PAIRABLE_TYPES)[number];

/** The order device groups appear in: what the floor relies on first. */
const TYPE_ORDER: readonly DeviceView['type'][] = [
  'POS',
  'KDS',
  'WAITER_PHONE',
  'TABLE_TABLET',
  'PAGER',
  'MANAGER_BROWSER',
];

export interface DeviceGroup {
  readonly type: DeviceView['type'];
  readonly devices: readonly DeviceView[];
}

/** Paired devices by type (in floor order), each group by name; unpaired ones apart, newest first. */
export function groupDevices(devices: readonly DeviceView[]): {
  readonly groups: readonly DeviceGroup[];
  readonly unpaired: readonly DeviceView[];
} {
  const byName = (a: DeviceView, b: DeviceView) =>
    a.name.localeCompare(b.name, undefined, { numeric: true });
  const groups = TYPE_ORDER.map((type) => ({
    type,
    devices: devices
      .filter((device) => device.type === type && device.status === 'ACTIVE')
      .sort(byName),
  })).filter((group) => group.devices.length > 0);
  const unpaired = devices
    .filter((device) => device.status === 'REVOKED')
    .sort((a, b) => (b.revokedAt ?? '').localeCompare(a.revokedAt ?? ''));
  return { groups, unpaired };
}

/** What a device is bound to, in words (AUTH-009, KDS-002, P2-06a). */
export type Binding =
  | { readonly kind: 'TABLE'; readonly label: string }
  | { readonly kind: 'STATION'; readonly name: string }
  | { readonly kind: 'ALL_STATIONS' }
  | { readonly kind: 'PERSON'; readonly name: string }
  | { readonly kind: 'NONE' };

export interface Names {
  readonly tables: ReadonlyMap<string, string>;
  readonly stations: ReadonlyMap<string, string>;
  readonly people: ReadonlyMap<string, string>;
}

export function namesOf(
  floor: FloorResponse,
  stations: readonly StationView[],
  people: readonly StaffView[],
): Names {
  return {
    tables: new Map(
      floor.sections.flatMap((section) => section.tables.map((table) => [table.id, table.label])),
    ),
    stations: new Map(stations.map((station) => [station.id, station.name])),
    people: new Map(people.map((person) => [person.id, person.displayName])),
  };
}

export function bindingOf(device: DeviceView, names: Names): Binding {
  if (device.tableId !== null) {
    return { kind: 'TABLE', label: names.tables.get(device.tableId) ?? '?' };
  }
  if (device.stationIds.length > 0) {
    // KDS-002: one or more stations.
    return {
      kind: 'STATION',
      name: device.stationIds.map((id) => names.stations.get(id) ?? '?').join(', '),
    };
  }
  if (device.type === 'KDS') return { kind: 'ALL_STATIONS' };
  if (device.staffId !== null) {
    return { kind: 'PERSON', name: names.people.get(device.staffId) ?? '?' };
  }
  return { kind: 'NONE' };
}

/** Tables a tablet can serve: active tables, by section and label, with their section's name. */
export function tableChoices(
  floor: FloorResponse,
): { readonly value: string; readonly label: string }[] {
  return floor.sections
    .filter((section) => section.archivedAt === null)
    .flatMap((section) =>
      section.tables
        .filter((table) => table.archivedAt === null)
        .map((table) => ({ value: table.id, label: `${table.label} · ${section.name}` })),
    );
}

export function stationChoices(stations: readonly StationView[]) {
  return stations
    .filter((station) => station.archivedAt === null)
    .map((station) => ({ value: station.id, label: station.name }));
}

/** People a waiter phone can be kept for: active staff who take orders, by name. */
export function holderChoices(people: readonly StaffView[]) {
  return people
    .filter((person) => person.active && person.role !== 'KITCHEN')
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map((person) => ({ value: person.id, label: person.displayName }));
}

export interface PairingForm {
  readonly type: PairableType;
  readonly name: string;
  /** Empty for none. */
  readonly tableId: string;
  /** A kitchen screen's stations; none for every station (KDS-002). */
  readonly stationIds: readonly string[];
  readonly staffId: string;
}

export type PairingField = 'name' | 'tableId';
export type PairingProblem = 'nameRequired' | 'tableRequired';

/** The same checks as the server: a name, and a table for a table tablet (AUTH-009). */
export function checkPairing(form: PairingForm): Partial<Record<PairingField, PairingProblem>> {
  const problems: Partial<Record<PairingField, PairingProblem>> = {};
  if (!DeviceName.safeParse(form.name).success) problems.name = 'nameRequired';
  if (form.type === 'TABLE_TABLET' && form.tableId === '') problems.tableId = 'tableRequired';
  return problems;
}

/** Only the binding the type uses is sent, so changing the type never leaves a stray one. */
export function pairingRequestOf(form: PairingForm): CreatePairingCodeRequest {
  const optional = (value: string) => (value === '' ? undefined : value);
  const tableId = form.type === 'TABLE_TABLET' ? optional(form.tableId) : undefined;
  const stationIds =
    form.type === 'KDS' && form.stationIds.length > 0 ? form.stationIds : undefined;
  const staffId = form.type === 'WAITER_PHONE' ? optional(form.staffId) : undefined;
  return CreatePairingCodeRequest.parse({
    type: form.type,
    name: form.name.trim(),
    ...(tableId !== undefined && { tableId }),
    ...(stationIds !== undefined && { stationIds: [...stationIds] }),
    ...(staffId !== undefined && { staffId }),
  });
}

/** "<Type> N" with the first number no device of that type uses. */
export function suggestedDeviceName(
  devices: readonly DeviceView[],
  nameFor: (number: number) => string,
): string {
  const taken = new Set(
    devices
      .filter((device) => device.status === 'ACTIVE')
      .map((device) => device.name.trim().toLowerCase()),
  );
  let number = 1;
  while (taken.has(nameFor(number).toLowerCase())) number += 1;
  return nameFor(number);
}

/** Seconds left on a pairing code, never below zero. */
export function secondsLeft(expiresAt: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}

/** "9:41" for a countdown. */
export function countdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}:${String(seconds % 60).padStart(2, '0')}`;
}
