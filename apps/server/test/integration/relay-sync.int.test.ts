import type { INestApplication } from '@nestjs/common';
import { type LoginResponse } from '@rp/contracts';
import { QrMenuResponse } from '@rp/contracts/relay';
import { startRelay, type TestRelay } from '@rp/relay/testing';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SECRET_STORE, type SecretStore } from '../../src/auth/secret-store.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { LearnedAssociations } from '../../src/recommendations/learned-associations.service.js';
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
    expect(
      menu.document?.menu.items.find((item) => item.id === ids['Dal Makhani'])?.available,
    ).toBe(false);
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
    expect((await relayMenu()).document?.menu.items[0]?.available).toBe(false);
    const online = await sync.sync();
    expect(online).toMatchObject({ lastError: null, menuVersion: 3 });
    expect((await relayMenu()).document?.menu.items[0]?.available).toBe(true);
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
    expect((await relayMenu()).document?.restaurantName).toBe('Spice Route Bistro');
  });

  it('[QR-004] sends what the QR page’s suggestions run on, with the QR rules only', async () => {
    const rule = (channels: string[], label: string) =>
      server()
        .post('/api/v1/recommendation-rules')
        .set(as(manager))
        .send({
          when: { kind: 'ITEM', itemId: ids['Dal Makhani'] },
          suggest: { kind: 'ITEM', itemId: ids['Dal Makhani'] },
          priority: 10,
          channels,
          timeWindow: null,
          activeFrom: null,
          activeUntil: null,
          label,
          active: true,
        });
    expect((await rule(['QR', 'TABLE_TABLET'], 'Also online')).status).toBe(201);
    expect((await rule(['POS'], 'Counter only')).status).toBe(201);
    await sync.sync();
    await giveT1ACode();
    const snapshot = (await relayMenu()).document?.recommendations;
    expect(snapshot?.rules.map((entry) => entry.label)).toEqual(['Also online']);
    expect(Object.keys(snapshot?.bestSellers ?? {}).sort()).toEqual([
      'ALL_DAY',
      'BREAKFAST',
      'DINNER',
      'EVENING',
      'LUNCH',
    ]);
    expect(snapshot?.businessDayCutoff).toBe('04:00');
  });

  it('[QR-004] sends the pairings learned from the restaurant’s orders (P6-02)', async () => {
    await prisma.learnedAssociation.create({
      data: {
        restaurantId: kit.restaurantId,
        fromItemId: ids['Dal Makhani'] ?? '',
        toItemId: ids['Staff Meal'] ?? '',
        pairCount: 40,
        supportBp: 900,
        confidenceBp: 6_000,
        liftPercent: 180,
        score: 10_800,
      },
    });
    app.get(LearnedAssociations).invalidate();
    await sync.sync();
    await giveT1ACode();
    expect((await relayMenu()).document?.recommendations?.learned).toEqual([
      { fromItemId: ids['Dal Makhani'], toItemId: ids['Staff Meal'], score: 10_800 },
    ]);
  });

  it('knows which changes the QR page shows', () => {
    expect(
      concernsRelay({ type: 'SettingsChanged', payload: { keys: ['reco.dayparts'] } } as never),
    ).toBe(true);
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

describe('[MENU-008] [QR-012] the dishes’ photos', () => {
  const photo = async (width: number, height: number): Promise<string> => {
    const content = await sharp({ create: { width, height, channels: 3, background: '#c86428' } })
      .jpeg()
      .toBuffer();
    const response = await server()
      .post('/api/v1/photos')
      .set(as(manager))
      .send({ contentBase64: content.toString('base64') });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { id: string }).id;
  };
  const show = async (item: string, photoId: string) => {
    await prisma.item.update({ where: { id: ids[item] }, data: { photoId } });
    expect((await server().post('/api/v1/menu/publish').set(as(manager))).status).toBe(200);
    await sync.sync();
  };
  const files = (photoId: string) =>
    [...relay.photoFiles.keys()].filter((path) => path.includes(photoId)).sort();
  const photoRows = () =>
    relayRow<{ photo_id: string; removed: boolean; purged: boolean }>(
      `SELECT photo_id, removed_at IS NOT NULL AS removed, purged_at IS NOT NULL AS purged
       FROM relay.photos WHERE tenant_id = $1 ORDER BY photo_id`,
    );
  let wide = '';
  let narrow = '';

  it('sends each QR dish’s photo sizes once, and lists only what the relay has', async () => {
    wide = await photo(1200, 900);
    narrow = await photo(300, 200);
    await prisma.item.update({ where: { id: ids['Staff Meal'] }, data: { photoId: narrow } });
    await show('Dal Makhani', wide);
    const menu = await relayMenu();
    const path = (width: number) => `${tenantId}/${wide}/${String(width)}.webp`;
    expect(menu.document?.photos).toEqual([
      {
        photoId: wide,
        sizes: [
          { width: 160, height: 120, path: path(160) },
          { width: 480, height: 360, path: path(480) },
          { width: 960, height: 720, path: path(960) },
        ],
      },
    ]);
    // The QR page loads it from the relay's public bucket, as this PC made it.
    expect(menu.photoBase).not.toBeNull();
    const served = await fetch(`${menu.photoBase ?? ''}/${path(960)}`);
    expect(served.status).toBe(200);
    const metadata = await sharp(Buffer.from(await served.arrayBuffer())).metadata();
    expect(metadata).toMatchObject({ format: 'webp', width: 960, height: 720 });
    // MENU-012: a POS-only dish's photo never leaves this PC.
    expect(files(narrow)).toEqual([]);

    const before = relay.requests.length;
    await sync.sync();
    expect(relay.requests.slice(before)).toEqual(['POST /functions/v1/server/presence']);
  });

  it('lists each real width once for a photo narrower than the largest size', async () => {
    await show('Dal Makhani', narrow);
    const photos = (await relayMenu()).document?.photos;
    expect(photos).toEqual([
      {
        photoId: narrow,
        sizes: [
          { width: 160, height: 107, path: `${tenantId}/${narrow}/160.webp` },
          { width: 300, height: 200, path: `${tenantId}/${narrow}/480.webp` },
        ],
      },
    ]);
    // The photo no longer shown is marked at the relay; its files stay for now.
    expect(await photoRows()).toEqual(
      [
        { photo_id: wide, removed: true, purged: false },
        { photo_id: narrow, removed: false, purged: false },
      ].sort((a, b) => (a.photo_id < b.photo_id ? -1 : 1)),
    );
    expect(files(wide)).toHaveLength(3);
  });

  it('[BRD §9.3] sends a photo again once the relay has swept it', async () => {
    // 91 days later, the daily sweep removes the unused photo's files.
    await relay.admin.query(
      `UPDATE relay.photos SET removed_at = now() - interval '91 days'
       WHERE tenant_id = $1 AND photo_id = $2`,
      [tenantId, wide],
    );
    const state = await prisma.systemMeta.findUniqueOrThrow({ where: { key: 'relay.photos' } });
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await prisma.systemMeta.update({
      where: { key: 'relay.photos' },
      data: { value: JSON.stringify({ ...JSON.parse(state.value), sweptAt: yesterday }) },
    });
    await sync.sync();
    expect(files(wide)).toEqual([]);

    // The dish takes it back: the relay says it lacks it, and this PC sends it again.
    await show('Dal Makhani', wide);
    expect(files(wide)).toHaveLength(3);
    expect((await relayMenu()).document?.photos.map((entry) => entry.photoId)).toEqual([wide]);
    expect((await photoRows()).find((row) => row.photo_id === wide)).toMatchObject({
      removed: false,
      purged: false,
    });
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
