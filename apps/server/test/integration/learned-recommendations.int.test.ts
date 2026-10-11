import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  LearnedRecommendationsResponse,
  type LoginResponse,
  RecommendationsResponse,
  TableSessionView,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentBusinessDate } from '../../src/common/business-dates.js';
import { newId } from '../../src/common/ids.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import type { OrderItemState } from '../../src/generated/prisma/enums.js';
import { LearnedAssociations } from '../../src/recommendations/learned-associations.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

/**
 * Learned recommendations (P6-02, REC-003): the nightly job learns "frequently ordered together"
 * from the restaurant's own orders, only once there are enough of them, and the engine puts what
 * it learned after the restaurant's rules and before the best sellers (REC-001), with its reason.
 */

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let learned: LearnedAssociations;
let kit: AuthKit;
let waiter: LoginResponse;
let manager: LoginResponse;
let today = '';
let orderNumber = 1_000;
const ids: Record<string, string> = {};
const id = (name: string) => ids[name] ?? '';
const server = () => request(httpServer(app));
const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);

/** `count` orders of `dishes` today, each on its own (takeaway): served, as the kitchen made them. */
async function sold(count: number, dishes: readonly string[], state: OrderItemState = 'SERVED') {
  const businessDate = new Date(`${today}T00:00:00.000Z`);
  const orders = [];
  const lines = [];
  for (let index = 0; index < count; index += 1) {
    orderNumber += 1;
    const orderId = newId();
    orders.push({
      id: orderId,
      restaurantId: kit.restaurantId,
      businessDate,
      orderNumber,
      orderType: 'TAKEAWAY' as const,
      source: 'POS' as const,
    });
    for (const dish of dishes) {
      lines.push({
        id: newId(),
        restaurantId: kit.restaurantId,
        orderId,
        businessDate,
        itemId: id(dish),
        name: dish,
        quantity: 1,
        unitPrice: 20_000,
        lineTotal: 20_000,
        taxGroupId: id('gst'),
        taxRates: [],
        stationId: id('kitchen'),
        state,
      });
    }
  }
  await prisma.order.createMany({ data: orders });
  await prisma.orderItem.createMany({ data: lines });
}

async function suggestionsFor(cart: readonly string[]): Promise<RecommendationsResponse> {
  const search = new URLSearchParams({ channel: 'WAITER_APP', limit: '4' });
  for (const dish of cart) search.append('cart', id(dish));
  const response = await server()
    .get(`/api/v1/recommendations?${search.toString()}`)
    .set(as(waiter));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return RecommendationsResponse.parse(response.body);
}

