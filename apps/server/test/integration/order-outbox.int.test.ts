import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ApiClient } from '@rp/api-client';
import type { LoginResponse, SubmitOrderRequest } from '@rp/contracts';
import { MemoryStore, type OrderDraft, OrderOutbox, type SentOrder } from '@rp/mobile-core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import {
  addDevice,
  authHeaders,
  type AuthKit,
  createAuthKit,
  deviceTokenOf,
  signIn,
} from '../helpers/auth-kit.js';
import { appUrl, createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

/**
 * The waiter app's order outbox (`@rp/mobile-core`) against the real server (P2-02b, WTR-012,
 * ORD-013): orders are kept on the phone and sent again with the same idempotency key until the
 * server answers, and the server makes each order, its kitchen tickets and its stock deduction
 * exactly once however many times it arrives.
 */

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let waiter: LoginResponse;
let outbox: OrderOutbox;
let tableSessionId: string;
const ids: Record<string, string> = {};
const id = (name: string) => ids[name] ?? '';
const sent: SentOrder[] = [];

/** The phone's network: `down` fails before the server, `loseAnswers` after it has answered. */
let network: 'up' | 'down' | 'loseAnswers' = 'up';
const phoneFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const isOrder = url.endsWith('/api/v1/orders') && init?.method === 'POST';
  if (network === 'down' && isOrder) throw new TypeError('fetch failed');
  const response = await fetch(input, init);
  if (network === 'loseAnswers' && isOrder) {
    await response.arrayBuffer();
    throw new TypeError('fetch failed');
  }
  return response;
};

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url, listen: true });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  const base = { restaurantId: kit.restaurantId };

  // A menu with a kitchen that prints and a bar screen, and a counted dish.
  const category = await prisma.category.create({ data: { ...base, name: 'Menu' } });
  const kitchen = await prisma.station.create({ data: { ...base, name: 'Kitchen', mode: 'BOTH' } });
  const bar = await prisma.station.create({ data: { ...base, name: 'Bar', mode: 'SCREEN' } });
  const gst = await prisma.taxGroup.create({
    data: {
      ...base,
      name: 'GST 5 %',
      components: { create: [{ ...base, code: 'CGST', rateBp: 250 }] },
    },
  });
  for (const [name, price, stationId] of [
    ['Dal', 18_000, kitchen.id],
    ['Lassi', 9_000, bar.id],
  ] as const) {
    ids[name] = (
      await prisma.item.create({
        data: {
          ...base,
          categoryId: category.id,
          name,
          basePrice: price,
          taxGroupId: gst.id,
          foodType: 'VEG',
          stationId,
        },
      })
    ).id;
  }
  await prisma.item.update({ where: { id: id('Dal') }, data: { trackStock: true } });
  await prisma.stockLevel.create({ data: { ...base, itemId: id('Dal'), quantity: 10 } });
  const manager = await signIn(app, kit, 'MANAGER');
  const published = await request(httpServer(app))
    .post('/api/v1/menu/publish')
    .set(authHeaders(kit.deviceId, manager.accessToken));
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  const hall = await prisma.section.create({ data: { ...base, name: 'Hall' } });
  const table = await prisma.diningTable.create({
    data: { ...base, sectionId: hall.id, label: 'T1' },
  });

  // A paired waiter phone with the waiter signed in, as the app has it.
  const phone = await addDevice(app, kit, 'WAITER_PHONE');
  waiter = await signIn(app, kit, 'WAITER', phone);
  const client = new ApiClient({
    baseUrl: appUrl(app),
    fetch: phoneFetch,
    credentials: {
      device: {
        deviceId: phone,
        deviceToken: deviceTokenOf(phone),
        deviceTokenExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      },
      session: waiter,
    },
  });
  outbox = new OrderOutbox({
    store: new MemoryStore(),
    api: () => client.api,
    staffId: () => waiter.staff.id,
  });
  outbox.onSent((order) => sent.push(order));
  tableSessionId = (
    await client.api.openTable({ params: { tableId: table.id }, body: { covers: 2 } })
  ).id;
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

