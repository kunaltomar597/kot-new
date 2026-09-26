import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  KdsTicket,
  KdsTicketsResponse,
  type LoginResponse,
  NotifyManagerResponse,
  SubmitOrderResponse,
  TableSessionView,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthSettingsService } from '../../src/auth/auth-settings.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { SettingsService } from '../../src/settings/settings.service.js';
import {
  addDevice,
  authHeaders,
  type AuthKit,
  createAuthKit,
  signIn,
} from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let manager: LoginResponse;
let waiter: LoginResponse;
const ids: Record<string, string> = {};
const id = (name: string) => ids[name] ?? '';

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  prisma = app.get(PrismaService);
  // Station mode: kitchen screens work without anybody signed in (AUTH-005).
  kit = await createAuthKit(app, { kitchenLogins: false });
  manager = await signIn(app, kit, 'MANAGER');
  waiter = await signIn(app, kit, 'WAITER');
  const base = { restaurantId: kit.restaurantId };
  const category = await prisma.category.create({ data: { ...base, name: 'Menu' } });
  const gst = await prisma.taxGroup.create({
    data: {
      ...base,
      name: 'GST 5 %',
      components: { create: [{ ...base, code: 'CGST', rateBp: 250 }] },
    },
  });
  for (const station of ['Kitchen', 'Bar']) {
    ids[station] = (
      await prisma.station.create({ data: { ...base, name: station, mode: 'SCREEN' } })
    ).id;
  }
  for (const [name, station] of [
    ['Dal', 'Kitchen'],
    ['Roti', 'Kitchen'],
    ['Lassi', 'Bar'],
  ] as const) {
    ids[name] = (
      await prisma.item.create({
        data: {
          ...base,
          categoryId: category.id,
          name,
          basePrice: 10_000,
          taxGroupId: gst.id,
          foodType: 'VEG',
          stationId: id(station),
        },
      })
    ).id;
  }
  expect((await server().post('/api/v1/menu/publish').set(as(manager))).status).toBe(200);
  const hall = await prisma.section.create({ data: { ...base, name: 'Hall' } });
  for (const label of ['T1', 'T2']) {
    ids[label] = (
      await prisma.diningTable.create({ data: { ...base, sectionId: hall.id, label } })
    ).id;
  }
  ids.kitchenScreen = await addDevice(app, kit, 'KDS', { stationId: id('Kitchen') });
  ids.barScreen = await addDevice(app, kit, 'KDS', { stationId: id('Bar') });
  ids.allScreen = await addDevice(app, kit, 'KDS');

  ids.session = TableSessionView.parse(
    (
      await server()
        .post(`/api/v1/tables/${id('T1')}/open`)
        .set(as(waiter))
        .send({ covers: 2 })
    ).body,
  ).id;
  const submitted = SubmitOrderResponse.parse(
    (
      await server()
        .post('/api/v1/orders')
        .set(as(waiter))
        .send({
          idempotencyKey: randomUUID(),
          source: 'WAITER_APP',
          orderType: 'DINE_IN',
          tableSessionId: id('session'),
          lines: [
            {
              clientLineId: randomUUID(),
              itemId: id('Dal'),
              quantity: 2,
              instructions: 'less oil',
            },
            { clientLineId: randomUUID(), itemId: id('Lassi'), quantity: 1 },
          ],
        })
    ).body,
  );
  if (submitted.status !== 'ACCEPTED') throw new Error('order refused');
  ids.order = submitted.orderId;
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const server = () => request(httpServer(app));
const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const screen = (name: string) => authHeaders(id(name));
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;

async function tickets(headers: Record<string, string>, query: object = {}) {
  const response = await server().get('/api/v1/kds/tickets').query(query).set(headers);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return KdsTicketsResponse.parse(response.body);
}

const kitchenTicket = async () => {
  const [ticket] = (await tickets(screen('kitchenScreen'))).tickets;
  if (ticket === undefined) throw new Error('no kitchen ticket');
  return ticket;
};

const step = (orderItemId: string, event: string, headers = screen('kitchenScreen')) =>
  server().post(`/api/v1/order-items/${orderItemId}/status`).set(headers).send({ event });

