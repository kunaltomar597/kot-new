import { existsSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import type { LoginResponse } from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';
import { seedDesignCapacity } from './design-capacity.js';

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
/**
 * A file path: once the year is generated its database URL is written there, and the run waits
 * until `<path>.stop` exists, so queries can be tuned against the year from another shell.
 */
const HOLD = process.env.RP_PERF_HOLD;

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
  'suspicious',
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
    const started = performance.now();
    const generated = await seedDesignCapacity(app, kit, {
      lastDay: LAST_DAY,
      days: DAYS,
      ordersPerDay: ORDERS_A_DAY,
    });
    firstDay = generated.firstDay;
    if (HOLD !== undefined) {
      writeFileSync(HOLD, `${database.url}\n${kit.restaurantId}\n${firstDay}\n`);
      while (!existsSync(`${HOLD}.stop`)) await sleep(2_000);
    }
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

  it('pages through the year’s invoice register within five seconds a page', async () => {
    const started = performance.now();
    const response = await request(httpServer(app))
      .get('/api/v1/reports/invoice-register')
      .query({ from: firstDay, to: LAST_DAY, offset: 300_000, limit: 1_000 })
      .set(authHeaders(kit.deviceId, manager.accessToken));
    const elapsed = Math.round(performance.now() - started);
    timings['invoice-register page'] = elapsed;
    expect(response.status).toBe(200);
    expect((response.body as { total: number }).total).toBe(DAYS * ORDERS_A_DAY);
    expect(elapsed).toBeLessThanOrEqual(BUDGET_MS);
  }, 120_000);

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
