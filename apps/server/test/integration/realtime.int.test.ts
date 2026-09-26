import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { REALTIME_CONNECT_ERRORS, type DomainEvent } from '@rp/contracts';
import { businessDateOf } from '@rp/domain';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { APP_CONFIG, type AppConfig } from '../../src/config/app-config.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { EventBus } from '../../src/events/event-bus.js';
import {
  DEFAULT_REALTIME_OPTIONS,
  REALTIME_OPTIONS,
  RealtimeGateway,
  type RealtimeOptions,
} from '../../src/realtime/realtime.gateway.js';
import {
  addDevice,
  addStaff,
  authHeaders,
  type AuthKit,
  createAuthKit,
  deviceTokenOf,
  signIn,
} from '../helpers/auth-kit.js';
import { domainEvent, produce } from '../helpers/events.js';
import { RealtimeTestClient } from '../helpers/realtime-client.js';
import { appUrl, createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

const OPTIONS: RealtimeOptions = {
  ...DEFAULT_REALTIME_OPTIONS,
  sweepIntervalMs: 200,
  headIntervalMs: 200,
  maxReplay: 20,
  resyncsPerMinute: 3,
};

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let bus: EventBus;
let url: string;
let kit: AuthKit;
let rid: string;
let table1: string;
let table2: string;
let stationA: string;
let stationB: string;
let section: string;
const clients: RealtimeTestClient[] = [];

/** A device's credentials for the socket handshake, with a signed-in person if given. */
function auth(deviceId: string, accessToken?: string, extra: Record<string, unknown> = {}) {
  return {
    deviceToken: deviceTokenOf(deviceId),
    ...(accessToken !== undefined && { accessToken }),
    ...extra,
  };
}

async function connect(credentials: Record<string, unknown>): Promise<RealtimeTestClient> {
  const client = await RealtimeTestClient.connect(url, credentials);
  clients.push(client);
  return client;
}

function ids(events: readonly DomainEvent[]): string[] {
  return events.map((event) => event.eventId);
}

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({
    databaseUrl: database.url,
    overrides: [{ provide: REALTIME_OPTIONS, useValue: OPTIONS }],
    listen: true,
  });
  prisma = app.get(PrismaService);
  bus = app.get(EventBus);
  url = appUrl(app);
  kit = await createAuthKit(app);
  rid = kit.restaurantId;
  const hall = await prisma.section.create({ data: { restaurantId: rid, name: 'Hall' } });
  section = hall.id;
  const tables = [];
  for (const label of ['1', '2']) {
    tables.push(
      await prisma.diningTable.create({ data: { restaurantId: rid, sectionId: section, label } }),
    );
  }
  [table1, table2] = tables.map((table) => table.id) as [string, string];
  [stationA, stationB] = (
    await Promise.all(
      ['Tandoor', 'Bar'].map((name) =>
        prisma.station.create({ data: { restaurantId: rid, name } }),
      ),
    )
  ).map((station) => station.id) as [string, string];
});

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('[AUTH-007] [SEC-003] who may connect', () => {
  it('refuses a connection without a device token', async () => {
    expect((await RealtimeTestClient.refused(url, {})).code).toBe(
      REALTIME_CONNECT_ERRORS.handshakeInvalid,
    );
  });

  it('refuses an unknown or forged device token', async () => {
    const failure = await RealtimeTestClient.refused(url, { deviceToken: 'not-a-token' });
    expect(failure.code).toBe(REALTIME_CONNECT_ERRORS.deviceNotRecognised);
    expect(failure.message).toBe('DEVICE_NOT_RECOGNISED');
  });

  it('refuses an invalid access token instead of silently dropping the person', async () => {
    expect(
      (await RealtimeTestClient.refused(url, auth(kit.deviceId, 'garbage.token.value'))).code,
    ).toBe('TOKEN_INVALID');
  });

  it('refuses a person’s token presented from another device (AUTH-005)', async () => {
    const other = await addDevice(app, kit, 'POS');
    const cashier = await signIn(app, kit, 'CASHIER');
    expect((await RealtimeTestClient.refused(url, auth(other, cashier.accessToken))).code).toBe(
      'DEVICE_MISMATCH',
    );
  });

  it('refuses pagers, which use MQTT', async () => {
    const pager = await addDevice(app, kit, 'PAGER', { staffId: kit.staff.WAITER });
    expect((await RealtimeTestClient.refused(url, auth(pager))).code).toBe(
      REALTIME_CONNECT_ERRORS.deviceNotAllowed,
    );
  });

  it('serves nothing on the main namespace', async () => {
    expect((await RealtimeTestClient.refused(url, auth(kit.deviceId), '/')).code).toBe('NOT_FOUND');
  });

  it('refuses plain HTTP polling; only WebSocket is offered', async () => {
    const response = await request(httpServer(app)).get('/socket.io/?EIO=4&transport=polling');
    expect(response.status).toBe(400);
  });

  it('refuses connections while the database is unreachable, and the server still starts', async () => {
    const down = await createTestApp({
      databaseUrl: 'postgresql://postgres@127.0.0.1:1/none',
      listen: true,
    });
    try {
      expect(down.get(EventBus).ready).toBe(false);
      expect((await RealtimeTestClient.refused(appUrl(down), auth(kit.deviceId))).code).toBe(
        REALTIME_CONNECT_ERRORS.starting,
      );
    } finally {
      await down.close();
    }
  });

  it('accepts a paired device on its own, asking a first-time client for a full refresh', async () => {
    const client = await connect(auth(kit.deviceId));
    expect(client.syncs[0]).toEqual({
      streamId: bus.streamId,
      head: bus.head,
      replayed: 0,
      fullRefresh: true,
    });
  });
});

