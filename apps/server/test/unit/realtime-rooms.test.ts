import { randomUUID } from 'node:crypto';
import { DOMAIN_EVENT_TYPES, type DomainEvent } from '@rp/contracts';
import type { Role, RoleCustomisation } from '@rp/domain';
import { describe, expect, it } from 'vitest';
import type { AuthenticatedDevice } from '../../src/auth/device.js';
import {
  isLiveOnly,
  reaches,
  rooms,
  roomsForConnection,
  roomsForEvent,
} from '../../src/realtime/rooms.js';
import { domainEvent } from '../helpers/events.js';

const rid = randomUUID();
const other = randomUUID();
const table1 = randomUUID();
const table2 = randomUUID();
const stationA = randomUUID();
const section = randomUUID();
const waiter = randomUUID();

function device(overrides: Partial<AuthenticatedDevice>): AuthenticatedDevice {
  return {
    deviceId: randomUUID(),
    restaurantId: rid,
    type: 'POS',
    tableId: null,
    stationId: null,
    staffId: null,
    ...overrides,
  };
}

/** Whether someone signed in on a POS with `role` (and a custom role) hears `event`. */
function hears(event: DomainEvent, role: Role, customRole: RoleCustomisation | null = null) {
  const joined = roomsForConnection({
    device: device({ type: 'POS' }),
    person: { staffId: randomUUID(), role, customRole },
  });
  return reaches(roomsForEvent(event), new Set(joined));
}

const FLOOR = ['OWNER', 'MANAGER', 'CASHIER', 'WAITER'] as const;

describe('[AUTH-009] [SEC-003] rooms a connection joins', () => {
  it('puts a table tablet in its own table room only, even with a person signed in', () => {
    const tablet = device({ type: 'TABLE_TABLET', tableId: table1 });
    const joined = roomsForConnection({
      device: tablet,
      person: { staffId: waiter, role: 'WAITER' },
    });
    expect(joined).toEqual([
      rooms.all(rid),
      rooms.device(rid, tablet.deviceId),
      rooms.table(rid, table1),
    ]);
  });

  it('gives an unbound tablet no table at all', () => {
    const tablet = device({ type: 'TABLE_TABLET' });
    expect(roomsForConnection({ device: tablet })).toEqual([
      rooms.all(rid),
      rooms.device(rid, tablet.deviceId),
    ]);
  });

  it('puts a kitchen screen in its station, acting for the kitchen in station mode', () => {
    const kds = device({ type: 'KDS', stationId: stationA });
    expect(roomsForConnection({ device: kds })).toEqual([
      rooms.all(rid),
      rooms.device(rid, kds.deviceId),
      rooms.station(rid, stationA),
      rooms.role(rid, 'KITCHEN'),
    ]);
  });

  it('puts a kitchen screen without a station in the all-stations room', () => {
    const kds = device({ type: 'KDS' });
    expect(roomsForConnection({ device: kds })).toContain(rooms.allStations(rid));
  });

  it('puts a signed-in person in their role, own and section rooms', () => {
    const phone = device({ type: 'WAITER_PHONE' });
    expect(
      roomsForConnection({
        device: phone,
        person: { staffId: waiter, role: 'WAITER' },
        sectionIds: [section],
      }),
    ).toEqual([
      rooms.all(rid),
      rooms.device(rid, phone.deviceId),
      rooms.role(rid, 'WAITER'),
      rooms.staff(rid, waiter),
      rooms.section(rid, section),
      rooms.capability(rid, 'ORDER_CREATE'),
      rooms.capability(rid, 'BILL_REQUEST'),
    ]);
  });

  it('[AUTH-012] puts a person with a custom role in the rooms of what it allows', () => {
    const phone = device({ type: 'WAITER_PHONE' });
    const joined = roomsForConnection({
      device: phone,
      person: {
        staffId: waiter,
        role: 'WAITER',
        customRole: { added: ['BILL_PRINT_AND_PAYMENT'], removed: ['BILL_REQUEST'] },
      },
    });
    expect(joined).toContain(rooms.capability(rid, 'BILL_PRINT_AND_PAYMENT'));
    expect(joined).toContain(rooms.capability(rid, 'ORDER_CREATE'));
    expect(joined).not.toContain(rooms.capability(rid, 'BILL_REQUEST'));
  });

  it('gives a device without a signed-in person no role room', () => {
    const pos = device({ type: 'POS' });
    expect(roomsForConnection({ device: pos })).toEqual([
      rooms.all(rid),
      rooms.device(rid, pos.deviceId),
    ]);
  });

  it('[WTR-006] keeps a waiter phone in its holder’s alert room, signed in or not (P2-06a)', () => {
    const phone = device({ type: 'WAITER_PHONE', staffId: waiter });
    expect(roomsForConnection({ device: phone })).toEqual([
      rooms.all(rid),
      rooms.device(rid, phone.deviceId),
      rooms.alerts(rid, waiter),
    ]);
    expect(
      roomsForConnection({ device: phone, person: { staffId: waiter, role: 'WAITER' } }),
    ).toEqual([
      rooms.all(rid),
      rooms.device(rid, phone.deviceId),
      rooms.alerts(rid, waiter),
      rooms.role(rid, 'WAITER'),
      rooms.staff(rid, waiter),
      rooms.capability(rid, 'ORDER_CREATE'),
      rooms.capability(rid, 'BILL_REQUEST'),
    ]);
    // A pager's wearer or a phone nobody holds joins no alert room here.
    expect(roomsForConnection({ device: device({ type: 'WAITER_PHONE' }) })).toHaveLength(2);
    expect(roomsForConnection({ device: device({ type: 'POS', staffId: waiter }) })).not.toContain(
      rooms.alerts(rid, waiter),
    );
  });
});

