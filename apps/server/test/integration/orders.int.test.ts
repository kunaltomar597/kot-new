import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  type LoginResponse,
  OrderListResponse,
  OrderView,
  SubmitOrderRequest,
  SubmitOrderResponse,
  TableSessionView,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { MenuPublishService } from '../../src/menu/menu-publish.service.js';
import { OrdersService } from '../../src/orders/orders.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let waiter: LoginResponse;
let manager: LoginResponse;
const ids: Record<string, string> = {};
const id = (name: string) => ids[name] ?? '';

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  waiter = await signIn(app, kit, 'WAITER');
  manager = await signIn(app, kit, 'MANAGER');
  const base = { restaurantId: kit.restaurantId };

  const category = await prisma.category.create({ data: { ...base, name: 'Menu' } });
  ids.kitchen = (
    await prisma.station.create({ data: { ...base, name: 'Kitchen', mode: 'BOTH' } })
  ).id;
  ids.bar = (await prisma.station.create({ data: { ...base, name: 'Bar', mode: 'SCREEN' } })).id;
  ids.gst = (
    await prisma.taxGroup.create({
      data: {
        ...base,
        name: 'GST 5 %',
        components: {
          create: [
            { ...base, code: 'CGST', rateBp: 250 },
            { ...base, code: 'SGST', rateBp: 250 },
          ],
        },
      },
    })
  ).id;
  const item = async (name: string, price: number, station: string, extra: object = {}) => {
    ids[name] = (
      await prisma.item.create({
        data: {
          ...base,
          categoryId: category.id,
          name,
          basePrice: price,
          taxGroupId: id('gst'),
          foodType: 'VEG',
          stationId: id(station),
          ...extra,
        },
      })
    ).id;
  };
  await item('Paneer Tikka', 28_000, 'kitchen');
  await item('Dal', 18_000, 'kitchen');
  await item('Roti', 3_000, 'kitchen');
  await item('Lassi', 9_000, 'bar');
  await item('Chaas', 6_000, 'bar');
  await item('POS Special', 50_000, 'kitchen', { channels: ['POS'] });
  await item('Thali', 34_900, 'kitchen');
  const half = await prisma.variant.create({
    data: { ...base, itemId: id('Paneer Tikka'), name: 'Half', price: 16_000, displayOrder: 1 },
  });
  ids.half = half.id;
  await prisma.variant.create({
    data: { ...base, itemId: id('Paneer Tikka'), name: 'Full', price: 28_000, displayOrder: 2 },
  });
  const group = await prisma.modifierGroup.create({
    data: {
      ...base,
      name: 'Extras',
      minSelections: 0,
      maxSelections: 2,
      options: { create: [{ ...base, name: 'Extra cheese', priceDelta: 4_000 }] },
    },
    include: { options: true },
  });
  ids.extras = group.id;
  ids.cheese = group.options[0]?.id ?? '';
  await prisma.itemModifierGroup.create({
    data: { ...base, itemId: id('Paneer Tikka'), groupId: group.id },
  });
  await prisma.combo.create({
    data: {
      ...base,
      itemId: id('Thali'),
      components: {
        create: [
          { ...base, kind: 'FIXED', itemId: id('Dal'), quantity: 1, displayOrder: 1 },
          { ...base, kind: 'FIXED', itemId: id('Roti'), quantity: 3, displayOrder: 2 },
          {
            ...base,
            kind: 'CHOICE',
            label: 'Drink',
            quantity: 1,
            displayOrder: 3,
            choices: {
              create: [
                { ...base, itemId: id('Lassi') },
                { ...base, itemId: id('Chaas') },
              ],
            },
          },
        ],
      },
    },
  });
  // Dal is counted: 5 portions.
  await prisma.item.update({ where: { id: id('Dal') }, data: { trackStock: true } });
  await prisma.stockLevel.create({ data: { ...base, itemId: id('Dal'), quantity: 5 } });
  await publish();

  const hall = await prisma.section.create({ data: { ...base, name: 'Hall' } });
  for (const label of ['T1', 'T2']) {
    ids[label] = (
      await prisma.diningTable.create({ data: { ...base, sectionId: hall.id, label } })
    ).id;
  }
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;
const server = () => request(httpServer(app));

