import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { type LoginResponse, SystemStatusResponse } from '@rp/contracts';
import { QrServiceRequestResponse, QrSubmitOrderResponse } from '@rp/contracts/relay';
import { startRelay, type TestRelay } from '@rp/relay/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SECRET_STORE, type SecretStore } from '../../src/auth/secret-store.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { saveRelayCredential } from '../../src/relay/relay-credential.js';
import {
  DEFAULT_RELAY_ORDERS_OPTIONS,
  RELAY_ORDERS_OPTIONS,
  RelayOrdersService,
} from '../../src/relay/relay-orders.service.js';
import { realtimeUrlOf } from '../../src/relay/relay-realtime.js';
import {
  DEFAULT_RELAY_SYNC_OPTIONS,
  RELAY_SYNC_OPTIONS,
  RelaySyncService,
} from '../../src/relay/relay-sync.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';
import { until } from '../helpers/wait.js';

/**
 * The Realtime doorbell (P5-03d, QR-009): new QR orders and requests reach the restaurant within
 * a second although polling is set to an hour here, and a dropped line falls back to polling and
 * joins again. Against the test relay's stand-in for Supabase Realtime (its Phoenix socket, the
 * token check and the restaurant's own rows only).
 */

const JWT_SECRET = 'test-only-realtime-secret-0123456789abcdef';
/** The relay's sessions last an hour; renewing 1.5 s after each makes the test see it. */
const SESSION_MS = 3_600_000;

let database: TestDatabase;
let relay: TestRelay;
let app: INestApplication;
let prisma: PrismaService;
let qr: RelayOrdersService;
let kit: AuthKit;
let manager: LoginResponse;
let token = '';
let itemId = '';

const server = () => request(httpServer(app));
const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const diner = { 'content-type': 'application/json', 'x-rp-browser': 'browser-T1-0000000000' };

async function dinerOrders(): Promise<string> {
  const response = await fetch(`${relay.baseUrl}/submit-order`, {
    method: 'POST',
    headers: { ...diner, 'x-rp-table-token': token },
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      lines: [{ clientLineId: randomUUID(), itemId, quantity: 1, modifiers: [] }],
    }),
  });
  const answer = QrSubmitOrderResponse.parse(await response.json());
  if (answer.status !== 'ACCEPTED') throw new Error(JSON.stringify(answer));
  return answer.order.id;
}

/** Arrives here within the time a person would call instant; polling is an hour away. */
const arrives = (relayOrderId: string) =>
  until(
    async () => (await prisma.relayOrder.findUnique({ where: { relayOrderId } })) ?? undefined,
    3_000,
    'the order to ring the doorbell',
  );

const subscribed = (state: boolean) =>
  until(
    () => qr.realtimeSubscribed === state && relay.realtime?.subscribers === (state ? 1 : 0),
    5_000,
    `the doorbell to be ${state ? 'on' : 'off'}`,
  );

async function systemSaysRealtime(): Promise<boolean> {
  const response = await server().get('/api/v1/system').set(as(manager));
  expect(response.status).toBe(200);
  return SystemStatusResponse.parse(response.body).qrRelay.realtime;
}