describe('[ORD-010] [SEC-003] [AUTH-009] events reach exactly the rooms allowed to see them', () => {
  it('routes by role, table, station and person, in sequence order, within a second', async () => {
    const waiterPhone = await addDevice(app, kit, 'WAITER_PHONE');
    const managerBrowser = await addDevice(app, kit, 'MANAGER_BROWSER');
    const kdsA = await addDevice(app, kit, 'KDS', { stationId: stationA });
    const kdsB = await addDevice(app, kit, 'KDS', { stationId: stationB });
    const tablet1 = await addDevice(app, kit, 'TABLE_TABLET', { tableId: table1 });
    const tablet2 = await addDevice(app, kit, 'TABLE_TABLET', { tableId: table2 });
    const lockedPos = await addDevice(app, kit, 'POS');

    const cashier = await connect(
      auth(kit.deviceId, (await signIn(app, kit, 'CASHIER')).accessToken),
    );
    const waiter = await connect(
      auth(waiterPhone, (await signIn(app, kit, 'WAITER', waiterPhone)).accessToken),
    );
    const manager = await connect(
      auth(managerBrowser, (await signIn(app, kit, 'MANAGER', managerBrowser)).accessToken),
    );
    const screenA = await connect(auth(kdsA));
    const screenB = await connect(auth(kdsB));
    const guest1 = await connect(auth(tablet1));
    const guest2 = await connect(auth(tablet2));
    const locked = await connect(auth(lockedPos));

    const opened = domainEvent('TableOpened', rid, {
      tableId: table1,
      tableSessionId: randomUUID(),
      covers: 2,
      waiterId: kit.staff.WAITER,
    });
    const kot = domainEvent('KotCreated', rid, {
      kotId: randomUUID(),
      kotNumber: 1,
      stationId: stationA,
      orderId: randomUUID(),
      kind: 'NEW',
    });
    const preparing = domainEvent('ItemStatusChanged', rid, {
      orderId: kot.payload.orderId,
      orderItemId: randomUUID(),
      from: 'SENT',
      to: 'PREPARING',
    });
    const deviceDown = domainEvent('DeviceStatusChanged', rid, {
      deviceId: kdsB,
      deviceType: 'KDS',
      online: false,
    });
    const settled = domainEvent('BillSettled', rid, {
      invoiceId: randomUUID(),
      grandTotal: 52_500,
    });
    const escalated = domainEvent('AlertEscalated', rid, {
      alertId: randomUUID(),
      eventType: 'ServiceRequestRaised',
      escalatedTo: [kit.staff.WAITER],
    });
    const menu = domainEvent('MenuPublished', rid, { menuVersion: 2 });

    const started = performance.now();
    await produce(app, [opened, kot]);
    const firstArrival = guest1.waitForEvent(opened.eventId);
    await produce(app, [preparing], { tableIds: [table1], stationIds: [stationA] });
    await produce(app, [deviceDown]);
    await produce(app, [settled], { tableIds: [table2] });
    await produce(app, [escalated, menu]);
    await firstArrival;
    expect(performance.now() - started).toBeLessThan(1_000);

    const everyone = [cashier, waiter, manager, screenA, screenB, guest1, guest2, locked];
    // The menu event is the last one and goes to everyone: when it arrives, the rest has.
    await Promise.all(everyone.map((client) => client.waitForEvent(menu.eventId)));

    // The events this test produced; the notification engine may add its own alerts (e.g. for the
    // screen going offline), which are routed by their own rules and checked in its tests.
    const produced = new Set(
      [opened, kot, preparing, deviceDown, settled, escalated, menu].map((event) => event.eventId),
    );
    const ours = <T extends { eventId: string }>(events: readonly T[]) =>
      events.filter((event) => produced.has(event.eventId));
    expect(ids(ours(cashier.received))).toEqual(ids([opened, kot, preparing, settled, menu]));
    expect(ids(ours(waiter.received))).toEqual(
      ids([opened, kot, preparing, settled, escalated, menu]),
    );
    expect(ids(ours(manager.received))).toEqual(
      ids([opened, kot, preparing, deviceDown, settled, escalated, menu]),
    );
    expect(ids(ours(screenA.received))).toEqual(ids([kot, preparing, menu]));
    expect(ids(ours(screenB.received))).toEqual(ids([menu]));
    expect(ids(ours(guest1.received))).toEqual(ids([opened, preparing, menu]));
    expect(ids(ours(guest2.received))).toEqual(ids([settled, menu]));
    expect(ids(ours(locked.received))).toEqual(ids([menu]));
    for (const client of everyone) {
      const sequences = client.events.map((message) => message.sequence);
      expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
    }
  });

  it('adds today’s section rooms for a signed-in person', async () => {
    const phone = await addDevice(app, kit, 'WAITER_PHONE');
    const otherPhone = await addDevice(app, kit, 'WAITER_PHONE');
    const otherWaiter = await addStaff(app, kit, 'WAITER', '4545');
    await prisma.shiftAssignment.create({
      data: {
        restaurantId: rid,
        staffId: kit.staff.WAITER,
        sectionId: section,
        businessDate: new Date(`${businessDateOf(new Date())}T00:00:00.000Z`),
      },
    });
    const assigned = await connect(
      auth(phone, (await signIn(app, kit, 'WAITER', phone)).accessToken),
    );
    const login = await request(httpServer(app))
      .post('/api/v1/auth/pin-login')
      .set(authHeaders(otherPhone))
      .send({ staffId: otherWaiter, pin: '4545' });
    const unassigned = await connect(
      auth(otherPhone, (login.body as { accessToken: string }).accessToken),
    );

    // Device events are for managers; the section hint adds the people working that section.
    const event = domainEvent('DeviceStatusChanged', rid, {
      deviceId: phone,
      deviceType: 'WAITER_PHONE',
      online: true,
    });
    const marker = domainEvent('MenuPublished', rid, { menuVersion: 3 });
    await produce(app, [event], { sectionIds: [section] });
    await produce(app, [marker]);
    await Promise.all([assigned, unassigned].map((client) => client.waitForEvent(marker.eventId)));
    expect(ids(assigned.received)).toEqual(ids([event, marker]));
    expect(ids(unassigned.received)).toEqual(ids([marker]));
  });
});

