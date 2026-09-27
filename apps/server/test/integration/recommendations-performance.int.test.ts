import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { INestApplication } from '@nestjs/common';
import { addDays } from '@rp/domain';
import { type LoginResponse, RecommendationsResponse, TableSessionView } from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/common/ids.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import type { FoodType, SalesChannel } from '../../src/generated/prisma/enums.js';
import { RECOMMENDATION_CLOCK } from '../../src/recommendations/clock.js';
import {
  addDevice,
  authHeaders,
  type AuthKit,
  createAuthKit,
  signIn,
} from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

/**
 * REC-011, NFR-P09: recommendations within 200 ms at the 95th percentile, at the size the BRD
 * designs for: a menu of 1,000 items, 200 rules, and 30 days of a busy restaurant's orders
 * (27,000 order lines) to rank the best sellers from. Measured through HTTP, as a phone asks.
 */

const ITEMS = 1_000;
const RULES = 200;
const DAYS = 30;
const ORDERS_A_DAY = 150;
const LINES_AN_ORDER = 6;
const REQUESTS = 100;
const P95_BUDGET_MS = 200;

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let waiter: LoginResponse;
let tabletId: string;
let session: TableSessionView;
const itemIds: string[] = [];

/** 13:00 in Mumbai: lunch. */
const now = new Date('2030-01-15T07:30:00.000Z');
const TODAY = '2030-01-15';

/** A deterministic sequence, so every run measures the same data. */
function sequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({
    databaseUrl: database.url,
    overrides: [{ provide: RECOMMENDATION_CLOCK, useValue: { now: () => now } }],
  });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  waiter = await signIn(app, kit, 'WAITER');
  const manager = await signIn(app, kit, 'MANAGER');
  const restaurantId = kit.restaurantId;
  const random = sequence(42);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T;

  // 5 courses with 3 sub-categories each, and 5 categories outside the course sequence.
  const categoryIds: string[] = [];
  for (const course of ['Starters', 'Mains', 'Breads', 'Desserts', 'Beverages']) {
    const parent = await prisma.category.create({ data: { restaurantId, name: course } });
    categoryIds.push(parent.id);
    for (let index = 1; index <= 3; index += 1) {
      const child = await prisma.category.create({
        data: { restaurantId, name: `${course} ${String(index)}`, parentId: parent.id },
      });
      categoryIds.push(child.id);
    }
  }
  for (let index = 1; index <= 5; index += 1) {
    const other = await prisma.category.create({
      data: { restaurantId, name: `Specials ${String(index)}` },
    });
    categoryIds.push(other.id);
  }
  const station = await prisma.station.create({
    data: { restaurantId, name: 'Kitchen', mode: 'SCREEN' },
  });
  const tax = await prisma.taxGroup.create({ data: { restaurantId, name: 'GST 5 %' } });
  const foodTypes: FoodType[] = ['VEG', 'VEG', 'NON_VEG', 'EGG'];
  const channelSets: SalesChannel[][] = [
    ['POS', 'WAITER_APP', 'TABLE_TABLET', 'QR'],
    ['POS', 'WAITER_APP', 'TABLE_TABLET', 'QR'],
    ['POS', 'WAITER_APP'],
  ];
  const items = Array.from({ length: ITEMS }, (_, index) => ({
    id: newId(),
    restaurantId,
    categoryId: pick(categoryIds),
    name: `Dish ${String(index + 1).padStart(4, '0')}`,
    basePrice: 10_000 + Math.floor(random() * 40_000),
    taxGroupId: tax.id,
    foodType: pick(foodTypes),
    stationId: station.id,
    channels: pick(channelSets),
    repeatable: random() < 0.1,
    available: random() > 0.05,
  }));
  await prisma.item.createMany({ data: items });
  itemIds.push(...items.map((item) => item.id));
  const published = await request(httpServer(app))
    .post('/api/v1/menu/publish')
    .set(authHeaders(kit.deviceId, manager.accessToken));
  expect(published.status, JSON.stringify(published.body)).toBe(200);

  await prisma.recommendationRule.createMany({
    data: Array.from({ length: RULES }, (_, index) => {
      const byCategory = index % 2 === 0;
      return {
        id: newId(),
        restaurantId,
        whenItemId: byCategory ? null : pick(itemIds),
        whenCategoryId: byCategory ? pick(categoryIds) : null,
        suggestItemId: index % 3 === 0 ? null : pick(itemIds),
        suggestCategoryId: index % 3 === 0 ? pick(categoryIds) : null,
        priority: Math.floor(random() * 100),
        channels: ['POS', 'WAITER_APP', 'TABLE_TABLET'] as SalesChannel[],
        windowStart: index % 5 === 0 ? '18:00' : null,
        windowEnd: index % 5 === 0 ? '23:00' : null,
      };
    }),
  });

  // 30 business days of orders across the day; the popular dishes sell most.
  const popular = itemIds.slice(0, 150);
  let orderNumber = 0;
  for (let day = 0; day < DAYS; day += 1) {
    const businessDate = new Date(addDays(TODAY, -day));
    const orders = [];
    const lines = [];
    for (let index = 0; index < ORDERS_A_DAY; index += 1) {
      orderNumber += 1;
      const at = new Date(businessDate.getTime() + (1.5 + random() * 16) * 3_600_000);
      const orderId = newId();
      orders.push({
        id: orderId,
        restaurantId,
        businessDate,
        orderNumber,
        orderType: 'DINE_IN' as const,
        source: 'WAITER_APP' as const,
        createdAt: at,
      });
      for (let line = 0; line < LINES_AN_ORDER; line += 1) {
        const quantity = 1 + Math.floor(random() * 3);
        lines.push({
          id: newId(),
          restaurantId,
          orderId,
          businessDate,
          itemId: random() < 0.7 ? pick(popular) : pick(itemIds),
          name: 'Dish',
          quantity,
          unitPrice: 20_000,
          lineTotal: 20_000 * quantity,
          taxGroupId: tax.id,
          taxRates: [],
          stationId: station.id,
          state: 'SERVED' as const,
          createdAt: at,
        });
      }
    }
    await prisma.order.createMany({ data: orders });
    await prisma.orderItem.createMany({ data: lines });
  }

  const hall = await prisma.section.create({ data: { restaurantId, name: 'Hall' } });
  const table = await prisma.diningTable.create({
    data: { restaurantId, sectionId: hall.id, label: 'T1' },
  });
  tabletId = await addDevice(app, kit, 'TABLE_TABLET', { tableId: table.id });
  const opened = await request(httpServer(app))
    .post(`/api/v1/tables/${table.id}/open`)
    .set(authHeaders(kit.deviceId, waiter.accessToken))
    .send({ covers: 4, waiterId: kit.staff.WAITER });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  session = TableSessionView.parse(opened.body);
  // A table with a first round sent: the rules have something to match.
  const available = items.filter((item) => item.available && item.channels.includes('WAITER_APP'));
  const sent = await request(httpServer(app))
    .post('/api/v1/orders')
    .set(authHeaders(kit.deviceId, waiter.accessToken))
    .send({
      idempotencyKey: randomUUID(),
      source: 'WAITER_APP',
      orderType: 'DINE_IN',
      tableSessionId: session.id,
      lines: available.slice(0, 4).map((item) => ({
        clientLineId: randomUUID(),
        itemId: item.id,
        quantity: 1,
      })),
    });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
}, 120_000);