describe('[KDS-001] [KDS-002] [KDS-003] a station screen in station mode', () => {
  it('shows only its own station’s tickets, with table, waiter, lines and settings', async () => {
    const kitchen = await tickets(screen('kitchenScreen'));
    expect(kitchen.station).toEqual({ id: id('Kitchen'), name: 'Kitchen' });
    expect(kitchen.settings).toEqual({
      ageAmberMinutes: 10,
      ageRedMinutes: 20,
      readyNotCollectedMinutes: 3,
      soundVolumePercent: 70,
    });
    expect(kitchen.tickets).toHaveLength(1);
    expect(kitchen.tickets[0]).toMatchObject({
      kind: 'NEW',
      stationName: 'Kitchen',
      tableLabel: 'T1',
      takeawayToken: null,
      movedFrom: null,
      waiterName: 'Test waiter',
      source: 'WAITER_APP',
      bumpedAt: null,
      managerNotified: false,
    });
    expect(kitchen.tickets[0]?.lines.map((line) => [line.name, line.quantity, line.state])).toEqual(
      [['Dal', 2, 'SENT']],
    );
    expect(kitchen.tickets[0]?.lines[0]?.instructions).toBe('less oil');

    const bar = await tickets(screen('barScreen'));
    expect(bar.tickets.map((ticket) => ticket.lines[0]?.name)).toEqual(['Lassi']);
    const all = await tickets(screen('allScreen'));
    expect(all.station).toBeNull();
    expect(all.tickets).toHaveLength(2);

    const other = await server()
      .get('/api/v1/kds/tickets')
      .query({ stationId: id('Bar') })
      .set(screen('kitchenScreen'));
    expect(other.status).toBe(403);
  });

  it('lets people granted the kitchen steps choose a station, and keeps others out', async () => {
    expect((await tickets(as(manager), { stationId: id('Bar') })).tickets).toHaveLength(1);
    expect((await tickets(as(manager))).tickets).toHaveLength(2);
    expect((await server().get('/api/v1/kds/tickets').set(as(waiter))).status).toBe(403);
    // A POS with nobody signed in is not a kitchen screen.
    expect((await server().get('/api/v1/kds/tickets').set(authHeaders(kit.deviceId))).status).toBe(
      401,
    );
    const missing = await server()
      .get('/api/v1/kds/tickets')
      .query({ stationId: randomUUID() })
      .set(as(manager));
    expect([missing.status, codeOf(missing)]).toEqual([404, 'STATION_NOT_FOUND']);
  });
});

