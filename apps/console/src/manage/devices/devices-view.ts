import {
  type CreatePairingCodeRequest,
  type DeviceView,
  type FloorResponse,
  RevokeDeviceRequest,
  type StaffView,
  type StationView,
  UpdateDeviceRequest,
} from '@rp/contracts';
import { calendarDateOf, timeOfDayOf } from '@rp/domain';

/**
 * The devices page (P4-02c, MGR-006): how devices are grouped and described, and the pairing form.
 * The server checks everything again; these checks only say what is wrong before sending.
 */

export type DeviceType = DeviceView['type'];

/** Groups in the order a restaurant sets them up: the counter, the kitchen, the floor. */
export const DEVICE_TYPE_ORDER: readonly DeviceType[] = [
  'POS',
  'MANAGER_BROWSER',
  'KDS',
  'WAITER_PHONE',
  'TABLE_TABLET',
  'PAGER',
];

/** Paired with a code; pagers are registered with their serial instead (Staff → Pagers). */
export type PairableType = Exclude<DeviceType, 'PAGER'>;
export const PAIRABLE_TYPES: readonly PairableType[] = [
  'POS',
  'MANAGER_BROWSER',
  'KDS',
  'WAITER_PHONE',
  'TABLE_TABLET',
];

export interface DeviceGroup {
  readonly type: DeviceType;
  readonly devices: readonly DeviceView[];
}

/** Paired devices by type, each group by name. Unpaired devices are left out: they are gone. */
export function deviceGroups(devices: readonly DeviceView[]): DeviceGroup[] {
  return DEVICE_TYPE_ORDER.map((type) => ({
    type,
    devices: devices
      .filter((device) => device.type === type && device.status !== 'REVOKED')
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
  })).filter((group) => group.devices.length > 0);
}

/** Names of the tables, stations and people devices are bound to, archived ones included. */
export interface BindingNames {
  readonly tables: ReadonlyMap<string, string>;
  readonly stations: ReadonlyMap<string, string>;
  readonly people: ReadonlyMap<string, string>;
}

export function bindingNamesOf(
  floor: FloorResponse | undefined,
  stations: readonly StationView[],
  people: readonly StaffView[],
): BindingNames {
  return {
    tables: new Map(
      (floor?.sections ?? []).flatMap((section) =>
        section.tables.map((table) => [table.id, table.label] as const),
      ),
    ),
    stations: new Map(stations.map((station) => [station.id, station.name])),
    people: new Map(people.map((person) => [person.id, person.displayName])),
  };
}

/** What a device is bound to, in words (MGR-006 "assigned table/station/person"). */
export type Binding =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'TABLE'; readonly table: string | undefined }
  | { readonly kind: 'STATION'; readonly station: string | undefined }
  | { readonly kind: 'ALL_STATIONS' }
  | { readonly kind: 'HOLDER' | 'WEARER'; readonly name: string | undefined }
  | { readonly kind: 'NO_HOLDER' | 'NOT_WORN' };

export function bindingOf(device: DeviceView, names: BindingNames): Binding {
  switch (device.type) {
    case 'TABLE_TABLET':
      return device.tableId === null
        ? { kind: 'NONE' }
        : { kind: 'TABLE', table: names.tables.get(device.tableId) };
    case 'KDS':
      return device.stationId === null
        ? { kind: 'ALL_STATIONS' }
        : { kind: 'STATION', station: names.stations.get(device.stationId) };
    case 'WAITER_PHONE':
      return device.staffId === null
        ? { kind: 'NO_HOLDER' }
        : { kind: 'HOLDER', name: names.people.get(device.staffId) };
    case 'PAGER':
      return device.staffId === null
        ? { kind: 'NOT_WORN' }
        : { kind: 'WEARER', name: names.people.get(device.staffId) };
    default:
      return { kind: 'NONE' };
  }
}

/** A device's battery in words, never in colour alone (TAB-015, PGR-013). */
export type DeviceBattery =
  { readonly kind: 'UNKNOWN' } | { readonly kind: 'OK' | 'LOW'; readonly percent: number };

export function deviceBatteryOf(device: DeviceView): DeviceBattery {
  if (device.batteryPercent === null) return { kind: 'UNKNOWN' };
  return { kind: device.batteryLow ? 'LOW' : 'OK', percent: device.batteryPercent };
}