describe('[ORD-010] [SEC-003] rooms an event reaches', () => {
  it('[INT-004] routes every event type in the catalogue, always inside its restaurant', () => {
    const samples = DOMAIN_EVENT_TYPES.map((type) => roomsForEvent(sample(type)));
    for (const targets of samples) {
      expect(targets.length).toBeGreaterThan(0);
      for (const room of targets) expect(room.startsWith(`r:${rid}:`)).toBe(true);
    }
  });

  it('sends menu changes to every device, tablets included', () => {
    expect(roomsForEvent(domainEvent('MenuPublished', rid, { menuVersion: 2 }))).toEqual([
      rooms.all(rid),
    ]);
  });

  it('[MGR-005] tells only menu editors that the draft changed, not the ordering surfaces', () => {
    const event = domainEvent('MenuDraftChanged', rid, { part: 'CATEGORIES' });
    expect(roomsForEvent(event)).toEqual([rooms.capability(rid, 'MENU_MANAGE')]);
    expect(hears(event, 'OWNER')).toBe(true);
    expect(hears(event, 'MANAGER')).toBe(true);
    expect(hears(event, 'CASHIER')).toBe(false);
    expect(hears(event, 'WAITER')).toBe(false);
  });

  it('sends table events to the floor roles and that table, not the kitchen', () => {
    const event = domainEvent('TableOpened', rid, {
      tableId: table1,
      tableSessionId: randomUUID(),
      covers: 2,
      waiterId: waiter,
    });
    const targets = roomsForEvent(event);
    expect(targets).toEqual(
      expect.arrayContaining([rooms.capability(rid, 'ORDER_CREATE'), rooms.table(rid, table1)]),
    );
    for (const role of FLOOR) expect(hears(event, role)).toBe(true);
    expect(hears(event, 'KITCHEN')).toBe(false);
    expect(targets).not.toContain(rooms.table(rid, table2));
    expect(targets).not.toContain(rooms.all(rid));
  });

  it('tells both tables about a move', () => {
    const targets = roomsForEvent(
      domainEvent('TableMoved', rid, {
        tableSessionId: randomUUID(),
        fromTableId: table1,
        toTableId: table2,
      }),
    );
    expect(targets).toEqual(
      expect.arrayContaining([rooms.table(rid, table1), rooms.table(rid, table2)]),
    );
  });

  it('sends a KOT to its station (and all-stations screens), never to the kitchen role', () => {
    const targets = roomsForEvent(
      domainEvent('KotCreated', rid, {
        kotId: randomUUID(),
        kotNumber: 7,
        stationId: stationA,
        orderId: randomUUID(),
        kind: 'NEW',
      }),
    );
    expect(targets).toEqual(
      expect.arrayContaining([rooms.station(rid, stationA), rooms.allStations(rid)]),
    );
    expect(targets).not.toContain(rooms.role(rid, 'KITCHEN'));
  });

  it('adds the producer’s audience hints for tables, stations, sections and people', () => {
    const targets = roomsForEvent(
      domainEvent('ItemStatusChanged', rid, {
        orderId: randomUUID(),
        orderItemId: randomUUID(),
        from: 'SENT',
        to: 'PREPARING',
      }),
      { tableIds: [table1], stationIds: [stationA], sectionIds: [section], staffIds: [waiter] },
    );
    expect(targets).toEqual(
      expect.arrayContaining([
        rooms.table(rid, table1),
        rooms.station(rid, stationA),
        rooms.allStations(rid),
        rooms.section(rid, section),
        rooms.staff(rid, waiter),
      ]),
    );
  });

  it('[MGR-007] tells every screen which settings changed (keys only)', () => {
    const targets = roomsForEvent(domainEvent('SettingsChanged', rid, { keys: ['ui.timeFormat'] }));
    expect(targets).toEqual([rooms.all(rid)]);
  });

  it('[ONB-004] tells every screen which part of the restaurant setup changed', () => {
    const targets = roomsForEvent(domainEvent('RestaurantChanged', rid, { part: 'LEGAL' }));
    expect(targets).toEqual([rooms.all(rid)]);
  });

  it('keeps device events for the roles that manage devices', () => {
    const event = domainEvent('DeviceStatusChanged', rid, {
      deviceId: randomUUID(),
      deviceType: 'KDS',
      online: false,
    });
    expect(roomsForEvent(event)).toEqual([rooms.capability(rid, 'DEVICE_PAIR')]);
    expect(hears(event, 'OWNER')).toBe(true);
    expect(hears(event, 'MANAGER')).toBe(true);
    expect(hears(event, 'CASHIER')).toBe(false);
  });

  it('[KDS-008] [NTF-003] alerts the POS and managers when a printer goes offline', () => {
    const event = domainEvent('PrinterStatusChanged', rid, {
      printerId: randomUUID(),
      printerName: 'Kitchen',
      online: false,
      error: 'No answer',
      queued: 3,
    });
    expect(roomsForEvent(event)).toEqual([rooms.capability(rid, 'BILL_PRINT_AND_PAYMENT')]);
    for (const role of ['OWNER', 'MANAGER', 'CASHIER'] as const) {
      expect(hears(event, role)).toBe(true);
    }
    expect(hears(event, 'WAITER')).toBe(false);
  });

  it('[KDS-005] sends a bump to its station and managers, not to other stations', () => {
    const station = randomUUID();
    const targets = roomsForEvent(
      domainEvent('KotBumped', rid, { kotId: randomUUID(), stationId: station, bumped: true }),
    );
    expect(targets.sort()).toEqual(
      [
        rooms.role(rid, 'OWNER'),
        rooms.role(rid, 'MANAGER'),
        rooms.station(rid, station),
        rooms.allStations(rid),
      ].sort(),
    );
  });

  it('[WTR-012] tells the floor whether a ticket was printed, not the kitchen screens', () => {
    const event = domainEvent('KotPrintStatusChanged', rid, {
      kotId: randomUUID(),
      kotNumber: 12,
      orderId: randomUUID(),
      stationId: randomUUID(),
      printStatus: 'FAILED',
    });
    expect(roomsForEvent(event)).toEqual([rooms.capability(rid, 'ORDER_CREATE')]);
    for (const role of FLOOR) expect(hears(event, role)).toBe(true);
    expect(hears(event, 'KITCHEN')).toBe(false);
    // A kitchen screen in station mode does not hear it either.
    const kds = roomsForConnection({ device: device({ type: 'KDS', stationId: stationA }) });
    expect(reaches(roomsForEvent(event), new Set(kds))).toBe(false);
  });

  it('sends an escalation to managers and the people it names', () => {
    const targets = roomsForEvent(
      domainEvent('AlertEscalated', rid, {
        alertId: randomUUID(),
        eventType: 'ServiceRequestRaised',
        escalatedTo: [waiter],
      }),
    );
    expect(targets.sort()).toEqual(
      [rooms.role(rid, 'OWNER'), rooms.role(rid, 'MANAGER'), rooms.staff(rid, waiter)].sort(),
    );
  });

  it('[WTR-006] sends an alert to its recipients’ own and alert rooms, and to managers', () => {
    const alertId = randomUUID();
    for (const event of [
      domainEvent('AlertRaised', rid, {
        alertId,
        eventType: 'ITEM_READY',
        recipients: [waiter],
        pagerText: 'T5 READY',
        tableId: table1,
        repeat: 0,
        escalated: false,
      }),
      domainEvent('AlertAcknowledged', rid, {
        alertId,
        acknowledgedBy: waiter,
        recipients: [waiter],
      }),
      domainEvent('AlertCleared', rid, { alertId, recipients: [waiter] }),
    ]) {
      expect(roomsForEvent(event).sort()).toEqual(
        [
          rooms.role(rid, 'OWNER'),
          rooms.role(rid, 'MANAGER'),
          rooms.staff(rid, waiter),
          rooms.alerts(rid, waiter),
        ].sort(),
      );
    }
    // The alert room hears nothing but alerts: not the tables its holder looks after.
    const phone = new Set(
      roomsForConnection({ device: device({ type: 'WAITER_PHONE', staffId: waiter }) }),
    );
    const moved = domainEvent('TableWaiterChanged', rid, {
      tableId: table1,
      tableSessionId: randomUUID(),
      waiterId: waiter,
    });
    expect(reaches(roomsForEvent(moved), phone)).toBe(false);
  });

  it('[AUTH-012] follows custom roles: what a role takes away goes quiet, what it adds is heard', () => {
    const settled = domainEvent('BillSettled', rid, { invoiceId: randomUUID(), grandTotal: 0 });
    expect(hears(settled, 'WAITER')).toBe(true);
    expect(hears(settled, 'WAITER', { added: [], removed: ['BILL_REQUEST'] })).toBe(false);
    expect(hears(settled, 'CASHIER')).toBe(true);

    const printer = domainEvent('PrinterStatusChanged', rid, {
      printerId: randomUUID(),
      printerName: 'Bar',
      online: false,
      error: null,
      queued: 0,
    });
    expect(hears(printer, 'WAITER', { added: ['BILL_PRINT_AND_PAYMENT'], removed: [] })).toBe(true);
    const revoked = domainEvent('DeviceRevoked', rid, {
      deviceId: randomUUID(),
      deviceType: 'POS',
      reason: 'Lost',
    });
    expect(hears(revoked, 'MANAGER', { added: [], removed: ['DEVICE_PAIR'] })).toBe(false);
    expect(hears(revoked, 'CASHIER', { added: ['DEVICE_PAIR'], removed: [] })).toBe(true);
  });

  it('[MGR-006] asks only the device a manager is looking for, and never on replay', () => {
    const kds = device({ type: 'KDS' });
    const pos = device({ type: 'POS' });
    const locate = domainEvent('DeviceLocateRequested', rid, {
      deviceId: kds.deviceId,
      deviceType: 'KDS',
      name: 'Grill screen',
    });
    expect(roomsForEvent(locate)).toEqual([rooms.device(rid, kds.deviceId)]);
    expect(reaches(roomsForEvent(locate), new Set(roomsForConnection({ device: kds })))).toBe(true);
    const manager = roomsForConnection({
      device: pos,
      person: { staffId: randomUUID(), role: 'MANAGER' },
    });
    expect(reaches(roomsForEvent(locate), new Set(manager))).toBe(false);
    expect(isLiveOnly(locate)).toBe(true);
    expect(isLiveOnly(domainEvent('MenuPublished', rid, { menuVersion: 4 }))).toBe(false);
  });

  it('never crosses restaurants', () => {
    const tablet = device({ type: 'TABLE_TABLET', tableId: table1, restaurantId: other });
    const joined = new Set(roomsForConnection({ device: tablet }));
    const event = domainEvent('MenuPublished', rid, { menuVersion: 3 });
    expect(reaches(roomsForEvent(event, { tableIds: [table1] }), joined)).toBe(false);
  });
});

