import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  type LoginResponse,
  SubmitOrderResponse,
  SystemStatusResponse,
  TableSessionView,
} from '@rp/contracts';
import {
  QrMenuResponse,
  QrOrderView,
  QrPickupResponse,
  QrSubmitOrderResponse,
} from '@rp/contracts/relay';
import { startRelay, type TestRelay } from '@rp/relay/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SECRET_STORE, type SecretStore } from '../../src/auth/secret-store.js';
import { currentBusinessDate, dbDate } from '../../src/common/business-dates.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { saveRelayCredential } from '../../src/relay/relay-credential.js';
import {
  DEFAULT_RELAY_ORDERS_OPTIONS,
  RELAY_ORDERS_OPTIONS,
  RelayOrdersService,
} from '../../src/relay/relay-orders.service.js';
import {
  DEFAULT_RELAY_SYNC_OPTIONS,
  RELAY_SYNC_OPTIONS,
  RelaySyncService,
} from '../../src/relay/relay-sync.service.js';
import { SettingsService } from '../../src/settings/settings.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';
import { until } from '../helpers/wait.js';

/**
 * Phase 5 exit test (P5-06): the BRD's QR scenarios end to end, the local server against a real
 * relay (its schema, rules and functions over HTTP), with diners' phones as plain HTTP calls.
 * - S2 (QR part): the restaurant's internet goes for 30 minutes mid-service. Everything in the
 *   restaurant carries on, the QR page turns read-only, and every queue drains afterwards with
 *   nothing lost or doubled.
 * - S13: a QR order while the restaurant is offline: the pickup time passes, the diner is told to
 *   call a waiter, and the order is never made, even when it reaches the restaurant late.
 * - S11 (relay part): a second restaurant's server and diners never reach the first's queue.
 * - Duplicate replay: a diner's retry, a lost acknowledgement and a repeated status push each
 *   leave exactly one order and one kitchen ticket.
 * The diner's screens for these are in the QR site's e2e tests; the relay's full role-by-table
 * isolation suite is infra/supabase/test/isolation.test.ts.
 */

let database: TestDatabase;
let relay: TestRelay;
let app: INestApplication;
let prisma: PrismaService;
let sync: RelaySyncService;
let qr: RelayOrdersService;
let kit: AuthKit;
let waiter: LoginResponse;
let manager: LoginResponse;
let kitchen: LoginResponse;
const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};
const id = (name: string) => ids[name] ?? '';

const server = () => request(httpServer(app));
const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const diner = (table: string) => ({
  'content-type': 'application/json',
  'x-rp-table-token': tokens[table] ?? '',
  'x-rp-browser': `browser-${table}-0000000000`,
});

async function dinerSubmits(table: string, item: string, idempotencyKey: string = randomUUID()) {
  const response = await fetch(`${relay.baseUrl}/submit-order`, {
    method: 'POST',
    headers: diner(table),
    body: JSON.stringify({
      idempotencyKey,
      lines: [{ clientLineId: randomUUID(), itemId: id(item), quantity: 1, modifiers: [] }],
    }),
  });
  return { status: response.status, body: await response.json() };
}

async function dinerOrders(table: string, item: string, idempotencyKey?: string): Promise<string> {
  const { body } = await dinerSubmits(table, item, idempotencyKey);
  const answer = QrSubmitOrderResponse.parse(body);
  if (answer.status !== 'ACCEPTED') throw new Error(JSON.stringify(answer));
  return answer.order.id;
}

async function dinerSees(table: string, relayOrderId: string): Promise<QrOrderView> {
  const response = await fetch(`${relay.baseUrl}/order-status?id=${relayOrderId}`, {
    headers: diner(table),
  });
  return QrOrderView.parse(await response.json());
}

async function dinerMenu(table: string): Promise<QrMenuResponse> {
  const response = await fetch(`${relay.baseUrl}/qr-menu`, { headers: diner(table) });
  return QrMenuResponse.parse(await response.json());
}

const qrOrders = (relayOrderId: string) =>
  prisma.order.findMany({
    where: { source: 'QR', externalRef: relayOrderId },
    include: { items: true },
  });

