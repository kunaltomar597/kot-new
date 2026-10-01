import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { type LoginResponse, PendingApprovalsResponse } from '@rp/contracts';
import { QrOrderView, QrSubmitOrderResponse } from '@rp/contracts/relay';
import { startRelay, type TestRelay } from '@rp/relay/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { SECRET_STORE, type SecretStore } from '../../src/auth/secret-store.js';
import { currentBusinessDate, dbDate } from '../../src/common/business-dates.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { OrdersService } from '../../src/orders/orders.service.js';
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
 * The QR relay's sync agent, order side (P5-03b): a diner's order at the relay becomes a normal
 * QR order here waiting for its waiter, and what the restaurant does is told back to the diner.
 * Against a real relay, its schema and functions over HTTP.
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
let tenantId = '';
const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};
const id = (name: string) => ids[name] ?? '';

const server = () => request(httpServer(app));
const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);

/** QR codes for the tables straight at the relay (P5-04 makes real ones). */
async function giveCodes(): Promise<void> {
  for (const label of ['T1', 'T2', 'T3']) {
    tokens[label] ??= randomUUID().replaceAll('-', '');
    await relay.admin.query(
      "UPDATE relay.dining_tables SET token_hash = sha256(convert_to($2, 'UTF8')) WHERE tenant_id = $1 AND table_id = $3",
      [tenantId, tokens[label], id(label)],
    );
  }
}

/** A diner at `table` orders on the QR page, through the relay. */
async function dinerOrders(
  table: string,
  lines: { item: string; quantity: number }[],
): Promise<string> {
  const response = await fetch(`${relay.baseUrl}/submit-order`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-rp-table-token': tokens[table] ?? '',
      'x-rp-browser': `browser-${table}-0000000000`,
    },
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      lines: lines.map((line) => ({
        clientLineId: randomUUID(),
        itemId: id(line.item),
        quantity: line.quantity,
        modifiers: [],
      })),
      customerName: 'Asha',
    }),
  });
  const answer = QrSubmitOrderResponse.parse(await response.json());
  if (answer.status !== 'ACCEPTED') throw new Error(JSON.stringify(answer));
  return answer.order.id;
}

/** The diner's page asking how their order is doing. */
async function dinerSees(table: string, relayOrderId: string): Promise<QrOrderView> {
  const response = await fetch(`${relay.baseUrl}/order-status?id=${relayOrderId}`, {
    headers: { 'x-rp-table-token': tokens[table] ?? '' },
  });
  return QrOrderView.parse(await response.json());
}

/** Waits until the restaurant's latest action on a QR order is marked to be told to the relay. */
async function marked(relayOrderId: string): Promise<void> {
  await until(
    async () =>
      (await prisma.relayOrder.findUnique({ where: { relayOrderId } }))?.pushedHash === null,
    5_000,
    'the change to be marked for the relay',
  );
}

const localOrder = (relayOrderId: string) =>
  prisma.order.findFirst({
    where: { source: 'QR', externalRef: relayOrderId },
    include: { items: { orderBy: { createdAt: 'asc' } } },
  });