describe('[KDS-005] [KDS-006] [KDS-007] kitchen steps, bump, recall and notify manager', () => {
  it('marks its own items preparing and ready, attributed to the screen', async () => {
    const ticket = await kitchenTicket();
    const dal = ticket.lines[0]?.orderItemId ?? '';
    const bump = await server()
      .post(`/api/v1/kds/tickets/${ticket.kotId}/bump`)
      .set(screen('kitchenScreen'));
    expect([bump.status, codeOf(bump)]).toEqual([409, 'KOT_NOT_READY']);
    const early = await server()
      .post(`/api/v1/kds/tickets/${ticket.kotId}/notify-manager`)
      .set(screen('kitchenScreen'));
    expect([early.status, codeOf(early)]).toEqual([409, 'NOTHING_WAITING']);

    expect((await step(dal, 'START_PREPARING')).status).toBe(200);
    expect((await step(dal, 'MARK_READY')).status).toBe(200);
    const events = await prisma.orderEvent.findMany({
      where: { orderItemId: dal, type: { in: ['START_PREPARING', 'MARK_READY'] } },
    });
    expect(events).toHaveLength(2);
    expect(
      events.every((event) => event.actorId === null && event.deviceId === id('kitchenScreen')),
    ).toBe(true);

    // The kitchen cannot touch the bar's items, and serving is the floor's job.
    const bar = (await tickets(screen('barScreen'))).tickets[0]?.lines[0]?.orderItemId ?? '';
    expect((await step(bar, 'START_PREPARING')).status).toBe(403);
    expect((await step(dal, 'SERVE')).status).toBe(403);
    const after = await kitchenTicket();
    expect(after.lines[0]).toMatchObject({ state: 'READY' });
    expect(after.lines[0]?.readyAt).not.toBeNull();
  });

  it('alerts the managers once when ready food waits', async () => {
    const ticket = await kitchenTicket();
    const first = await server()
      .post(`/api/v1/kds/tickets/${ticket.kotId}/notify-manager`)
      .set(screen('kitchenScreen'));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const raised = NotifyManagerResponse.parse(first.body);
    expect(raised.alreadyOpen).toBe(false);
    const again = NotifyManagerResponse.parse(
      (
        await server()
          .post(`/api/v1/kds/tickets/${ticket.kotId}/notify-manager`)
          .set(screen('kitchenScreen'))
      ).body,
    );
    expect(again).toEqual({ alertId: raised.alertId, alreadyOpen: true });
    const alert = await prisma.alert.findUniqueOrThrow({ where: { id: raised.alertId } });
    expect(alert).toMatchObject({
      type: 'READY_NOT_COLLECTED',
      status: 'OPEN',
      kotId: ticket.kotId,
      tableId: id('T1'),
      raisedById: null,
      raisedByDeviceId: id('kitchenScreen'),
    });
    expect(alert.payload).toMatchObject({ tableLabel: 'T1', items: ['Dal'] });
    expect(
      await prisma.outboxEvent.count({
        where: { eventType: 'AlertRaised', aggregateId: raised.alertId },
      }),
    ).toBe(1);
    expect((await kitchenTicket()).managerNotified).toBe(true);
  });

  it('bumps a ready ticket off the screen and recalls it', async () => {
    const ticket = await kitchenTicket();
    const bumped = await server()
      .post(`/api/v1/kds/tickets/${ticket.kotId}/bump`)
      .set(screen('kitchenScreen'));
    expect(bumped.status, JSON.stringify(bumped.body)).toBe(200);
    expect(KdsTicket.parse(bumped.body).bumpedAt).not.toBeNull();
    const view = await tickets(screen('kitchenScreen'));
    expect(view.tickets).toEqual([]);
    expect(view.recentlyBumped.map((entry) => entry.kotId)).toEqual([ticket.kotId]);
    const row = await prisma.kot.findUniqueOrThrow({ where: { id: ticket.kotId } });
    expect(row).toMatchObject({ bumpedById: null, bumpedByDeviceId: id('kitchenScreen') });

    // Bumping twice changes nothing; another station cannot touch it.
    expect(
      (await server().post(`/api/v1/kds/tickets/${ticket.kotId}/bump`).set(screen('kitchenScreen')))
        .status,
    ).toBe(200);
    expect(
      (await server().post(`/api/v1/kds/tickets/${ticket.kotId}/recall`).set(screen('barScreen')))
        .status,
    ).toBe(404);

    const recalled = await server()
      .post(`/api/v1/kds/tickets/${ticket.kotId}/recall`)
      .set(screen('kitchenScreen'));
    expect(KdsTicket.parse(recalled.body).bumpedAt).toBeNull();
    expect((await tickets(screen('kitchenScreen'))).tickets.map((entry) => entry.kotId)).toEqual([
      ticket.kotId,
    ]);
    const bumps = await prisma.outboxEvent.findMany({ where: { eventType: 'KotBumped' } });
    expect(
      bumps.map((event) => (event.payload as { payload: { bumped: boolean } }).payload.bumped),
    ).toEqual([true, false]);
  });

  it('[KDS-007] lets the pass mark items picked up', async () => {
    const ticket = await kitchenTicket();
    const dal = ticket.lines[0]?.orderItemId ?? '';
    expect((await step(dal, 'PICK_UP')).status).toBe(200);
    // Nothing left at the station: the ticket leaves the open list by itself.
    expect((await tickets(screen('kitchenScreen'))).tickets).toEqual([]);
  });
});

describe('[TBL-005] [KDS-003] moved tables', () => {
  it('shows the new table and where the guests came from', async () => {
    const moved = await server()
      .post(`/api/v1/table-sessions/${id('session')}/move`)
      .set(as(manager))
      .send({ toTableId: id('T2') });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const [ticket] = (await tickets(screen('barScreen'))).tickets;
    expect(ticket).toMatchObject({ tableLabel: 'T2', movedFrom: 'T1' });
  });
});

describe('[AUTH-005] when kitchen staff sign in individually', () => {
  it('refuses a kitchen screen with nobody signed in', async () => {
    await prisma.setting.upsert({
      where: {
        restaurantId_key: { restaurantId: kit.restaurantId, key: 'auth.kitchenIndividualLogins' },
      },
      create: { restaurantId: kit.restaurantId, key: 'auth.kitchenIndividualLogins', value: true },
      update: { value: true },
    });
    app.get(AuthSettingsService).invalidate();
    app.get(SettingsService).invalidate();
    expect((await server().get('/api/v1/kds/tickets').set(screen('kitchenScreen'))).status).toBe(
      401,
    );
  });
});