async function approve(relayOrderId: string): Promise<string> {
  const [order] = await qrOrders(relayOrderId);
  const approved = await server()
    .post(`/api/v1/orders/${order?.id ?? ''}/approve`)
    .set(as(waiter))
    .send({});
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  return order?.id ?? '';
}

async function posOrder(sessionId: string, item: string) {
  const response = await server()
    .post('/api/v1/orders')
    .set(as(waiter))
    .send({
      idempotencyKey: randomUUID(),
      source: 'WAITER_APP',
      orderType: 'DINE_IN',
      tableSessionId: sessionId,
      lines: [{ clientLineId: randomUUID(), itemId: id(item), quantity: 1 }],
    });
  const answer = SubmitOrderResponse.parse(response.body);
  if (answer.status !== 'ACCEPTED') throw new Error(JSON.stringify(response.body));
  return answer.orderId;
}

/** Waits until the restaurant's latest action on a QR order is marked to be told (a consumer). */
const marked = (relayOrderId: string) =>
  until(
    async () =>
      (await prisma.relayOrder.findUnique({ where: { relayOrderId } }))?.pushedHash === null,
    5_000,
    'the change to be marked for the relay',
  );

/** Time passes at the relay (its cron jobs run), not on this PC. */
async function relayTime(sql: string, params: unknown[]): Promise<void> {
  const client = await relay.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(sql, params);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

const passPickupTime = (relayOrderId: string) =>
  relayTime("UPDATE relay.qr_orders SET expires_at = now() - interval '1 second' WHERE id = $1", [
    relayOrderId,
  ]);

const relayStatus = async (relayOrderId: string) =>
  (
    await relay.admin.query<{ status: string }>(
      'SELECT status FROM relay.qr_orders WHERE id = $1',
      [relayOrderId],
    )
  ).rows[0]?.status;

const menuVersions = async () =>
  Number(
    (
      await relay.admin.query<{ count: string }>(
        'SELECT count(*) FROM relay.menu_snapshots WHERE tenant_id = $1',
        [id('tenant')],
      )
    ).rows[0]?.count,
  );

beforeAll(async () => {
  database = await createTestDatabase();
  relay = await startRelay({ adminUrl: inject('pgAdminUrl'), runId: inject('pgRunId') });
  const tenant = await relay.provision('Spice Route');
  ids.tenant = tenant.tenantId;
  const later = { firstDelayMs: 3_600_000, retryBaseMs: 3_600_000, retryMaxMs: 3_600_000 };
  app = await createTestApp({
    databaseUrl: database.url,
    config: { relayUrl: relay.baseUrl },
    overrides: [
      // The test drives every round itself.
      {
        provide: RELAY_SYNC_OPTIONS,
        useValue: { ...DEFAULT_RELAY_SYNC_OPTIONS, ...later, debounceMs: 3_600_000 },
      },
      {
        provide: RELAY_ORDERS_OPTIONS,
        useValue: {
          ...DEFAULT_RELAY_ORDERS_OPTIONS,
          ...later,
          pollMs: 3_600_000,
          pushDebounceMs: 3_600_000,
          realtimeDelayMs: 3_600_000,
        },
      },
    ],
  });
  prisma = app.get(PrismaService);
  sync = app.get(RelaySyncService);
  qr = app.get(RelayOrdersService);
  kit = await createAuthKit(app, { kitchenLogins: true });
  waiter = await signIn(app, kit, 'WAITER');
  manager = await signIn(app, kit, 'MANAGER');
  kitchen = await signIn(app, kit, 'KITCHEN');
  await saveRelayCredential(prisma, app.get<SecretStore>(SECRET_STORE), tenant.credential);

  const base = { restaurantId: kit.restaurantId };
  const station = await prisma.station.create({ data: { ...base, name: 'Kitchen' } });
  const taxGroup = await prisma.taxGroup.create({
    data: {
      ...base,
      name: 'GST 5 %',
      sacCode: '996331',
      components: {
        create: [
          { ...base, code: 'CGST', rateBp: 250 },
          { ...base, code: 'SGST', rateBp: 250 },
        ],
      },
    },
  });
  const category = await prisma.category.create({ data: { ...base, name: 'Mains' } });
  for (const [name, price] of [
    ['Dal Makhani', 24_000],
    ['Jeera Rice', 18_000],
  ] as const) {
    ids[name] = (
      await prisma.item.create({
        data: {
          ...base,
          categoryId: category.id,
          name,
          basePrice: price,
          taxGroupId: taxGroup.id,
          foodType: 'VEG',
          stationId: station.id,
        },
      })
    ).id;
  }
  expect((await server().post('/api/v1/menu/publish').set(as(manager))).status).toBe(200);
  const hall = await prisma.section.create({ data: { ...base, name: 'Hall' } });
  for (const label of ['T1', 'T2', 'T3', 'T4']) {
    ids[label] = (
      await prisma.diningTable.create({ data: { ...base, sectionId: hall.id, label } })
    ).id;
  }
  const today = await currentBusinessDate(prisma, kit.restaurantId);
  await prisma.shiftAssignment.create({
    data: { ...base, staffId: kit.staff.WAITER, sectionId: hall.id, businessDate: dbDate(today) },
  });
  await prisma.setting.create({ data: { ...base, key: 'qr.submissionsPerWindow', value: 50 } });
  app.get(SettingsService).invalidate();
  expect((await server().post('/api/v1/tables/qr-codes').set(as(manager))).status).toBe(200);
  for (const label of ['T1', 'T2', 'T3', 'T4']) {
    const table = await prisma.diningTable.findUniqueOrThrow({ where: { id: id(label) } });
    tokens[label] = table.qrToken ?? '';
  }
  expect((await sync.sync()).lastError).toBeNull();
});

afterAll(async () => {
  await app.close();
  await relay.stop();
  await database.drop();
});

describe('[S2] Phase 5 exit: the restaurant’s internet goes for 30 minutes mid-service', () => {
  it('runs as usual before: T1 orders at the POS, T2 on the QR page, both in the kitchen', async () => {
    const opened = await server()
      .post(`/api/v1/tables/${id('T1')}/open`)
      .set(as(waiter))
      .send({ covers: 2 });
    ids.session = TableSessionView.parse(opened.body).id;
    ids.pos = await posOrder(id('session'), 'Dal Makhani');
    ids.qr = await dinerOrders('T2', 'Dal Makhani');
    expect((await qr.run()).lastError).toBeNull();
    ids.qrLocal = await approve(id('qr'));
    await marked(id('qr'));
    expect((await qr.run()).lastError).toBeNull();
    expect((await dinerSees('T2', id('qr'))).status).toBe('SENT_TO_KITCHEN');
    // T3's diner orders just before the line goes; nobody here has seen it yet.
    ids.stranded = await dinerOrders('T3', 'Jeera Rice');
    ids.kotsBefore = String(await prisma.kot.count());
  });

  it('[NFR-A01] keeps everything in the restaurant working while the relay is out of reach', async () => {
    relay.cut('restaurant');
    expect((await sync.sync()).lastError).toBe('UNREACHABLE');
    expect((await qr.run()).lastError).toBe('UNREACHABLE');
    // A new POS order reaches the kitchen.
    ids.posDuring = await posOrder(id('session'), 'Jeera Rice');
    expect(await prisma.kot.count({ where: { orderId: id('posDuring') } })).toBe(1);
    // The kitchen works the QR order; the waiter serves it.
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: id('qrLocal') } });
    for (const [login, event] of [
      [kitchen, 'START_PREPARING'],
      [kitchen, 'MARK_READY'],
      [waiter, 'SERVE'],
    ] as const) {
      const step = await server()
        .post(`/api/v1/order-items/${item.id}/status`)
        .set(as(login))
        .send({ event });
      expect(step.status, `${event}: ${JSON.stringify(step.body)}`).toBe(200);
    }
    await marked(id('qr'));
    // Jeera Rice runs out.
    const out = await server()
      .put(`/api/v1/menu/items/${id('Jeera Rice')}/availability`)
      .set(as(manager))
      .send({ available: false, stockCount: null });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    // The manager can see why the QR page is read-only.
    const system = SystemStatusResponse.parse(
      (await server().get('/api/v1/system').set(as(manager))).body,
    );
    expect(system.qrRelay.lastError).toBe('UNREACHABLE');
  });

  it('[QR-008] turns the QR page read-only, the menu still readable', async () => {
    // 30 minutes without a word from the restaurant, by the relay's clock.
    await relayTime(
      "UPDATE relay.presence SET last_seen_at = now() - interval '30 minutes' WHERE tenant_id = $1",
      [id('tenant')],
    );
    const menu = await dinerMenu('T4');
    expect(menu.readOnly).toBe(true);
    expect(menu.document?.menu.items.map((item) => item.name).sort()).toEqual([
      'Dal Makhani',
      'Jeera Rice',
    ]);
    const refused = await dinerSubmits('T4', 'Dal Makhani');
    expect(refused.status).toBe(503);
    expect(ApiError.parse(refused.body).code).toBe('RESTAURANT_OFFLINE');
    const call = await fetch(`${relay.baseUrl}/service-request`, {
      method: 'POST',
      headers: diner('T4'),
      body: JSON.stringify({ type: 'WAITER', idempotencyKey: randomUUID() }),
    });
    expect(ApiError.parse(await call.json()).code).toBe('RESTAURANT_OFFLINE');
  });

  it('[S13] tells T3’s diner to call a waiter once the pickup time passed, and expires it', async () => {
    const waiting = await dinerSees('T3', id('stranded'));
    expect(waiting.status).toBe('SUBMITTED');
    await passPickupTime(id('stranded'));
    // Past its pickup time it reads expired at once, and the page says to call a waiter (QR-007).
    expect((await dinerSees('T3', id('stranded'))).status).toBe('EXPIRED');
    // The relay's minute job closes it for good.
    await relay.admin.query('SELECT relay.expire_orders()');
    expect(await relayStatus(id('stranded'))).toBe('EXPIRED');
  });

  it('drains every queue once the internet is back, with nothing lost or doubled', async () => {
    const versions = await menuVersions();
    relay.restore();
    expect((await sync.sync()).lastError).toBeNull();
    expect((await qr.run()).lastError).toBeNull();
    // The menu change made offline arrives as exactly one new version; ordering opens again.
    expect(await menuVersions()).toBe(versions + 1);
    const menu = await dinerMenu('T4');
    expect(menu.readOnly).toBe(false);
    expect(menu.document?.menu.items.find((item) => item.id === id('Jeera Rice'))?.available).toBe(
      false,
    );
    // T2's diner sees the dish served.
    const seen = await dinerSees('T2', id('qr'));
    expect(seen.status).toBe('SENT_TO_KITCHEN');
    expect(seen.detail.items?.map((line) => line.state)).toEqual(['SERVED']);
    // T3's order was never made here.
    expect(await qrOrders(id('stranded'))).toEqual([]);
    expect(await relayStatus(id('stranded'))).toBe('EXPIRED');

    // Every queue again: nothing more to send, nothing made twice.
    await sync.sync();
    await qr.run();
    expect(await menuVersions()).toBe(versions + 1);
    expect(await qrOrders(id('qr'))).toHaveLength(1);
    expect(await prisma.kot.count()).toBe(Number(id('kotsBefore')) + 1);
    expect(await prisma.relayOrder.count()).toBe(1);

    // And a new QR order goes through as before.
    const next = await dinerOrders('T4', 'Dal Makhani');
    await qr.run();
    expect(await qrOrders(next)).toHaveLength(1);
  });
});

