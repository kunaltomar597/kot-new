import type { DomainEvent } from '@rp/contracts';
import {
  type Capability,
  DEFAULT_PERMISSION_MATRIX,
  grantFor,
  OVERRIDE_APPROVER_ROLES,
  type PermissionMatrix,
  type Role,
  ROLES,
} from '@rp/domain';
import type { AuthenticatedDevice } from '../auth/device.js';
import type { EventAudience } from '../events/outbox.js';

/**
 * Socket.io rooms (BRD §10.4: per restaurant, table, section, station, role and person). Every
 * room name starts with the restaurant, so an event can only reach its own restaurant's devices.
 */
export const rooms = {
  /** Every connected device of the restaurant, table tablets included. */
  all: (restaurantId: string) => `r:${restaurantId}:all`,
  role: (restaurantId: string, role: Role) => `r:${restaurantId}:role:${role}`,
  staff: (restaurantId: string, staffId: string) => `r:${restaurantId}:staff:${staffId}`,
  table: (restaurantId: string, tableId: string) => `r:${restaurantId}:table:${tableId}`,
  section: (restaurantId: string, sectionId: string) => `r:${restaurantId}:section:${sectionId}`,
  station: (restaurantId: string, stationId: string) => `r:${restaurantId}:station:${stationId}`,
  /** Kitchen screens not bound to one station (expo, single-screen kitchens). */
  allStations: (restaurantId: string) => `r:${restaurantId}:stations`,
  device: (restaurantId: string, deviceId: string) => `r:${restaurantId}:device:${deviceId}`,
};

/** Who is connected: the device and, if someone is signed in on it, the person. */
export interface ConnectionIdentity {
  readonly device: AuthenticatedDevice;
  readonly person?: { readonly staffId: string; readonly role: Role };
  /** Sections the person is assigned to for the current business day. */
  readonly sectionIds?: readonly string[];
}

/**
 * The rooms a connection joins. A table tablet only ever hears about its own table (AUTH-009);
 * a kitchen screen hears its station; a person hears what their role may see (SEC-003).
 */
export function roomsForConnection(identity: ConnectionIdentity): string[] {
  const { device, person } = identity;
  const rid = device.restaurantId;
  const joined = [rooms.all(rid), rooms.device(rid, device.deviceId)];
  if (device.type === 'TABLE_TABLET') {
    if (device.tableId !== null) joined.push(rooms.table(rid, device.tableId));
    return joined;
  }
  if (device.type === 'KDS') {
    joined.push(
      device.stationId === null ? rooms.allStations(rid) : rooms.station(rid, device.stationId),
    );
  }
  if (person !== undefined) {
    joined.push(rooms.role(rid, person.role), rooms.staff(rid, person.staffId));
    for (const sectionId of identity.sectionIds ?? []) joined.push(rooms.section(rid, sectionId));
  } else if (device.type === 'KDS') {
    // Station mode (AUTH-005): the screen acts for the kitchen when nobody is signed in.
    joined.push(rooms.role(rid, 'KITCHEN'));
  }
  return joined;
}

/**
 * Which roles see an event type: those the BRD §4.2 matrix grants the capability at all (ALLOW,
 * OWN or OVERRIDE), so the socket never shows a role what its REST calls could not. Station-scoped
 * kitchen work reaches kitchen screens through their station rooms instead.
 */