function sample(type: (typeof DOMAIN_EVENT_TYPES)[number]) {
  const id = () => randomUUID();
  switch (type) {
    case 'MenuPublished':
      return domainEvent(type, rid, { menuVersion: 1 });
    case 'ItemAvailabilityChanged':
      return domainEvent(type, rid, { itemId: id(), available: false, stockCount: null });
    case 'MenuDraftChanged':
      return domainEvent(type, rid, { part: 'ITEMS' });
    case 'TableOpened':
      return domainEvent(type, rid, {
        tableId: id(),
        tableSessionId: id(),
        covers: 2,
        waiterId: id(),
      });
    case 'TableMoved':
      return domainEvent(type, rid, { tableSessionId: id(), fromTableId: id(), toTableId: id() });
    case 'TableClosed':
      return domainEvent(type, rid, { tableId: id(), tableSessionId: id() });
    case 'TableStateChanged':
      return domainEvent(type, rid, { tableId: id(), state: 'OCCUPIED' });
    case 'OrderSubmitted':
      return domainEvent(type, rid, {
        orderId: id(),
        orderNumber: 1,
        source: 'POS',
        needsApproval: false,
      });
    case 'OrderApproved':
      return domainEvent(type, rid, { orderId: id(), approvedBy: id() });
    case 'OrderRejected':
      return domainEvent(type, rid, { orderId: id(), rejectedBy: id(), reason: 'Out of stock' });
    case 'KotCreated':
      return domainEvent(type, rid, {
        kotId: id(),
        kotNumber: 1,
        stationId: id(),
        orderId: id(),
        kind: 'NEW',
      });
    case 'KotBumped':
      return domainEvent(type, rid, { kotId: id(), stationId: id(), bumped: true });
    case 'KotPrintStatusChanged':
      return domainEvent(type, rid, {
        kotId: id(),
        kotNumber: 4,
        orderId: id(),
        stationId: id(),
        printStatus: 'PRINTED',
      });
    case 'ItemStatusChanged':
      return domainEvent(type, rid, {
        orderId: id(),
        orderItemId: id(),
        from: 'SENT',
        to: 'READY',
      });
    case 'ServiceRequestRaised':
      return domainEvent(type, rid, { serviceRequestId: id(), tableId: id(), type: 'WATER' });
    case 'ServiceRequestEscalated':
      return domainEvent(type, rid, { serviceRequestId: id() });
    case 'ServiceRequestAcknowledged':
      return domainEvent(type, rid, { serviceRequestId: id(), acknowledgedBy: id() });
    case 'ServiceRequestCancelled':
      return domainEvent(type, rid, { serviceRequestId: id(), resolution: 'RESOLVED' });
    case 'BillRequested':
      return domainEvent(type, rid, { tableSessionId: id(), requestedFrom: 'TABLE_TABLET' });
    case 'BillPrinted':
      return domainEvent(type, rid, {
        invoiceId: id(),
        invoiceNumber: 'A-1',
        grandTotal: 100,
        duplicate: false,
      });
    case 'BillSettled':
      return domainEvent(type, rid, { invoiceId: id(), grandTotal: 100 });
    case 'AlertEscalated':
      return domainEvent(type, rid, { alertId: id(), eventType: 'X', escalatedTo: [] });
    case 'AlertRaised':
      return domainEvent(type, rid, {
        alertId: id(),
        eventType: 'ITEM_READY',
        recipients: [id()],
        pagerText: 'T7 READY',
        tableId: null,
        repeat: 0,
        escalated: false,
      });
    case 'AlertAcknowledged':
      return domainEvent(type, rid, { alertId: id(), acknowledgedBy: null, recipients: [] });
    case 'AlertCleared':
      return domainEvent(type, rid, { alertId: id(), recipients: [] });
    case 'DeviceStatusChanged':
      return domainEvent(type, rid, { deviceId: id(), deviceType: 'POS', online: true });
    case 'DeviceRevoked':
      return domainEvent(type, rid, { deviceId: id(), deviceType: 'POS', reason: 'Lost' });
    case 'DeviceLocateRequested':
      return domainEvent(type, rid, { deviceId: id(), deviceType: 'KDS', name: 'Grill screen' });
    case 'PrinterStatusChanged':
      return domainEvent(type, rid, {
        printerId: id(),
        printerName: 'Kitchen',
        online: false,
        error: 'No answer',
        queued: 2,
      });
    case 'SettingsChanged':
      return domainEvent(type, rid, { keys: ['kds.ageAmberMinutes'] });
    case 'TableWaiterChanged':
      return domainEvent(type, rid, { tableId: id(), tableSessionId: id(), waiterId: id() });
    case 'RestaurantChanged':
      return domainEvent(type, rid, { part: 'PROFILE' });
  }
}