/** Moves a relay order's pickup deadline into the past, as if nobody picked it up in time. */
async function letExpire(relayOrderId: string): Promise<void> {
  const client = await relay.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(
      "UPDATE relay.qr_orders SET expires_at = now() - interval '1 second' WHERE id = $1",
      [relayOrderId],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  database = await createTestDatabase();
  relay = await startRelay({ adminUrl: inject('pgAdminUrl'), runId: inject('pgRunId') });
  const tenant = await relay.provision('Spice Route');
  tenantId = tenant.tenantId;
  const later = { firstDelayMs: 3_600_000, retryBaseMs: 3_600_000, retryMaxMs: 3_600_000 };
  app = await createTestApp({
    databaseUrl: database.url,
    config: { relayUrl: relay.baseUrl },
    overrides: [
      // The test drives each round itself.
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
  for (const label of ['T1', 'T2', 'T3']) {
    ids[label] = (
      await prisma.diningTable.create({ data: { ...base, sectionId: hall.id, label } })
    ).id;
  }
  // The waiter looks after the hall today (TBL-002).
  const today = await currentBusinessDate(prisma, kit.restaurantId);
  await prisma.shiftAssignment.create({
    data: { ...base, staffId: kit.staff.WAITER, sectionId: hall.id, businessDate: dbDate(today) },
  });
  // Many orders go to T3 here; the relay's rate limit has tests of its own (QR-006).
  await prisma.setting.create({ data: { ...base, key: 'qr.submissionsPerWindow', value: 50 } });
  app.get(SettingsService).invalidate();
  expect((await sync.sync()).lastError).toBeNull();
  await giveCodes();
});

afterAll(async () => {
  await app.close();
  await relay.stop();
  await database.drop();
});

describe('[QR-009] [QR-010] a diner’s order for a table that is not open', () => {
  it('waits for the waiter who looks after the table, priced here', async () => {
    ids.first = await dinerOrders('T1', [{ item: 'Dal Makhani', quantity: 2 }]);
    expect((await qr.run()).lastError).toBeNull();
    const order = await localOrder(id('first'));
    expect(order).toMatchObject({
      source: 'QR',
      orderType: 'DINE_IN',
      tableId: id('T1'),
      tableSessionId: null,
      customerName: 'Asha',
    });
    expect(
      order?.items.map((item) => [item.name, item.state, item.unitPrice, item.quantity]),
    ).toEqual([['Dal Makhani', 'PENDING_APPROVAL', 24_000, 2]]);
    expect(order?.items[0]?.clientLineId).toMatch(/^[0-9a-f-]{36}$/);
    const alert = await until(
      () =>
        prisma.alert
          .findFirst({
            where: { type: 'ORDER_PENDING_APPROVAL', orderId: order?.id, status: 'OPEN' },
          })
          .then((found) => found ?? undefined),
      5_000,
      'the approval alert',
    );
    // The waiter who looks after T1 (a manager too, while the waiter has no device connected).
    expect(alert.recipientIds).toContain(kit.staff.WAITER);
    expect(await dinerSees('T1', id('first'))).toMatchObject({ status: 'RECEIVED' });
    const { rows } = await relay.admin.query<{ local_order_id: string }>(
      'SELECT local_order_id FROM relay.qr_orders WHERE id = $1',
      [id('first')],
    );
    expect(rows[0]?.local_order_id).toBe(order?.id);
  });

  it('[WTR-004] is in the waiter’s approvals, and approving opens the table', async () => {
    const order = await localOrder(id('first'));
    const inbox = PendingApprovalsResponse.parse(
      (await server().get('/api/v1/orders/pending-approval').set(as(waiter))).body,
    );
    expect(inbox.orders.map((entry) => [entry.order.id, entry.tableLabel])).toEqual([
      [order?.id, 'T1'],
    ]);
    const approved = await server()
      .post(`/api/v1/orders/${order?.id ?? ''}/approve`)
      .set(as(waiter))
      .send({});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const table = await prisma.diningTable.findUniqueOrThrow({
      where: { id: id('T1') },
      include: { sessions: { where: { status: 'OPEN' } } },
    });
    expect(table.state).toBe('OCCUPIED');
    expect(table.sessions).toEqual([
      expect.objectContaining({ covers: 1, waiterId: kit.staff.WAITER }),
    ]);
    expect((await localOrder(id('first')))?.tableSessionId).toBe(table.sessions[0]?.id);
    expect(await prisma.kot.count({ where: { orderId: order?.id } })).toBe(1);
  });

  it('[QR-007] tells the diner it was sent to the kitchen, and each line’s state', async () => {
    await marked(id('first'));
    await qr.run();
    const sent = await dinerSees('T1', id('first'));
    expect(sent.status).toBe('SENT_TO_KITCHEN');
    expect(sent.detail.items?.map((item) => item.state)).toEqual(['SENT']);
    const item = (await localOrder(id('first')))?.items[0];
    const step = await server()
      .post(`/api/v1/order-items/${item?.id ?? ''}/status`)
      .set(as(kitchen))
      .send({ event: 'START_PREPARING' });
    expect(step.status, JSON.stringify(step.body)).toBe(200);
    await marked(id('first'));
    await qr.run();
    expect((await dinerSees('T1', id('first'))).detail.items?.map((line) => line.state)).toEqual([
      'PREPARING',
    ]);
  });
});

describe('[QR-009] a diner’s order for an open table', () => {
  it('joins the table’s session', async () => {
    const opened = await server()
      .post(`/api/v1/tables/${id('T2')}/open`)
      .set(as(waiter))
      .send({ covers: 3 });
    expect(opened.status).toBe(201);
    ids.second = await dinerOrders('T2', [{ item: 'Jeera Rice', quantity: 1 }]);
    await qr.run();
    const order = await localOrder(id('second'));
    expect(order?.tableSessionId).toBe((opened.body as { id: string }).id);
  });

  it('[ORD-004] tells the diner the waiter rejected it, and why', async () => {
    const order = await localOrder(id('second'));
    const rejected = await server()
      .post(`/api/v1/orders/${order?.id ?? ''}/reject`)
      .set(as(waiter))
      .send({ reason: 'Rice is finished for today' });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    await marked(id('second'));
    await qr.run();
    expect(await dinerSees('T2', id('second'))).toMatchObject({
      status: 'REJECTED',
      detail: { rejectionReason: 'Rice is finished for today' },
    });
  });
});

describe('[QR-007] what the restaurant cannot take', () => {
  it('rejects lines the menu here can no longer serve, with the reason, and makes nothing', async () => {
    // Out of stock here a moment ago; the relay has not heard yet.
    await prisma.item.update({ where: { id: id('Dal Makhani') }, data: { available: false } });
    const relayOrderId = await dinerOrders('T3', [{ item: 'Dal Makhani', quantity: 1 }]);
    await qr.run();
    expect(await localOrder(relayOrderId)).toBeNull();
    const seen = await dinerSees('T3', relayOrderId);
    expect(seen.status).toBe('REJECTED');
    expect(seen.detail.rejectionReason).toContain('Dal Makhani');
    await prisma.item.update({ where: { id: id('Dal Makhani') }, data: { available: true } });
  });

  it('never picks up an order nobody took in time: the diner is told to call a waiter', async () => {
    const relayOrderId = await dinerOrders('T3', [{ item: 'Jeera Rice', quantity: 1 }]);
    await letExpire(relayOrderId);
    await qr.run();
    expect(await localOrder(relayOrderId)).toBeNull();
    expect(await prisma.relayOrder.findUnique({ where: { relayOrderId } })).toBeNull();
    expect((await dinerSees('T3', relayOrderId)).status).toBe('EXPIRED');
  });

  it('rejects an order that arrives late by the relay’s clock, and says it expired', async () => {
    const relayOrderId = await dinerOrders('T3', [{ item: 'Jeera Rice', quantity: 1 }]);
    // This PC's clock is two minutes behind the relay's: the order is already past its time.
    const skew = vi
      .spyOn(sync, 'status')
      .mockReturnValue({ ...sync.status(), clockOffsetMs: 120_000 });
    await qr.run();
    skew.mockRestore();
    expect(await localOrder(relayOrderId)).toBeNull();
    expect(await prisma.relayOrder.findUnique({ where: { relayOrderId } })).toMatchObject({
      outcome: 'EXPIRED',
      pushedStatus: 'EXPIRED',
    });
    const { rows } = await relay.admin.query<{ status: string }>(
      'SELECT status FROM relay.qr_orders WHERE id = $1',
      [relayOrderId],
    );
    expect(rows[0]?.status).toBe('EXPIRED');
  });
});

describe('[ORD-013] [NFR-A01] never twice, never lost', () => {
  it('takes an order once however often it is picked up', async () => {
    const relayOrderId = await dinerOrders('T3', [{ item: 'Jeera Rice', quantity: 2 }]);
    await Promise.all([qr.run(), qr.run(), qr.run()]);
    await qr.run();
    expect(await prisma.order.count({ where: { externalRef: relayOrderId } })).toBe(1);
  });

  it('finishes an order a crash left half taken', async () => {
    const orders = app.get(OrdersService);
    const crash = vi.spyOn(orders, 'submit').mockRejectedValueOnce(new Error('power cut'));
    const relayOrderId = await dinerOrders('T3', [{ item: 'Dal Makhani', quantity: 1 }]);
    expect((await qr.run()).lastError).toBe('INTERNAL');
    crash.mockRestore();
    // The relay was told it was received; the inbox still has it.
    expect((await dinerSees('T3', relayOrderId)).status).toBe('RECEIVED');
    expect(await localOrder(relayOrderId)).toBeNull();
    expect((await qr.run()).lastError).toBeNull();
    expect(await prisma.order.count({ where: { externalRef: relayOrderId } })).toBe(1);
  });

  it('catches up after an internet cut, on both sides', async () => {
    const relayOrderId = await dinerOrders('T3', [{ item: 'Jeera Rice', quantity: 1 }]);
    relay.cut();
    expect((await qr.run()).lastError).toBe('UNREACHABLE');
    relay.restore();
    await qr.run();
    const order = await localOrder(relayOrderId);
    expect(order?.items.map((item) => item.state)).toEqual(['PENDING_APPROVAL']);
    const approved = await server()
      .post(`/api/v1/orders/${order?.id ?? ''}/approve`)
      .set(as(manager))
      .send({});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    relay.cut();
    await marked(relayOrderId);
    expect((await qr.run()).lastError).toBe('UNREACHABLE');
    relay.restore();
    await qr.run();
    expect((await dinerSees('T3', relayOrderId)).status).toBe('SENT_TO_KITCHEN');
    expect(await prisma.order.count({ where: { externalRef: relayOrderId } })).toBe(1);
  });
});