describe('[S13] a QR order reaching the restaurant after its pickup time', () => {
  it('is rejected as expired, never made, whichever side notices first', async () => {
    // The relay's job has not run yet when the restaurant picks it up late.
    const late = await dinerOrders('T4', 'Dal Makhani');
    await passPickupTime(late);
    await qr.run();
    expect(await qrOrders(late)).toEqual([]);
    expect((await dinerSees('T4', late)).status).toBe('EXPIRED');
    // The relay's job ran first: the order is never even offered to the restaurant.
    const later = await dinerOrders('T4', 'Dal Makhani');
    await passPickupTime(later);
    await relay.admin.query('SELECT relay.expire_orders()');
    await qr.run();
    expect(await qrOrders(later)).toEqual([]);
    expect(await prisma.relayOrder.findUnique({ where: { relayOrderId: later } })).toBeNull();
    expect((await dinerSees('T4', later)).status).toBe('EXPIRED');
  });
});

describe('[S11] [QR-014] another restaurant on the same relay', () => {
  it('never sees, takes or changes this restaurant’s orders', async () => {
    const pending = await dinerOrders('T4', 'Dal Makhani');
    const neighbour = await relay.provision('Neighbour House');
    const asNeighbour = (method: string, path: string, body?: unknown) =>
      fetch(`${relay.baseUrl}/server/${path}`, {
        method,
        headers: {
          authorization: `Bearer ${neighbour.credential}`,
          'content-type': 'application/json',
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    const pickup = QrPickupResponse.parse(await (await asNeighbour('GET', 'orders')).json());
    expect(pickup.orders).toEqual([]);
    const taken = await asNeighbour('POST', `orders/${pending}/status`, { status: 'RECEIVED' });
    expect(taken.status).toBe(404);
    expect(await relayStatus(pending)).toBe('SUBMITTED');
    // This restaurant's own pickup still finds it, once.
    await qr.run();
    expect(await qrOrders(pending)).toHaveLength(1);
  });

  it('keeps a diner to their own restaurant’s menu and table', async () => {
    // A dish id from elsewhere is not on this menu.
    const foreign = await fetch(`${relay.baseUrl}/submit-order`, {
      method: 'POST',
      headers: diner('T4'),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        lines: [{ clientLineId: randomUUID(), itemId: randomUUID(), quantity: 1, modifiers: [] }],
      }),
    });
    expect(QrSubmitOrderResponse.parse(await foreign.json()).status).toBe('REJECTED');
    // Another table's order cannot be followed from this table.
    const mine = await dinerOrders('T4', 'Dal Makhani');
    const peek = await fetch(`${relay.baseUrl}/order-status?id=${mine}`, { headers: diner('T2') });
    expect(peek.status).toBe(404);
  });
});

describe('[ORD-013] duplicate replay', () => {
  it('takes a diner’s retry as the same order', async () => {
    const key = randomUUID();
    const first = await dinerOrders('T2', 'Dal Makhani', key);
    const again = QrSubmitOrderResponse.parse((await dinerSubmits('T2', 'Dal Makhani', key)).body);
    expect(again).toMatchObject({ status: 'ACCEPTED', replayed: true, order: { id: first } });
    await qr.run();
    expect(await qrOrders(first)).toHaveLength(1);
    ids.replayed = first;
  });

  it('makes one order and one ticket when the restaurant’s acknowledgement was lost', async () => {
    // The relay never heard "received": it offers the order again.
    await relayTime("UPDATE relay.qr_orders SET status = 'SUBMITTED' WHERE id = $1", [
      id('replayed'),
    ]);
    await qr.run();
    expect(await qrOrders(id('replayed'))).toHaveLength(1);
    const orderId = await approve(id('replayed'));
    expect(await prisma.kot.count({ where: { orderId } })).toBe(1);
    // The status is told, then told again after a restart forgot it was: still one of each.
    await marked(id('replayed'));
    await qr.run();
    expect((await dinerSees('T2', id('replayed'))).status).toBe('SENT_TO_KITCHEN');
    await prisma.relayOrder.update({
      where: { relayOrderId: id('replayed') },
      data: { pushedHash: null },
    });
    expect((await qr.run()).lastError).toBeNull();
    expect((await dinerSees('T2', id('replayed'))).status).toBe('SENT_TO_KITCHEN');
    expect(await qrOrders(id('replayed'))).toHaveLength(1);
    expect(await prisma.kot.count({ where: { orderId } })).toBe(1);
  });
});