/** When a device was last seen, in IST: the time today, or the day and time before today. */
export type LastSeen =
  | { readonly kind: 'NEVER' }
  | { readonly kind: 'TODAY'; readonly time: string }
  | { readonly kind: 'EARLIER'; readonly date: string; readonly time: string };

export function lastSeenOf(lastSeenAt: string | null, now: Date): LastSeen {
  if (lastSeenAt === null) return { kind: 'NEVER' };
  const seen = new Date(lastSeenAt);
  const time = timeOfDayOf(seen);
  const date = calendarDateOf(seen);
  return date === calendarDateOf(now) ? { kind: 'TODAY', time } : { kind: 'EARLIER', date, time };
}

/** A calendar date as people write it on a list, e.g. "27 Sep". */
export function shortDateOf(isoDate: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

// ---------------------------------------------------------------- pairing

export interface PairForm {
  readonly type: PairableType;
  readonly name: string;
  /** Empty until chosen; table tablets only. */
  readonly tableId: string;
  /** Empty for every station; kitchen screens only. */
  readonly stationId: string;
  /** Empty for whoever signs in; waiter phones only. */
  readonly staffId: string;
}

export type PairField = 'name' | 'tableId';
export type PairProblem = 'nameRequired' | 'tableRequired';

/** The same checks as the server: a name, and a table for a table tablet (AUTH-009). */
export function checkPairing(form: PairForm): Partial<Record<PairField, PairProblem>> {
  const problems: Partial<Record<PairField, PairProblem>> = {};
  if (!UpdateDeviceRequest.shape.name.safeParse(form.name).success) problems.name = 'nameRequired';
  if (form.type === 'TABLE_TABLET' && form.tableId === '') problems.tableId = 'tableRequired';
  return problems;
}

/** Only the binding the type uses is sent, so a choice left over from another type never is. */
export function pairingRequestOf(form: PairForm): CreatePairingCodeRequest {
  const request: CreatePairingCodeRequest = { type: form.type, name: form.name.trim() };
  if (form.type === 'TABLE_TABLET' && form.tableId !== '') request.tableId = form.tableId;
  if (form.type === 'KDS' && form.stationId !== '') request.stationId = form.stationId;
  if (form.type === 'WAITER_PHONE' && form.staffId !== '') request.staffId = form.staffId;
  return request;
}

/** "Kitchen screen N" with the first number no device uses, so the name rarely needs typing. */
export function suggestedName(
  devices: readonly { readonly name: string }[],
  nameFor: (number: number) => string,
): string {
  const taken = new Set(devices.map((device) => device.name.trim().toLowerCase()));
  let number = 1;
  while (taken.has(nameFor(number).toLowerCase())) number += 1;
  return nameFor(number);
}

/** The device that took the code: new since the code was issued, of its type and name. */
export function newlyPaired(
  knownIds: ReadonlySet<string>,
  devices: readonly DeviceView[],
  request: Pick<CreatePairingCodeRequest, 'type' | 'name'>,
): DeviceView | undefined {
  return devices.find(
    (device) =>
      !knownIds.has(device.id) &&
      device.status === 'ACTIVE' &&
      device.type === request.type &&
      device.name === request.name,
  );
}

export interface TableChoice {
  readonly id: string;
  readonly label: string;
  readonly section: string;
}

/** Tables a tablet may be bound to or moved to: those in use, but not the one it serves. */
export function tableChoices(
  floor: FloorResponse | undefined,
  except?: string | null,
): TableChoice[] {
  return (floor?.sections ?? [])
    .filter((section) => section.archivedAt === null)
    .flatMap((section) =>
      section.tables
        .filter((table) => table.archivedAt === null && table.id !== except)
        .map((table) => ({ id: table.id, label: table.label, section: section.name })),
    );
}

/** Kitchen stations in use, for a kitchen screen. */
export function stationChoices(stations: readonly StationView[]): StationView[] {
  return stations.filter((station) => station.archivedAt === null);
}

/** Who a waiter phone may alert while nobody is signed in: anyone active, by name. */
export function holderChoices(people: readonly StaffView[]): StaffView[] {
  return people
    .filter((person) => person.active)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// ---------------------------------------------------------------- rename and unpair

export function nameProblem(name: string): 'nameRequired' | undefined {
  return UpdateDeviceRequest.shape.name.safeParse(name).success ? undefined : 'nameRequired';
}

export function reasonProblem(reason: string): 'reasonRequired' | undefined {
  return RevokeDeviceRequest.shape.reason.safeParse(reason).success ? undefined : 'reasonRequired';
}