describe('[NTF-006] [NFR-P11] resynchronisation', () => {
  it('replays what a reconnecting device missed, then continues live', async () => {
    const tablet = await addDevice(app, kit, 'TABLE_TABLET', { tableId: table1 });
    const first = await connect(auth(tablet));
    const resume = { lastSequence: first.lastSequence, streamId: first.syncs[0]?.streamId };
    first.close();

    const missedHere = domainEvent('TableStateChanged', rid, {
      tableId: table1,
      state: 'OCCUPIED',
    });
    const elsewhere = domainEvent('TableStateChanged', rid, { tableId: table2, state: 'OCCUPIED' });
    const call = domainEvent('ServiceRequestRaised', rid, {
      serviceRequestId: randomUUID(),
      tableId: table1,
      type: 'WATER',
    });
    await produce(app, [missedHere, elsewhere, call]);
    await bus.drain();

    const again = await connect(auth(tablet, undefined, resume));
    expect(again.syncs[0]).toMatchObject({ replayed: 2, fullRefresh: false, head: bus.head });
    expect(again.eventsAtSync[0]).toBe(2);
    expect(ids(again.received)).toEqual(ids([missedHere, call]));

    const live = domainEvent('TableStateChanged', rid, {
      tableId: table1,
      state: 'BILL_REQUESTED',
    });
    await produce(app, [live]);
    await again.waitForEvent(live.eventId);
    expect(ids(again.received)).toEqual(ids([missedHere, call, live]));
  });

  it('asks for a full refresh when the gap cannot be replayed exactly', async () => {
    const pos = await addDevice(app, kit, 'POS');
    const streamId = bus.streamId;
    await bus.drain();

    // Up to date: nothing to send, no refresh needed.
    const current = await connect(auth(pos, undefined, { lastSequence: bus.head, streamId }));
    expect(current.syncs[0]).toMatchObject({ replayed: 0, fullRefresh: false });

    // Another stream (for example, a restored database), or a sequence from the future.
    for (const resume of [
      { lastSequence: 1, streamId: randomUUID() },
      { lastSequence: bus.head + 5, streamId },
      { lastSequence: 1 },
    ]) {
      const client = await connect(auth(pos, undefined, resume));
      expect(client.syncs[0]).toMatchObject({ replayed: 0, fullRefresh: true });
    }

    // Too far behind (more than maxReplay events).
    const behind = bus.head;
    await produce(
      app,
      Array.from({ length: OPTIONS.maxReplay + 1 }, (_, index) =>
        domainEvent('MenuPublished', rid, { menuVersion: 100 + index }),
      ),
    );
    await bus.drain();
    const tooOld = await connect(auth(pos, undefined, { lastSequence: behind, streamId }));
    expect(tooOld.syncs[0]).toMatchObject({ replayed: 0, fullRefresh: true });

    // Already cleaned up.
    const kept = bus.head - 2;
    await prisma.outboxEvent.deleteMany({ where: { sequence: { lte: BigInt(kept) } } });
    const gone = await connect(auth(pos, undefined, { lastSequence: kept - 1, streamId }));
    expect(gone.syncs[0]).toMatchObject({ replayed: 0, fullRefresh: true });
    const exact = await connect(auth(pos, undefined, { lastSequence: kept, streamId }));
    expect(exact.syncs[0]).toMatchObject({ replayed: 2, fullRefresh: false });
  });

  it('replays on request, and limits how often a connection may ask', async () => {
    const pos = await addDevice(app, kit, 'POS');
    const client = await connect(auth(pos));
    const since = bus.head;
    const events = [1, 2].map((index) =>
      domainEvent('MenuPublished', rid, { menuVersion: 200 + index }),
    );
    await produce(app, events);
    await client.waitForEvent(events[1]?.eventId ?? '');

    // A duplicate delivery: clients de-duplicate by event id (NTF-006).
    const sync = await client.resync({ lastSequence: since, streamId: bus.streamId });
    expect(sync).toMatchObject({ replayed: 2, fullRefresh: false, head: bus.head });
    expect(ids(client.received)).toEqual(ids([...events, ...events]));

    expect(await client.resync({ lastSequence: -1 })).toMatchObject({ fullRefresh: true });
    await client.resync({ lastSequence: bus.head, streamId: bus.streamId });
    await client.resync({ lastSequence: bus.head, streamId: bus.streamId });
    // The fourth request within a minute (limit 3) gets a full-refresh answer without a replay.
    expect(await client.resync({ lastSequence: since, streamId: bus.streamId })).toMatchObject({
      replayed: 0,
      fullRefresh: true,
    });
    // A request without an acknowledgement is ignored.
    client.socket.emit('resync', { lastSequence: 0 });
  });

  it('tells idle connections the head, so they resume from it', async () => {
    const client = await connect(auth(kit.deviceId));
    const head = await client.waitFor(() => client.heads[0]);
    expect(head).toEqual({ streamId: bus.streamId, head: bus.head });
    expect(client.lastSequence).toBe(bus.head);
  });
});