async function publish() {
  const response = await server().post('/api/v1/menu/publish').set(as(manager));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

async function openTable(label: string): Promise<TableSessionView> {
  const response = await server()
    .post(`/api/v1/tables/${id(label)}/open`)
    .set(as(waiter))
    .send({ covers: 2 });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return TableSessionView.parse(response.body);
}

const line = (itemId: string, extra: object = {}) => ({
  clientLineId: randomUUID(),
  itemId,
  quantity: 1,
  ...extra,
});

function submit(body: object, login: LoginResponse = waiter) {
  return server().post('/api/v1/orders').set(as(login)).send(body);
}

async function stockOf(name: string) {
  return (await prisma.stockLevel.findUniqueOrThrow({ where: { itemId: id(name) } })).quantity;
}

async function orderOf(response: request.Response): Promise<OrderView> {
  const accepted = SubmitOrderResponse.parse(response.body);
  if (accepted.status !== 'ACCEPTED') throw new Error(JSON.stringify(response.body));
  return OrderView.parse(
    (await server().get(`/api/v1/orders/${accepted.orderId}`).set(as(waiter))).body,
  );
}

describe('[ORD-001] [ORD-014] submitting an order', () => {
  let session: TableSessionView;

  it('prices every line on the server and sends staff orders to the kitchen by station', async () => {
    session = await openTable('T1');
    const response = await submit({
      idempotencyKey: randomUUID(),
      source: 'WAITER_APP',
      orderType: 'DINE_IN',
      tableSessionId: session.id,
      lines: [
        line(id('Paneer Tikka'), {
          quantity: 2,
          variantId: id('half'),
          modifiers: [{ groupId: id('extras'), optionIds: [id('cheese')] }],
          instructions: 'Less spicy',
        }),
        line(id('Lassi')),
      ],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(SubmitOrderResponse.parse(response.body)).toMatchObject({
      status: 'ACCEPTED',
      orderNumber: 1,
      replayed: false,
      itemState: 'SENT',
    });
    const order = await orderOf(response);
    const tikka = order.items.find((item) => item.name === 'Paneer Tikka');
    // Half (₹160) + extra cheese (₹40) = ₹200 each, two of them.
    expect(tikka).toMatchObject({
      variantName: 'Half',
      unitPrice: 20_000,
      lineTotal: 40_000,
      state: 'SENT',
      instructions: 'Less spicy',
      modifiers: [{ name: 'Extra cheese', priceDelta: 4_000 }],
    });
    // One ticket per station, numbered for the day; the bar screen prints nothing.
    expect(order.kots.map((kot) => [kot.kotNumber, kot.stationId])).toEqual([
      [1, id('kitchen')],
      [2, id('bar')],
    ]);
    const kots = await prisma.kot.findMany({ orderBy: { kotNumber: 'asc' } });
    expect(kots.map((kot) => kot.printStatus)).toEqual(['PENDING', 'NOT_REQUIRED']);
    const events = await prisma.outboxEvent.findMany({ orderBy: { writeOrder: 'asc' } });
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(['OrderSubmitted', 'KotCreated']),
    );
    expect(await prisma.auditLog.count({ where: { action: 'ORDER_SUBMITTED' } })).toBe(1);
  });

  it('refuses prices sent by a client and sources that are not staff', async () => {
    const priced = await submit({
      idempotencyKey: randomUUID(),
      source: 'POS',
      orderType: 'TAKEAWAY',
      lines: [{ ...line(id('Lassi')), unitPrice: 1 }],
    });
    expect([priced.status, codeOf(priced)]).toEqual([400, 'VALIDATION_FAILED']);
    const tablet = await submit({
      idempotencyKey: randomUUID(),
      source: 'TABLE_TABLET',
      orderType: 'DINE_IN',
      tableSessionId: session.id,
      lines: [line(id('Lassi'))],
    });
    expect([tablet.status, codeOf(tablet)]).toEqual([422, 'SOURCE_NOT_ALLOWED']);
  });

  it('[ORD-013] returns the original result for a repeated key: one order, one ticket set, one stock deduction', async () => {
    const before = await stockOf('Dal');
    const body = {
      idempotencyKey: randomUUID(),
      source: 'POS',
      orderType: 'TAKEAWAY',
      customerName: 'Anita',
      lines: [line(id('Dal'), { quantity: 2 })],
    };
    const [first, second] = await Promise.all([submit(body), submit(body)]);
    const third = await submit(body);
    const results = [first, second, third].map((response) =>
      SubmitOrderResponse.parse(response.body),
    );
    const orderIds = new Set(
      results.map((result) => (result.status === 'ACCEPTED' ? result.orderId : '')),
    );
    expect(orderIds.size).toBe(1);
    expect(
      results.filter((result) => result.status === 'ACCEPTED' && result.replayed),
    ).toHaveLength(2);
    expect(await prisma.order.count({ where: { customerName: 'Anita' } })).toBe(1);
    expect(await stockOf('Dal')).toBe(before - 2);

    const order = await orderOf(first);
    expect(order.takeawayToken).toBe(1);
    expect(order.kots).toHaveLength(1);

    const reused = await submit({ ...body, lines: [line(id('Roti'))] });
    expect([reused.status, codeOf(reused)]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
  });

  it('[ORD-017] reports every line it cannot serve and creates nothing', async () => {
    const orders = await prisma.order.count();
    const out = line(id('Dal'), { quantity: 9 });
    const channel = line(id('POS Special'));
    const selection = line(id('Paneer Tikka'));
    const response = await submit({
      idempotencyKey: randomUUID(),
      source: 'WAITER_APP',
      orderType: 'DINE_IN',
      tableSessionId: session.id,
      lines: [line(id('Lassi')), out, channel, selection],
    });
    expect(response.status).toBe(200);
    const result = SubmitOrderResponse.parse(response.body);
    expect(result.status).toBe('PARTIALLY_REJECTED');
    if (result.status !== 'PARTIALLY_REJECTED') return;
    expect(result.rejectedLines.map((rejected) => [rejected.clientLineId, rejected.code])).toEqual(
      expect.arrayContaining([
        [out.clientLineId, 'OUT_OF_STOCK'],
        [channel.clientLineId, 'NOT_ON_CHANNEL'],
        [selection.clientLineId, 'INVALID_SELECTION'],
      ]),
    );
    expect(result.rejectedLines).toHaveLength(3);
    expect(await prisma.order.count()).toBe(orders);

    await prisma.item.update({ where: { id: id('Chaas') }, data: { available: false } });
    const unavailable = await submit({
      idempotencyKey: randomUUID(),
      source: 'POS',
      orderType: 'TAKEAWAY',
      lines: [line(id('Chaas'))],
    });
    expect(SubmitOrderResponse.parse(unavailable.body)).toMatchObject({
      status: 'PARTIALLY_REJECTED',
      rejectedLines: [{ code: 'NOT_AVAILABLE_NOW' }],
    });
    await prisma.item.update({ where: { id: id('Chaas') }, data: { available: true } });
  });

  it('[MENU-005] explodes a combo into its parts on each station ticket', async () => {
    const before = await stockOf('Dal');
    const response = await submit({
      idempotencyKey: randomUUID(),
      source: 'WAITER_APP',
      orderType: 'DINE_IN',
      tableSessionId: session.id,
      lines: [line(id('Thali'), { quantity: 2, comboChoices: [id('Chaas')] })],
    });
    const order = await orderOf(response);
    const thali = order.items.find((item) => item.name === 'Thali');
    expect(thali).toMatchObject({ unitPrice: 34_900, lineTotal: 69_800, parentOrderItemId: null });
    const parts = order.items.filter((item) => item.parentOrderItemId === thali?.id);
    expect(parts.map((part) => [part.name, part.quantity, part.lineTotal])).toEqual([
      ['Dal', 2, 0],
      ['Roti', 6, 0],
      ['Chaas', 2, 0],
    ]);
    expect(order.kots.map((kot) => kot.stationId)).toEqual([id('kitchen'), id('bar')]);
    expect(await stockOf('Dal')).toBe(before - 2);

    const wrong = await submit({
      idempotencyKey: randomUUID(),
      source: 'WAITER_APP',
      orderType: 'DINE_IN',
      tableSessionId: session.id,
      lines: [line(id('Thali'), { comboChoices: [id('Roti')] })],
    });
    expect(SubmitOrderResponse.parse(wrong.body)).toMatchObject({
      status: 'PARTIALLY_REJECTED',
      rejectedLines: [{ code: 'INVALID_SELECTION' }],
    });
  });

  it('[MENU-009] keeps the price an order was placed at when the menu price changes', async () => {
    const first = await orderOf(
      await submit({
        idempotencyKey: randomUUID(),
        source: 'POS',
        orderType: 'TAKEAWAY',
        lines: [line(id('Lassi'))],
      }),
    );
    await prisma.item.update({ where: { id: id('Lassi') }, data: { basePrice: 10_000 } });
    await publish();
    const second = await orderOf(
      await submit({
        idempotencyKey: randomUUID(),
        source: 'POS',
        orderType: 'TAKEAWAY',
        lines: [line(id('Lassi'))],
      }),
    );
    const again = OrderView.parse(
      (await server().get(`/api/v1/orders/${first.id}`).set(as(waiter))).body,
    );
    expect([again.items[0]?.unitPrice, second.items[0]?.unitPrice]).toEqual([9_000, 10_000]);
    expect(second.takeawayToken).toBe(3);
  });

  it('[TBL-004] brings a table waiting for its bill back to OCCUPIED, and refuses closed tables', async () => {
    await server().post(`/api/v1/table-sessions/${session.id}/request-bill`).set(as(waiter));
    await submit({
      idempotencyKey: randomUUID(),
      source: 'WAITER_APP',
      orderType: 'DINE_IN',
      tableSessionId: session.id,
      lines: [line(id('Roti'))],
    });
    expect((await prisma.diningTable.findUniqueOrThrow({ where: { id: id('T1') } })).state).toBe(
      'OCCUPIED',
    );

    const other = await openTable('T2');
    await server()
      .post(`/api/v1/table-sessions/${other.id}/close-without-bill`)
      .set(as(waiter))
      .send({ reason: 'Wrong table' });
    const closed = await submit({
      idempotencyKey: randomUUID(),
      source: 'WAITER_APP',
      orderType: 'DINE_IN',
      tableSessionId: other.id,
      lines: [line(id('Roti'))],
    });
    expect([closed.status, codeOf(closed)]).toEqual([409, 'TABLE_SESSION_CLOSED']);
  });

  it('[ORD-003] holds customer orders for approval: no ticket, no stock taken', async () => {
    const before = await stockOf('Dal');
    const kots = await prisma.kot.count();
    const result = await app.get(OrdersService).submit(
      { restaurantId: kit.restaurantId, staffId: null, deviceId: null },
      SubmitOrderRequest.parse({
        idempotencyKey: randomUUID(),
        source: 'TABLE_TABLET',
        orderType: 'DINE_IN',
        tableSessionId: session.id,
        lines: [line(id('Dal'))],
      }),
    );
    expect(result).toMatchObject({ status: 'ACCEPTED', itemState: 'PENDING_APPROVAL' });
    expect(await prisma.kot.count()).toBe(kots);
    expect(await stockOf('Dal')).toBe(before);
    const submitted = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: 'OrderSubmitted' },
      orderBy: { writeOrder: 'desc' },
    });
    expect(submitted.payload).toMatchObject({ payload: { needsApproval: true } });
    expect(app.get(MenuPublishService)).toBeDefined();
  });
});