function draft(lines: { item: string; quantity: number }[]): OrderDraft {
  const request: SubmitOrderRequest = {
    idempotencyKey: randomUUID(),
    source: 'WAITER_APP',
    orderType: 'DINE_IN',
    tableSessionId,
    lines: lines.map((line) => ({
      clientLineId: randomUUID(),
      itemId: id(line.item),
      quantity: line.quantity,
      modifiers: [],
    })),
  };
  return {
    staffId: waiter.staff.id,
    tableLabel: 'T1',
    request,
    lines: request.lines.map((line, index) => ({
      clientLineId: line.clientLineId,
      itemId: line.itemId,
      name: lines[index]?.item ?? '',
      summary: '',
      quantity: line.quantity,
      selection: {},
      instructions: '',
      unitPrice: 0,
    })),
  };
}

async function counts() {
  const stock = await prisma.stockLevel.findUniqueOrThrow({ where: { itemId: id('Dal') } });
  return {
    orders: await prisma.order.count(),
    kots: await prisma.kot.count(),
    dalLeft: stock.quantity,
  };
}

describe('[WTR-012] [ORD-013] waiter orders kept on the phone', () => {
  it('sends an order whose answer was lost again with the same key: one order, one set of KOTs, one stock deduction', async () => {
    network = 'loseAnswers';
    const order = draft([
      { item: 'Dal', quantity: 2 },
      { item: 'Lassi', quantity: 1 },
    ]);
    expect(await outbox.submit(order)).toEqual({ status: 'QUEUED' });
    // The server made it; the phone did not hear.
    expect(await counts()).toEqual({ orders: 1, kots: 2, dalLeft: 8 });
    expect((await outbox.list()).map((entry) => entry.status)).toEqual(['PENDING']);

    network = 'up';
    expect(await outbox.flush()).toEqual({ sent: 1, retry: 0, rejected: 0 });
    expect(await counts()).toEqual({ orders: 1, kots: 2, dalLeft: 8 });
    expect(await outbox.list()).toEqual([]);
    const [resent] = sent.splice(0);
    expect(resent).toMatchObject({
      background: true,
      order: { status: 'ACCEPTED', replayed: true },
    });
    const made = await prisma.order.findFirstOrThrow();
    expect(resent?.order.orderId).toBe(made.id);
    // The server knows the key once.
    expect(
      await prisma.idempotencyRecord.count({ where: { key: order.request.idempotencyKey } }),
    ).toBe(1);
  });

  it('sends an order made offline exactly once when the connection is back', async () => {
    const before = await counts();
    network = 'down';
    expect(await outbox.submit(draft([{ item: 'Dal', quantity: 1 }]))).toEqual({
      status: 'QUEUED',
    });
    expect(await counts()).toEqual(before);

    network = 'up';
    expect(await outbox.flush()).toEqual({ sent: 1, retry: 0, rejected: 0 });
    expect(await outbox.flush()).toEqual({ sent: 0, retry: 0, rejected: 0 });
    expect(await counts()).toEqual({
      orders: before.orders + 1,
      kots: before.kots + 1,
      dalLeft: before.dalLeft - 1,
    });
    expect(sent.splice(0).map((order) => order.order.replayed)).toEqual([false]);
  });

  it('keeps an order refused because a dish ran out while it waited, and makes nothing', async () => {
    const before = await counts();
    network = 'down';
    await outbox.submit(draft([{ item: 'Dal', quantity: before.dalLeft + 1 }]));
    network = 'up';
    expect(await outbox.flush()).toEqual({ sent: 0, retry: 0, rejected: 1 });
    const [entry] = await outbox.list();
    expect(entry).toMatchObject({ status: 'REJECTED', lastError: 'LINES_REJECTED' });
    expect(entry?.body.problem).toMatchObject({
      kind: 'LINES',
      lines: [{ code: 'OUT_OF_STOCK', message: 'Dal is out of stock.' }],
    });
    expect(await counts()).toEqual(before);
    // The waiter takes it back to change it; it is gone from the phone's queue.
    expect(await outbox.takeBack(entry?.key ?? '')).toBeDefined();
    expect(await outbox.list()).toEqual([]);
  });
});