describe('[AUTH-008] [AUTH-005] live connections end when their credentials do', () => {
  it('closes an unpaired device’s connection within 5 seconds and refuses it afterwards', async () => {
    const phone = await addDevice(app, kit, 'WAITER_PHONE');
    const managerBrowser = await addDevice(app, kit, 'MANAGER_BROWSER');
    const manager = await signIn(app, kit, 'MANAGER', managerBrowser);
    const managerClient = await connect(auth(managerBrowser, manager.accessToken));
    const client = await connect(
      auth(phone, (await signIn(app, kit, 'WAITER', phone)).accessToken),
    );

    const started = performance.now();
    const response = await request(httpServer(app))
      .post(`/api/v1/devices/${phone}/revoke`)
      .set(authHeaders(managerBrowser, manager.accessToken))
      .send({ reason: 'Phone lost on the terrace' });
    expect(response.status).toBe(200);

    expect(await client.waitForDisconnect(5_000)).toBe('io server disconnect');
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(client.endings).toEqual([{ reason: 'DEVICE_REVOKED' }]);
    // Managers see the device go (their device list refreshes).
    await managerClient.waitFor(() =>
      managerClient.received.find(
        (event) => event.type === 'DeviceRevoked' && event.payload.deviceId === phone,
      ),
    );
    expect((await RealtimeTestClient.refused(url, auth(phone))).code).toBe(
      REALTIME_CONNECT_ERRORS.deviceNotRecognised,
    );
  });

  it('ends the connection when the person signs out', async () => {
    const phone = await addDevice(app, kit, 'WAITER_PHONE');
    const waiter = await signIn(app, kit, 'WAITER', phone);
    const client = await connect(auth(phone, waiter.accessToken));
    const deviceOnly = await connect(auth(phone));

    await request(httpServer(app))
      .post('/api/v1/auth/logout')
      .set(authHeaders(phone, waiter.accessToken))
      .expect(204);

    expect(await client.waitForDisconnect(5_000)).toBe('io server disconnect');
    expect(client.endings).toEqual([{ reason: 'SESSION_ENDED' }]);
    // The device itself is still paired: its own connection stays.
    await app.get(RealtimeGateway).sweep();
    expect(deviceOnly.disconnectReason).toBeUndefined();
  });

  it('ends the connection when the person’s role changes', async () => {
    const pos = await addDevice(app, kit, 'POS');
    const cashierId = await addStaff(app, kit, 'CASHIER', '3434');
    const login = await request(httpServer(app))
      .post('/api/v1/auth/pin-login')
      .set(authHeaders(pos))
      .send({ staffId: cashierId, pin: '3434' });
    const client = await connect(auth(pos, (login.body as { accessToken: string }).accessToken));

    const managerRole = await prisma.role.findFirstOrThrow({
      where: { restaurantId: rid, key: 'MANAGER' },
    });
    await prisma.staff.update({ where: { id: cashierId }, data: { roleId: managerRole.id } });

    expect(await client.waitForDisconnect(5_000)).toBe('io server disconnect');
    expect(client.endings).toEqual([{ reason: 'SESSION_ENDED' }]);
  });

  it('ends a tablet’s connection when it is moved to another table, so it rejoins correctly', async () => {
    const tablet = await addDevice(app, kit, 'TABLE_TABLET', { tableId: table1 });
    const client = await connect(auth(tablet));
    await prisma.device.update({ where: { id: tablet }, data: { tableId: table2 } });

    expect(await client.waitForDisconnect(5_000)).toBe('io server disconnect');
    expect(client.endings).toEqual([{ reason: 'DEVICE_CHANGED' }]);
    const moved = await connect(auth(tablet));
    const event = domainEvent('TableStateChanged', rid, { tableId: table2, state: 'FREE' });
    await produce(app, [event]);
    await moved.waitForEvent(event.eventId);
  });
});

describe('[NFR-P11] server shutdown', () => {
  it('drops connections at the transport, so clients reconnect by themselves', async () => {
    // Same data folder, so the device tokens signed by the first app are valid here too.
    const other = await createTestApp({
      databaseUrl: database.url,
      config: { dataDir: app.get<AppConfig>(APP_CONFIG).dataDir },
      listen: true,
    });
    const client = await RealtimeTestClient.connect(appUrl(other), auth(kit.deviceId));
    await other.close();
    expect(await client.waitForDisconnect()).toBe('transport close');
    expect(client.endings).toEqual([]);
    client.close();
  });
});