beforeAll(async () => {
  database = await createTestDatabase();
  relay = await startRelay({
    adminUrl: inject('pgAdminUrl'),
    runId: inject('pgRunId'),
    realtimeJwtSecret: JWT_SECRET,
  });
  const tenant = await relay.provision('Spice Route');
  const later = { firstDelayMs: 3_600_000, retryBaseMs: 50, retryMaxMs: 400 };
  app = await createTestApp({
    databaseUrl: database.url,
    config: { relayUrl: relay.baseUrl },
    overrides: [
      {
        provide: RELAY_SYNC_OPTIONS,
        useValue: { ...DEFAULT_RELAY_SYNC_OPTIONS, ...later, debounceMs: 3_600_000 },
      },
      {
        provide: RELAY_ORDERS_OPTIONS,
        useValue: {
          ...DEFAULT_RELAY_ORDERS_OPTIONS,
          ...later,
          // Polling would take an hour: only the doorbell can be this quick.
          pollMs: 3_600_000,
          pollWithRealtimeMs: 3_600_000,
          pushDebounceMs: 3_600_000,
          realtimeDelayMs: 3_600_000,
          ringDelayMs: 20,
          heartbeatMs: 200,
          refreshBeforeMs: SESSION_MS - 1_500,
        },
      },
    ],
  });
  prisma = app.get(PrismaService);
  qr = app.get(RelayOrdersService);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  await saveRelayCredential(prisma, app.get<SecretStore>(SECRET_STORE), tenant.credential);

  const base = { restaurantId: kit.restaurantId };
  const station = await prisma.station.create({ data: { ...base, name: 'Kitchen' } });
  const taxGroup = await prisma.taxGroup.create({
    data: {
      ...base,
      name: 'GST 5 %',
      sacCode: '996331',
      components: { create: [{ ...base, code: 'IGST', rateBp: 500 }] },
    },
  });
  const category = await prisma.category.create({ data: { ...base, name: 'Mains' } });
  itemId = (
    await prisma.item.create({
      data: {
        ...base,
        categoryId: category.id,
        name: 'Dal Makhani',
        basePrice: 24_000,
        taxGroupId: taxGroup.id,
        foodType: 'VEG',
        stationId: station.id,
      },
    })
  ).id;
  expect((await server().post('/api/v1/menu/publish').set(as(manager))).status).toBe(200);
  const hall = await prisma.section.create({ data: { ...base, name: 'Hall' } });
  const table = await prisma.diningTable.create({
    data: { ...base, sectionId: hall.id, label: 'T1' },
  });
  expect((await server().post('/api/v1/tables/qr-codes').set(as(manager))).status).toBe(200);
  token = (await prisma.diningTable.findUniqueOrThrow({ where: { id: table.id } })).qrToken ?? '';
  expect((await app.get(RelaySyncService).sync()).lastError).toBeNull();
});

afterAll(async () => {
  await app.close();
  await relay.stop();
  await database.drop();
});

describe('[QR-009] the Realtime doorbell', () => {
  it('finds Realtime on the relay’s host', () => {
    expect(realtimeUrlOf('https://abc.supabase.co/functions/v1', 'pk')).toBe(
      'wss://abc.supabase.co/realtime/v1/websocket?apikey=pk&vsn=1.0.0',
    );
  });

  it('is polled until the doorbell works, and the System page says so', async () => {
    expect(qr.realtimeSubscribed).toBe(false);
    expect(await systemSaysRealtime()).toBe(false);
  });

  it('brings a new order here within a second, and picks up what came before the join', async () => {
    const before = await dinerOrders();
    // The doorbell starts (on a PC, 12 s after start-up).
    qr.startRealtimeNow();
    await subscribed(true);
    expect(await systemSaysRealtime()).toBe(true);
    await arrives(before);
    const relayOrderId = await dinerOrders();
    const local = await arrives(relayOrderId);
    expect(local.relayOrderId).toBe(relayOrderId);
    await until(
      async () =>
        (await prisma.order.count({ where: { source: 'QR', externalRef: relayOrderId } })) === 1,
      3_000,
      'the QR order to be made',
    );
  });

  it('[QR-011] rings for a diner’s call too', async () => {
    const response = await fetch(`${relay.baseUrl}/service-request`, {
      method: 'POST',
      headers: { ...diner, 'x-rp-table-token': token },
      body: JSON.stringify({ type: 'WAITER', idempotencyKey: randomUUID() }),
    });
    const { request: asked } = QrServiceRequestResponse.parse(await response.json());
    await until(
      async () =>
        (await prisma.relayServiceRequest.findUnique({ where: { relayRequestId: asked.id } })) ??
        undefined,
      3_000,
      'the request to ring the doorbell',
    );
  });

  it('renews its token before it runs out and keeps ringing', async () => {
    const sessions = () =>
      relay.requests.filter((entry) => entry === 'POST /functions/v1/server/session').length;
    const first = sessions();
    await until(() => sessions() >= first + 1, 5_000, 'a renewed token');
    expect(qr.realtimeSubscribed).toBe(true);
    await arrives(await dinerOrders());
  });

  it('[NFR-A01] falls back to polling when the line drops, and joins again', async () => {
    relay.cut();
    await subscribed(false);
    expect(await systemSaysRealtime()).toBe(false);
    relay.restore();
    await subscribed(true);
    await arrives(await dinerOrders());
  });
});
