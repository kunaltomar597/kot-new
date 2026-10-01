import { performance } from 'node:perf_hooks';
import type { INestApplication } from '@nestjs/common';
import type { LoginResponse } from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';
import { generateYear } from './generate-year.js';

/**
 * RPT-018: any report over twelve months at design capacity (§7.2) in five seconds or less,
 * measured through HTTP as the dashboard asks. Opt-in, because the year takes minutes to
 * generate: `RP_PERF=1 pnpm --filter @rp/server test:perf` (RP_PERF_DAYS and RP_PERF_ORDERS make
 * a smaller run for trying things out).
 */

const ENABLED = process.env.RP_PERF === '1';
const DAYS = Number(process.env.RP_PERF_DAYS ?? 365);
const ORDERS_A_DAY = Number(process.env.RP_PERF_ORDERS ?? 2_000);
const BUDGET_MS = 5_000;
const LAST_DAY = '2027-03-31';

const REPORTS = [
  'sales',
  'items',
  'payments',
  'shifts',
  'gst',
  'invoice-register',
  'sources',
  'staff',
  'discounts',
  'cancellations',
  'reprints',
  'kitchen',
  'tables',
  'recommendations',
] as const;

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let manager: LoginResponse;
let firstDay: string;
const timings: Record<string, number> = {};

describe.skipIf(!ENABLED)('[RPT-018] twelve months at design capacity', () => {
  beforeAll(async () => {
    database = await createTestDatabase();
    app = await createTestApp({ databaseUrl: database.url });
    prisma = app.get(PrismaService);
    kit = await createAuthKit(app);
    manager = await signIn(app, kit, 'MANAGER');
    const base = { restaurantId: kit.restaurantId };
    const station = await prisma.station.create({
      data: { ...base, name: 'Kitchen', mode: 'SCREEN' },
    });
    const tax = await prisma.taxGroup.create({
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
    const categories = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        prisma.category.create({ data: { ...base, name: `Category ${String(index)}` } }),
      ),
    );
    await prisma.item.createMany({
      data: Array.from({ length: 1_000 }, (_, index) => ({
        ...base,
        categoryId: categories[index % categories.length]?.id ?? '',
        name: `Dish ${String(index)}`,
        basePrice: 10_000 + (index % 30) * 1_000,
        taxGroupId: tax.id,
        foodType: 'VEG' as const,
        stationId: station.id,
      })),
    });
    const section = await prisma.section.create({ data: { ...base, name: 'Hall' } });
    await prisma.diningTable.createMany({
      data: Array.from({ length: 100 }, (_, index) => ({
        ...base,
        sectionId: section.id,
        label: `T${String(index + 1)}`,
      })),
    });
    const series = await prisma.invoiceSeries.create({
      data: { ...base, name: 'Main', prefix: 'INV', isDefault: true },
    });
    const started = performance.now();
    const generated = await generateYear(
      prisma,
      {
        restaurantId: kit.restaurantId,
        deviceId: kit.deviceId,
        waiterId: kit.staff.WAITER,
        cashierId: kit.staff.CASHIER,
        managerId: kit.staff.MANAGER,
        taxGroupId: tax.id,
        stationId: station.id,
        seriesId: series.id,
      },
      { lastDay: LAST_DAY, days: DAYS, ordersPerDay: ORDERS_A_DAY },
    );
    firstDay = generated.firstDay;
    // eslint-disable-next-line no-console -- the run's size goes in the performance record
    console.log(
      `Generated ${String(DAYS)} days in ${String(Math.round((performance.now() - started) / 1_000))} s:`,
      generated.rows,
    );
  }, 3_600_000);

  afterAll(async () => {
    // eslint-disable-next-line no-console -- the timings go in the performance record
    console.log('Report timings (ms):', timings);
    await app.close();
    await database.drop();
  });

  it.each(REPORTS)(
    'generates the %s report for the year within five seconds',
    async (report) => {
      const started = performance.now();
      const response = await request(httpServer(app))
        .get(`/api/v1/reports/${report}`)
        .query({ from: firstDay, to: LAST_DAY })
        .set(authHeaders(kit.deviceId, manager.accessToken));
      const elapsed = Math.round(performance.now() - started);
      timings[report] = elapsed;
      expect(response.status, JSON.stringify(response.body).slice(0, 500)).toBe(200);
      expect(elapsed).toBeLessThanOrEqual(BUDGET_MS);
    },
    120_000,
  );

  it('exports the year’s sales as CSV within five seconds', async () => {
    const started = performance.now();
    const response = await request(httpServer(app))
      .post('/api/v1/reports/exports')
      .set(authHeaders(kit.deviceId, manager.accessToken))
      .send({ report: 'SALES', from: firstDay, to: LAST_DAY });
    const elapsed = Math.round(performance.now() - started);
    timings['export:SALES'] = elapsed;
    expect(response.status).toBe(200);
    expect(elapsed).toBeLessThanOrEqual(BUDGET_MS);
  }, 120_000);

  it('opens one order’s drill-down at once', async () => {
    const order = await prisma.order.findFirstOrThrow({
      where: { restaurantId: kit.restaurantId, businessDate: new Date(LAST_DAY) },
    });
    const started = performance.now();
    const response = await request(httpServer(app))
      .get(`/api/v1/reports/orders/${order.id}`)
      .set(authHeaders(kit.deviceId, manager.accessToken));
    timings['order drill-down'] = Math.round(performance.now() - started);
    expect(response.status).toBe(200);
    expect(timings['order drill-down']).toBeLessThanOrEqual(BUDGET_MS);
  }, 120_000);
});