const names = (response: RecommendationsResponse) =>
  response.recommendations.map((entry) => [
    Object.entries(ids).find(([, value]) => value === entry.itemId)?.[0],
    entry.layer,
  ]);

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  prisma = app.get(PrismaService);
  learned = app.get(LearnedAssociations);
  kit = await createAuthKit(app);
  waiter = await signIn(app, kit, 'WAITER');
  manager = await signIn(app, kit, 'MANAGER');
  today = await currentBusinessDate(prisma, kit.restaurantId);
  const base = { restaurantId: kit.restaurantId };
  ids.kitchen = (await prisma.station.create({ data: { ...base, name: 'Kitchen' } })).id;
  ids.gst = (
    await prisma.taxGroup.create({
      data: {
        ...base,
        name: 'GST 5 %',
        sacCode: '996331',
        components: { create: [{ ...base, code: 'IGST', rateBp: 500 }] },
      },
    })
  ).id;
  const category = await prisma.category.create({ data: { ...base, name: 'Mains' } });
  for (const name of ['Biryani', 'Raita', 'Naan', 'Dal', 'Lassi', 'Kheer']) {
    ids[name] = (
      await prisma.item.create({
        data: {
          ...base,
          categoryId: category.id,
          name,
          basePrice: 20_000,
          taxGroupId: id('gst'),
          foodType: 'VEG',
          stationId: id('kitchen'),
        },
      })
    ).id;
  }
  expect((await server().post('/api/v1/menu/publish').set(as(manager))).status).toBe(200);
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('[REC-003] learning what is ordered together', () => {
  it('learns nothing before there are enough orders, and suggests nothing learned', async () => {
    await sold(120, ['Biryani', 'Raita']);
    await sold(30, ['Biryani']);
    await sold(100, ['Naan', 'Dal']);
    // Never reached the kitchen: not counted.
    await sold(80, ['Biryani', 'Kheer'], 'CANCELLED');
    const status = LearnedRecommendationsResponse.parse(
      (await server().post('/api/v1/recommendations/learned/run').set(as(manager))).body,
    );
    expect(status).toMatchObject({
      lastRun: { orders: 250, baskets: 250, active: false, associations: 0, windowTo: today },
      minOrders: 300,
      associations: [],
    });
    const layers = (await suggestionsFor(['Biryani'])).recommendations.map((entry) => entry.layer);
    expect(layers).not.toContain('LEARNED');
  });

  it('learns once there are, and the waiter app suggests it with its reason', async () => {
    await sold(80, ['Biryani', 'Raita']);
    await sold(30, ['Biryani']);
    await sold(50, ['Lassi']);
    const status = await learned.learn(kit.restaurantId);
    expect(status.lastRun).toMatchObject({ orders: 410, baskets: 410, active: true });
    // Biryani in 260 of 410, Raita in 200, both in 200.
    expect(status.associations).toContainEqual({
      fromItemId: id('Biryani'),
      fromName: 'Biryani',
      toItemId: id('Raita'),
      toName: 'Raita',
      pairCount: 200,
      supportBp: 4_878,
      confidenceBp: 7_692,
      liftPercent: 157,
    });
    // Kheer was only ever cancelled: never learned.
    expect(status.associations.some((entry) => entry.toName === 'Kheer')).toBe(false);
    const [first] = (await suggestionsFor(['Biryani'])).recommendations;
    expect(first).toEqual({
      itemId: id('Raita'),
      layer: 'LEARNED',
      reason: { kind: 'LEARNED', becauseOf: 'Biryani' },
    });
  });

  it('[REC-001] puts the restaurant’s rules first, then what it learned, then best sellers', async () => {
    const rule = await server()
      .post('/api/v1/recommendation-rules')
      .set(as(manager))
      .send({
        when: { kind: 'ITEM', itemId: id('Biryani') },
        suggest: { kind: 'ITEM', itemId: id('Lassi') },
        priority: 10,
        channels: ['WAITER_APP'],
        timeWindow: null,
        activeFrom: null,
        activeUntil: null,
        label: null,
        active: true,
      });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    expect(names(await suggestionsFor(['Biryani'])).slice(0, 2)).toEqual([
      ['Lassi', 'RULE'],
      ['Raita', 'LEARNED'],
    ]);
    // Raita is in the cart already (not repeatable): nothing learned is left to say.
    expect(names(await suggestionsFor(['Biryani', 'Raita']))).not.toContainEqual([
      'Raita',
      'LEARNED',
    ]);
  });

  it('counts a table’s whole visit as one basket, across its rounds', async () => {
    const hall = await prisma.section.create({
      data: { restaurantId: kit.restaurantId, name: 'Hall' },
    });
    const table = await prisma.diningTable.create({
      data: { restaurantId: kit.restaurantId, sectionId: hall.id, label: 'T1' },
    });
    const opened = await server()
      .post(`/api/v1/tables/${table.id}/open`)
      .set(as(waiter))
      .send({ covers: 2 });
    const session = TableSessionView.parse(opened.body);
    for (const dish of ['Naan', 'Kheer']) {
      const sent = await server()
        .post('/api/v1/orders')
        .set(as(waiter))
        .send({
          idempotencyKey: randomUUID(),
          source: 'WAITER_APP',
          orderType: 'DINE_IN',
          tableSessionId: session.id,
          lines: [{ clientLineId: randomUUID(), itemId: id(dish), quantity: 1 }],
        });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    }
    const status = await learned.learn(kit.restaurantId);
    // Two more orders, one more basket.
    expect(status.lastRun).toMatchObject({ orders: 412, baskets: 411 });
  });

  it('runs once a business day by itself, and only for people who configure operations', async () => {
    // Learned today already: nothing is due.
    expect(await learned.learnWhereDue()).toBe(0);
    await prisma.learningRun.updateMany({
      where: { restaurantId: kit.restaurantId },
      data: { windowTo: new Date('2026-01-01T00:00:00.000Z') },
    });
    expect(await learned.learnWhereDue()).toBe(1);
    expect(await learned.learnWhereDue()).toBe(0);
    const runs = await prisma.learningRun.count({ where: { restaurantId: kit.restaurantId } });
    expect(runs).toBe(4);
    expect((await server().get('/api/v1/recommendations/learned').set(as(waiter))).status).toBe(
      403,
    );
    expect(
      (await server().post('/api/v1/recommendations/learned/run').set(as(waiter))).status,
    ).toBe(403);
    const seen = LearnedRecommendationsResponse.parse(
      (await server().get('/api/v1/recommendations/learned').set(as(manager))).body,
    );
    expect(seen.lastRun?.active).toBe(true);
  });
});
