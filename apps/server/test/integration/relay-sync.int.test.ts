import type { INestApplication } from '@nestjs/common';
import { type LoginResponse } from '@rp/contracts';
import { QrMenuResponse } from '@rp/contracts/relay';
import { startRelay, type TestRelay } from '@rp/relay/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SECRET_STORE, type SecretStore } from '../../src/auth/secret-store.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { saveRelayCredential } from '../../src/relay/relay-credential.js';
import {
  concernsRelay,
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
 * The QR relay's sync agent, publishing side (P5-03a, QR-003, QR-008): presence with the QR
 * settings, the tables and the QR menu, against a real relay (its schema and functions over HTTP),
 * including an internet cut while the menu changes.
 */

let database: TestDatabase;
let relay: TestRelay;
let app: INestApplication;
let prisma: PrismaService;
let sync: RelaySyncService;
let kit: AuthKit;
let manager: LoginResponse;
let tenantId = '';
let tableToken = '';
let storedCredential = '';
const ids: Record<string, string> = {};

const server = () => request(httpServer(app));
const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);

/** The relay's menu as a diner's browser would get it at table `label`. */
async function relayMenu(): Promise<QrMenuResponse> {
  const response = await fetch(`${relay.baseUrl}/qr-menu`, {
    headers: { 'x-rp-table-token': tableToken },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return QrMenuResponse.parse(await response.json());
}

/** T1's QR code, made as a manager would (P5-04), sent to the relay with the next sync. */
async function giveT1ACode(): Promise<void> {
  if (tableToken === '') {
    expect((await server().post('/api/v1/tables/qr-codes').set(as(manager))).status).toBe(200);
    tableToken =
      (await prisma.diningTable.findUniqueOrThrow({ where: { id: ids.T1 } })).qrToken ?? '';
  }
  await sync.sync();
}

const relayRow = async <T extends object>(sql: string) =>
  (await relay.admin.query<T>(sql, [tenantId])).rows;

beforeAll(async () => {
  database = await createTestDatabase();
  relay = await startRelay({ adminUrl: inject('pgAdminUrl'), runId: inject('pgRunId') });
  const tenant = await relay.provision('Spice Route');
  tenantId = tenant.tenantId;
  app = await createTestApp({
    databaseUrl: database.url,
    config: { relayUrl: relay.baseUrl },
    overrides: [
      {
        provide: RELAY_SYNC_OPTIONS,
        // The test drives each sync itself; events still bring one forward quickly.
        useValue: {
          ...DEFAULT_RELAY_SYNC_OPTIONS,
          firstDelayMs: 3_600_000,
          debounceMs: 20,
          retryBaseMs: 3_600_000,
          retryMaxMs: 3_600_000,
          requestTimeoutMs: 2_000,
        },
      },
    ],
  });
  prisma = app.get(PrismaService);
  sync = app.get(RelaySyncService);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  storedCredential = tenant.credential;
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
  for (const [name, channels] of [
    ['Dal Makhani', undefined],
    ['Staff Meal', ['POS'] as const],
  ] as const) {
    ids[name] = (
      await prisma.item.create({
        data: {
          ...base,
          categoryId: category.id,
          name,
          basePrice: 24_000,
          taxGroupId: taxGroup.id,
          foodType: 'VEG',
          stationId: station.id,
          ...(channels !== undefined && { channels: [...channels] }),
        },
      })
    ).id;
  }
  expect((await server().post('/api/v1/menu/publish').set(as(manager))).status).toBe(200);
  const section = await prisma.section.create({ data: { ...base, name: 'Hall' } });
  for (const label of ['T1', 'T2']) {
    ids[label] = (
      await prisma.diningTable.create({ data: { ...base, sectionId: section.id, label } })
    ).id;
  }
});

afterAll(async () => {
  await app.close();
  await relay.stop();
  await database.drop();
});

describe('[QR-008] [QR-003] keeping the relay in step', () => {
  it('reports presence with the QR settings, and sends the tables and the QR menu', async () => {
    const status = await sync.sync();
    expect(status).toMatchObject({
      configured: true,
      credential: true,
      lastError: null,
      menuVersion: 1,
    });
    const [presence] = await relayRow<{ server_version: string }>(
      'SELECT server_version FROM relay.presence WHERE tenant_id = $1',
    );
    expect(presence?.server_version).toMatch(/\d+\.\d+\.\d+/);
    const settings = await relayRow<{ pickup: number; per_window: number }>(
      'SELECT pickup_timeout_seconds AS pickup, submissions_per_window AS per_window FROM relay.tenant_settings WHERE tenant_id = $1',
    );
    expect(settings).toEqual([{ pickup: 60, per_window: 5 }]);
    const tables = await relayRow<{ table_id: string; label: string; active: boolean }>(
      'SELECT table_id, label, active FROM relay.dining_tables WHERE tenant_id = $1 ORDER BY label',
    );
    expect(tables).toEqual([
      { table_id: ids.T1, label: 'T1', active: true },
      { table_id: ids.T2, label: 'T2', active: true },
    ]);
    const [menu] = await relayRow<{
      version: string;
      menu: { menu: { items: { name: string }[] } };
    }>(
      'SELECT version, menu FROM relay.menu_snapshots WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1',
    );
    expect(menu?.version).toBe('1');
    // MENU-012: only what the QR channel offers.
    expect(menu?.menu.menu.items.map((item) => item.name)).toEqual(['Dal Makhani']);
  });

  it('sends nothing again while nothing changed', async () => {
    const before = relay.requests.length;
    await sync.sync();
    expect(relay.requests.slice(before)).toEqual(['POST /functions/v1/server/presence']);
  });

  it('[MENU-006] follows a dish running out within seconds, as a new version', async () => {
    await giveT1ACode();
    const response = await server()
      .put(`/api/v1/menu/items/${ids['Dal Makhani'] ?? ''}/availability`)
      .set(as(manager))
      .send({ available: false, stockCount: null });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const menu = await until(
      async () => {
        const current = await relayMenu();
        return current.version === 2 ? current : undefined;
      },
      10_000,
      'the relay to serve version 2',
    );
    expect(menu.document.menu.items.find((item) => item.id === ids['Dal Makhani'])?.available).toBe(
      false,
    );
  });

  it('[QR-008] [NFR-A01] catches up after an internet cut, without losing the change', async () => {
    relay.cut();
    await server()
      .put(`/api/v1/menu/items/${ids['Dal Makhani'] ?? ''}/availability`)
      .set(as(manager))
      .send({ available: true, stockCount: null });
    const offline = await sync.sync();
    expect(offline.lastError).toBe('UNREACHABLE');
    expect((await relayMenu().catch(() => undefined)) ?? null).toBeNull();
    relay.restore();
    expect((await relayMenu()).document.menu.items[0]?.available).toBe(false);
    const online = await sync.sync();
    expect(online).toMatchObject({ lastError: null, menuVersion: 3 });
    expect((await relayMenu()).document.menu.items[0]?.available).toBe(true);
    // Exactly one new version: nothing duplicated by the retries.
    const versions = await relayRow<{ version: string }>(
      'SELECT version FROM relay.menu_snapshots WHERE tenant_id = $1 ORDER BY version',
    );
    expect(versions.map((row) => row.version)).toEqual(['1', '2', '3']);
  });

  it('[QR-006] sends the restaurant’s QR settings when they change', async () => {
    const response = await server()
      .put('/api/v1/settings/qr.pickupTimeoutSeconds')
      .set(as(manager))
      .send({ value: 90 });
    // VENDOR settings are changed by the vendor; set it as the Control Plane would.
    if (response.status !== 200) {
      await prisma.setting.upsert({
        where: {
          restaurantId_key: { restaurantId: kit.restaurantId, key: 'qr.pickupTimeoutSeconds' },
        },
        create: { restaurantId: kit.restaurantId, key: 'qr.pickupTimeoutSeconds', value: 90 },
        update: { value: 90 },
      });
      app.get(SettingsService).invalidate();
    }
    await sync.sync();
    expect(
      await relayRow<{ pickup: number }>(
        'SELECT pickup_timeout_seconds AS pickup FROM relay.tenant_settings WHERE tenant_id = $1',
      ),
    ).toEqual([{ pickup: 90 }]);
    expect((await relayMenu()).pickupTimeoutSeconds).toBe(90);
  });

  it('[QR-001] takes a removed table out of service at the relay', async () => {
    await prisma.diningTable.update({ where: { id: ids.T2 }, data: { archivedAt: new Date() } });
    await sync.sync();
    expect(
      await relayRow<{ label: string; active: boolean }>(
        'SELECT label, active FROM relay.dining_tables WHERE tenant_id = $1 ORDER BY label',
      ),
    ).toEqual([
      { label: 'T1', active: true },
      { label: 'T2', active: false },
    ]);
  });

  it('[QR-003] publishes after the relay’s version when this PC forgot its own', async () => {
    await prisma.systemMeta.delete({ where: { key: 'relay.sync' } });
    await prisma.restaurant.update({
      where: { id: kit.restaurantId },
      data: { displayName: 'Spice Route Bistro' },
    });
    const status = await sync.sync();
    expect(status).toMatchObject({ lastError: null, menuVersion: 4 });
    await giveT1ACode();
    expect((await relayMenu()).document.restaurantName).toBe('Spice Route Bistro');
  });

  it('knows which changes the QR page shows', () => {
    expect(concernsRelay({ type: 'MenuPublished', payload: { menuVersion: 2 } } as never)).toBe(
      true,
    );
    expect(
      concernsRelay({
        type: 'SettingsChanged',
        payload: { keys: ['billing.roundingMode'] },
      } as never),
    ).toBe(false);
    expect(concernsRelay({ type: 'RestaurantChanged', payload: { part: 'FLOOR' } } as never)).toBe(
      true,
    );
  });
});

describe('[SEC-002] the relay credential', () => {
  it('is kept sealed in the database, never as it is', async () => {
    const row = await prisma.systemMeta.findUniqueOrThrow({ where: { key: 'relay.credential' } });
    expect(row.value).toMatch(/^v1\./);
    const credentials = await relay.admin.query<{ n: string }>(
      'SELECT count(*) AS n FROM relay.credentials',
    );
    expect(Number(credentials.rows[0]?.n)).toBe(1);
    expect(JSON.stringify(row)).not.toContain(storedCredential);
  });
});

describe('without a credential or an address', () => {
  it('says what is missing and calls nobody', async () => {
    await prisma.systemMeta.delete({ where: { key: 'relay.credential' } });
    const before = relay.requests.length;
    expect(await sync.sync()).toMatchObject({ credential: false, lastError: 'NO_CREDENTIAL' });
    expect(relay.requests.length).toBe(before);
  });
});