afterAll(async () => {
  await app.close();
  await database.drop();
});

/** Times each request and returns the 95th percentile, in milliseconds. */
async function p95(ask: (index: number) => request.Test): Promise<number> {
  const durations: number[] = [];
  for (let index = 0; index < REQUESTS; index += 1) {
    const started = performance.now();
    const response = await ask(index);
    durations.push(performance.now() - started);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(RecommendationsResponse.parse(response.body).recommendations.length).toBeGreaterThan(0);
  }
  durations.sort((a, b) => a - b);
  return durations[Math.ceil(REQUESTS * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

describe('[REC-011] [NFR-P09] recommendations at 1,000 items', () => {
  it('answers a waiter within 200 ms at the 95th percentile', async () => {
    const took = await p95((index) => {
      const cart = itemIds.slice(200 + (index % 50) * 5, 205 + (index % 50) * 5);
      const search = new URLSearchParams({ channel: 'WAITER_APP', tableSessionId: session.id });
      for (const itemId of cart) search.append('cart', itemId);
      return request(httpServer(app))
        .get(`/api/v1/recommendations?${search.toString()}`)
        .set(authHeaders(kit.deviceId, waiter.accessToken));
    });
    expect(took, `p95 ${took.toFixed(1)} ms`).toBeLessThanOrEqual(P95_BUDGET_MS);
  }, 60_000);

  it('answers the table tablet within 200 ms at the 95th percentile', async () => {
    const took = await p95((index) =>
      request(httpServer(app))
        .get(
          `/api/v1/devices/current/recommendations?cart=${itemIds[300 + index] ?? ''}&vegOnly=${String(index % 2 === 0)}`,
        )
        .set(authHeaders(tabletId)),
    );
    expect(took, `p95 ${took.toFixed(1)} ms`).toBeLessThanOrEqual(P95_BUDGET_MS);
  }, 60_000);
});