const VISIBLE_WITH: Readonly<Record<DomainEvent['type'], Capability | 'EVERYONE' | 'MANAGERS'>> = {
  MenuPublished: 'EVERYONE',
  ItemAvailabilityChanged: 'EVERYONE',
  TableOpened: 'ORDER_CREATE',
  TableMoved: 'ORDER_CREATE',
  TableClosed: 'ORDER_CREATE',
  TableStateChanged: 'ORDER_CREATE',
  TableWaiterChanged: 'ORDER_CREATE',
  OrderSubmitted: 'ORDER_CREATE',
  OrderApproved: 'ORDER_CREATE',
  OrderRejected: 'ORDER_CREATE',
  KotCreated: 'ORDER_CREATE',
  // Kitchen screens hear it through their station room, like tickets; managers see every bump.
  KotBumped: 'MANAGERS',
  ItemStatusChanged: 'ORDER_CREATE',
  ServiceRequestRaised: 'ORDER_CREATE',
  ServiceRequestAcknowledged: 'ORDER_CREATE',
  ServiceRequestCancelled: 'ORDER_CREATE',
  BillRequested: 'BILL_REQUEST',
  BillPrinted: 'BILL_REQUEST',
  BillSettled: 'BILL_REQUEST',
  AlertEscalated: 'MANAGERS',
  DeviceStatusChanged: 'DEVICE_PAIR',
  DeviceRevoked: 'DEVICE_PAIR',
  // The POS and managers are alerted when a printer stops or starts again (KDS-008, NTF-003).
  PrinterStatusChanged: 'BILL_PRINT_AND_PAYMENT',
  // Only the changed keys: every screen may hear it and reads what it may see again.
  SettingsChanged: 'EVERYONE',
  // Which part of the setup changed: every screen may show the name, logo or particulars.
  RestaurantChanged: 'EVERYONE',
};

function rolesWith(capability: Capability, matrix: PermissionMatrix): Role[] {
  return ROLES.filter((role) => grantFor(role, capability, matrix) !== 'DENY');
}

/** Tables, stations and people an event names in its own payload. */
function named(event: DomainEvent): Required<EventAudience> {
  const found: Required<EventAudience> = {
    tableIds: [],
    stationIds: [],
    sectionIds: [],
    staffIds: [],
  };
  switch (event.type) {
    case 'TableOpened':
    case 'TableClosed':
    case 'TableStateChanged':
    case 'ServiceRequestRaised':
      found.tableIds.push(event.payload.tableId);
      break;
    case 'TableWaiterChanged':
      found.tableIds.push(event.payload.tableId);
      found.staffIds.push(event.payload.waiterId);
      break;
    case 'TableMoved':
      found.tableIds.push(event.payload.fromTableId, event.payload.toTableId);
      break;
    case 'KotCreated':
    case 'KotBumped':
      found.stationIds.push(event.payload.stationId);
      break;
    case 'AlertEscalated':
      found.staffIds.push(...event.payload.escalatedTo);
      break;
    default:
      break;
  }
  return found;
}

/**
 * The rooms an event is sent to (ORD-010 broadcast, SEC-003 filter): the roles allowed to see its
 * type, plus the tables, stations, sections and people it concerns (from the event and the
 * producer's audience hints). `DeviceRevoked` also ends the device's own connections (gateway).
 */
export function roomsForEvent(
  event: DomainEvent,
  audience: EventAudience = {},
  matrix: PermissionMatrix = DEFAULT_PERMISSION_MATRIX,
): string[] {
  const rid = event.restaurantId;
  const targets = new Set<string>();
  const visibility = VISIBLE_WITH[event.type];
  if (visibility === 'EVERYONE') {
    targets.add(rooms.all(rid));
  } else if (visibility === 'MANAGERS') {
    for (const role of OVERRIDE_APPROVER_ROLES) targets.add(rooms.role(rid, role));
  } else {
    for (const role of rolesWith(visibility, matrix)) targets.add(rooms.role(rid, role));
  }
  const own = named(event);
  for (const tableId of [...own.tableIds, ...(audience.tableIds ?? [])]) {
    targets.add(rooms.table(rid, tableId));
  }
  const stationIds = [...own.stationIds, ...(audience.stationIds ?? [])];
  for (const stationId of stationIds) targets.add(rooms.station(rid, stationId));
  if (stationIds.length > 0) targets.add(rooms.allStations(rid));
  for (const sectionId of [...own.sectionIds, ...(audience.sectionIds ?? [])]) {
    targets.add(rooms.section(rid, sectionId));
  }
  for (const staffId of [...own.staffIds, ...(audience.staffIds ?? [])]) {
    targets.add(rooms.staff(rid, staffId));
  }
  return [...targets];
}

/** True when a connection in `joined` receives `targets` (replay uses the live routing). */
export function reaches(targets: readonly string[], joined: ReadonlySet<string>): boolean {
  return targets.some((room) => joined.has(room));
}
