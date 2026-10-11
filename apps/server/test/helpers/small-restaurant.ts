import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  BillView,
  InvoicePaymentsView,
  InvoiceView,
  type LoginResponse,
  SubmitOrderResponse,
  TableSessionView,
} from '@rp/contracts';
import { PrismaService } from '../../src/database/prisma.service.js';
import { authHeaders, type AuthKit } from './auth-kit.js';
import { api } from './test-app.js';

/**
 * A small restaurant for the Phase 7 exit scenarios (P7-10): an invoice series, GST 5 %, one
 * kitchen, three dishes and four tables, with the menu published; and a table's visit through the
 * API the POS and the waiter app use.
 */

export const DISHES = { Dal: 18_000, Naan: 4_000, Lassi: 8_000 } as const;
export type Dish = keyof typeof DISHES;

export interface SmallRestaurant {
  readonly items: Readonly<Record<Dish, string>>;
  /** T1 to T4. */
  readonly tables: Readonly<Record<string, string>>;
}

export async function setUpSmallRestaurant(
  app: INestApplication,
  kit: AuthKit,
  manager: LoginResponse,
): Promise<SmallRestaurant> {
  const prisma = app.get(PrismaService);
  const base = { restaurantId: kit.restaurantId };
  await prisma.invoiceSeries.create({
    data: { ...base, name: 'Dine-in', prefix: 'INV', isDefault: true },
  });
  const category = await prisma.category.create({ data: { ...base, name: 'Menu' } });
  const station = await prisma.station.create({
    data: { ...base, name: 'Kitchen', mode: 'SCREEN' },
  });
  const gst = await prisma.taxGroup.create({
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
  const items: Partial<Record<Dish, string>> = {};
  for (const [name, price] of Object.entries(DISHES) as [Dish, number][]) {
    items[name] = (
      await prisma.item.create({
        data: {
          ...base,
          categoryId: category.id,
          name,
          basePrice: price,
          taxGroupId: gst.id,
          foodType: 'VEG',
          stationId: station.id,
        },
      })
    ).id;
  }
  const published = await api(app)
    .post('/api/v1/menu/publish')
    .set(authHeaders(kit.deviceId, manager.accessToken));
  if (published.status !== 200)
    throw new Error(`Publish failed: ${JSON.stringify(published.body)}`);
  const hall = await prisma.section.create({ data: { ...base, name: 'Hall' } });
  const tables: Record<string, string> = {};
  for (const label of ['T1', 'T2', 'T3', 'T4']) {
    tables[label] = (
      await prisma.diningTable.create({ data: { ...base, sectionId: hall.id, label } })
    ).id;
  }
  return { items: items as Record<Dish, string>, tables };
}

/** A response's body, or an error with the status and body when it did not succeed. */
function bodyOf(response: { status: number; body: unknown }, what: string) {
  if (response.status < 200 || response.status > 299) {
    throw new Error(`${what}: ${String(response.status)} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

/** Opens a table and sends an order to the kitchen (the waiter app). */
export async function seatAndOrder(
  app: INestApplication,
  kit: AuthKit,
  waiter: LoginResponse,
  tableId: string,
  lines: readonly (readonly [string, number])[],
): Promise<{ readonly sessionId: string; readonly orderId: string }> {
  const as = authHeaders(kit.deviceId, waiter.accessToken);
  const session = TableSessionView.parse(
    bodyOf(
      await api(app).post(`/api/v1/tables/${tableId}/open`).set(as).send({ covers: 2 }),
      'Open table',
    ),
  );
  const ordered = SubmitOrderResponse.parse(
    bodyOf(
      await api(app)
        .post('/api/v1/orders')
        .set(as)
        .send({
          idempotencyKey: randomUUID(),
          source: 'WAITER_APP',
          orderType: 'DINE_IN',
          tableSessionId: session.id,
          lines: lines.map(([itemId, quantity]) => ({
            clientLineId: randomUUID(),
            itemId,
            quantity,
          })),
        }),
      'Order',
    ),
  );
  if (ordered.status !== 'ACCEPTED') throw new Error(`Order not accepted: ${ordered.status}`);
  return { sessionId: session.id, orderId: ordered.orderId };
}

/** Prints the table's bill and takes its payment by UPI (the POS); the table is then free. */
export async function billAndPay(
  app: INestApplication,
  kit: AuthKit,
  cashier: LoginResponse,
  sessionId: string,
): Promise<InvoiceView> {
  const as = authHeaders(kit.deviceId, cashier.accessToken);
  const bill = BillView.parse(
    bodyOf(
      await api(app).post('/api/v1/bills').set(as).send({ tableSessionId: sessionId }),
      'Bill',
    ),
  );
  const invoice = InvoiceView.parse(
    bodyOf(await api(app).post(`/api/v1/bills/${bill.id}/invoice`).set(as).send({}), 'Invoice'),
  );
  const paid = InvoicePaymentsView.parse(
    bodyOf(
      await api(app)
        .post(`/api/v1/invoices/${invoice.id}/payments`)
        .set(as)
        .send({
          idempotencyKey: randomUUID(),
          payments: [{ mode: 'UPI', amount: invoice.grandTotal, reference: 'UPI-REF' }],
        }),
      'Payment',
    ),
  );
  if (paid.status !== 'SETTLED') throw new Error(`Not settled: ${paid.status}`);
  return invoice;
}

/** A table's whole visit: seated, ordered, billed and paid. */
export async function serveTable(
  app: INestApplication,
  kit: AuthKit,
  staff: { readonly waiter: LoginResponse; readonly cashier: LoginResponse },
  tableId: string,
  lines: readonly (readonly [string, number])[],
): Promise<InvoiceView> {
  const { sessionId } = await seatAndOrder(app, kit, staff.waiter, tableId, lines);
  return billAndPay(app, kit, staff.cashier, sessionId);
}
