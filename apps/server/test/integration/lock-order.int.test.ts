import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { BillView, InvoiceView, type LoginResponse } from '@rp/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import {
  seatAndOrder,
  type SmallRestaurant,
  setUpSmallRestaurant,
} from '../helpers/small-restaurant.js';
import { api, createTestApp } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

/**
 * Two people acting on one table at the same moment (found by the load run, P8-01a): the cashier
 * takes the payment while a waiter sends another round. Each change locks the table and the
 * audit chain; taken in opposite orders, PostgreSQL broke the deadlock by failing one of them
 * with a 500.
 */

let database: TestDatabase;
let app: INestApplication;
let kit: AuthKit;
let restaurant: SmallRestaurant;
let waiter: LoginResponse;
let cashier: LoginResponse;
const tables: string[] = [];
const VISITS = 12;

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  kit = await createAuthKit(app);
  const manager = await signIn(app, kit, 'MANAGER');
  restaurant = await setUpSmallRestaurant(app, kit, manager);
  waiter = await signIn(app, kit, 'WAITER');
  cashier = await signIn(app, kit, 'CASHIER');
  const prisma = app.get(PrismaService);
  const section = await prisma.section.findFirstOrThrow({
    where: { restaurantId: kit.restaurantId },
  });
  for (let index = 0; index < VISITS; index += 1) {
    const table = await prisma.diningTable.create({
      data: { restaurantId: kit.restaurantId, sectionId: section.id, label: `L${String(index)}` },
    });
    tables.push(table.id);
  }
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('[NFR-A03] [NFR-A02] a payment and an order at the same table at once', () => {
  it('never fails either of them with a server error', async () => {
    const statuses = new Map<string, number>();
    const tally = (what: string, status: number) => {
      statuses.set(
        `${what} ${String(status)}`,
        (statuses.get(`${what} ${String(status)}`) ?? 0) + 1,
      );
    };
    for (let visit = 0; visit < VISITS; visit += 1) {
      // A table of its own each time: one the order reached first stays open.
      const tableId = tables[visit] ?? '';
      const { sessionId } = await seatAndOrder(app, kit, waiter, tableId, [
        [restaurant.items.Dal, 1],
      ]);
      const asCashier = authHeaders(kit.deviceId, cashier.accessToken);
      const bill = BillView.parse(
        (await api(app).post('/api/v1/bills').set(asCashier).send({ tableSessionId: sessionId }))
          .body,
      );
      const invoice = InvoiceView.parse(
        (await api(app).post(`/api/v1/bills/${bill.id}/invoice`).set(asCashier).send({})).body,
      );
      await api(app).post(`/api/v1/invoices/${invoice.id}/print`).set(asCashier).send({});
      const [paid, ordered] = await Promise.all([
        api(app)
          .post(`/api/v1/invoices/${invoice.id}/payments`)
          .set(asCashier)
          .send({
            idempotencyKey: randomUUID(),
            payments: [{ mode: 'UPI', amount: invoice.grandTotal, reference: 'UPI-REF' }],
          }),
        api(app)
          .post('/api/v1/orders')
          .set(authHeaders(kit.deviceId, waiter.accessToken))
          .send({
            idempotencyKey: randomUUID(),
            source: 'WAITER_APP',
            orderType: 'DINE_IN',
            tableSessionId: sessionId,
            lines: [{ clientLineId: randomUUID(), itemId: restaurant.items.Lassi, quantity: 1 }],
          }),
      ]);
      tally('payment', paid.status);
      tally('order', ordered.status);
    }
    // Either may go first (the order is then refused as the table closed); neither fails.
    expect([...statuses.keys()].filter((key) => / 5\d\d$/.test(key))).toEqual([]);
    process.stderr.write(`${JSON.stringify(Object.fromEntries(statuses))}\n`);
  }, 60_000);
});