describe('[TBL-007] [TBL-008] listing orders for the POS', () => {
  it('lists a table session’s orders oldest first, with item states', async () => {
    const session = await openTable('T2');
    for (const name of ['Dal', 'Roti']) {
      const response = await submit({
        idempotencyKey: randomUUID(),
        source: 'WAITER_APP',
        orderType: 'DINE_IN',
        tableSessionId: session.id,
        lines: [line(id(name))],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }
    const response = await server()
      .get(`/api/v1/table-sessions/${session.id}/orders`)
      .set(as(waiter));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const { orders } = OrderListResponse.parse(response.body);
    expect(orders.map((order) => order.items.map((item) => [item.name, item.state]))).toEqual([
      [['Dal', 'SENT']],
      [['Roti', 'SENT']],
    ]);
    expect(orders.every((order) => order.tableSessionId === session.id)).toBe(true);

    const missing = await server()
      .get(`/api/v1/table-sessions/${randomUUID()}/orders`)
      .set(as(waiter));
    expect([missing.status, codeOf(missing)]).toEqual([404, 'TABLE_SESSION_NOT_FOUND']);
  });

  it('lists today’s open takeaway orders with their tokens', async () => {
    const response = await submit(
      {
        idempotencyKey: randomUUID(),
        source: 'POS',
        orderType: 'TAKEAWAY',
        customerName: 'Anil',
        lines: [line(id('Roti'), { quantity: 3 })],
      },
      manager,
    );
    const placed = await orderOf(response);
    const listed = await server().get('/api/v1/orders/takeaway').set(as(waiter));
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const { orders } = OrderListResponse.parse(listed.body);
    expect(orders.every((order) => order.orderType === 'TAKEAWAY' && order.status === 'OPEN')).toBe(
      true,
    );
    const mine = orders.find((order) => order.id === placed.id);
    expect(mine).toMatchObject({ customerName: 'Anil', takeawayToken: placed.takeawayToken });
    expect(mine?.takeawayToken).not.toBeNull();
    expect((await server().get('/api/v1/orders/takeaway')).status).toBe(401);
  });
});
