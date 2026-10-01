import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  type LoginResponse,
  TableQrCodesResponse,
  TableQrView,
  TableTentsResponse,
} from '@rp/contracts';
import { startRelay, type TestRelay } from '@rp/relay/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service.js';
import type { Principal } from '../../src/auth/principal.js';
import { SECRET_STORE, type SecretStore } from '../../src/auth/secret-store.js';
import { APP_CONFIG, type AppConfig } from '../../src/config/app-config.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { TableQrService } from '../../src/floor/table-qr.service.js';
import { saveRelayCredential } from '../../src/relay/relay-credential.js';
import {
  DEFAULT_RELAY_SYNC_OPTIONS,
  RELAY_SYNC_OPTIONS,
  RelaySyncService,
} from '../../src/relay/relay-sync.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

/**
 * Table QR codes and their tents (P5-04, QR-001, ONB-004 step 10): each table's code, only its
 * hash at the relay, a new code stopping the old one there, and the tents as a PDF.
 */

const SITE = 'https://menu.example.in';
let database: TestDatabase;
let relay: TestRelay;
let app: INestApplication;
let prisma: PrismaService;
let sync: RelaySyncService;
let kit: AuthKit;
let manager: LoginResponse;
let waiter: LoginResponse;
const ids: Record<string, string> = {};

const server = () => request(httpServer(app));
const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const tokenOf = (url: string | null) => url?.slice(`${SITE}/t/`.length) ?? '';

/** What a diner's phone gets from the relay for a code: 200, or 404 for a code it does not know. */
async function relayOpens(token: string): Promise<number> {
  const response = await fetch(`${relay.baseUrl}/qr-menu`, {
    headers: { 'x-rp-table-token': token },
  });
  return response.status;
}

beforeAll(async () => {
  database = await createTestDatabase();
  relay = await startRelay({ adminUrl: inject('pgAdminUrl'), runId: inject('pgRunId') });
  const tenant = await relay.provision('Spice Route');
  app = await createTestApp({
    databaseUrl: database.url,
    config: { relayUrl: relay.baseUrl, qrSiteUrl: SITE },
    overrides: [
      {
        provide: RELAY_SYNC_OPTIONS,
        useValue: { ...DEFAULT_RELAY_SYNC_OPTIONS, firstDelayMs: 3_600_000, debounceMs: 3_600_000 },
      },
    ],
  });
  prisma = app.get(PrismaService);
  sync = app.get(RelaySyncService);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  waiter = await signIn(app, kit, 'WAITER');
  await saveRelayCredential(prisma, app.get<SecretStore>(SECRET_STORE), tenant.credential);
  const base = { restaurantId: kit.restaurantId };
  await prisma.restaurant.update({
    where: { id: kit.restaurantId },
    data: { accentColor: '#B4232A' },
  });
  const station = await prisma.station.create({ data: { ...base, name: 'Kitchen' } });
  const taxGroup = await prisma.taxGroup.create({
    data: {
      ...base,
      name: 'GST 5 %',
      sacCode: '996331',
      components: { create: [{ ...base, code: 'CGST', rateBp: 500 }] },
    },
  });
  const category = await prisma.category.create({ data: { ...base, name: 'Mains' } });
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
  });
  expect((await server().post('/api/v1/menu/publish').set(as(manager))).status).toBe(200);
  const hall = await prisma.section.create({ data: { ...base, name: 'Hall', displayOrder: 1 } });
  const patio = await prisma.section.create({ data: { ...base, name: 'Patio', displayOrder: 2 } });
  for (const [label, section] of [
    ['T1', hall],
    ['T2', hall],
    ['P1', patio],
  ] as const) {
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

describe('[QR-001] table QR codes', () => {
  it('lists every table, in floor order, without a code at first', async () => {
    const response = await server().get('/api/v1/tables/qr-codes').set(as(manager));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const codes = TableQrCodesResponse.parse(response.body);
    expect(codes.siteUrl).toBe(SITE);
    expect(
      codes.tables.map((table) => [table.label, table.sectionName, table.hasCode, table.url]),
    ).toEqual([
      ['T1', 'Hall', false, null],
      ['T2', 'Hall', false, null],
      ['P1', 'Patio', false, null],
    ]);
  });

  it('gives each table an unguessable code of its own, audited without it', async () => {
    const response = await server().post('/api/v1/tables/qr-codes').set(as(manager));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const codes = TableQrCodesResponse.parse(response.body);
    const tokens = codes.tables.map((table) => tokenOf(table.url));
    expect(new Set(tokens).size).toBe(3);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'TABLE_QR_CODES_ISSUED' },
    });
    expect(JSON.stringify([audit.before, audit.after])).not.toContain(tokens[0]);
    // Again: tables with a code keep it.
    const again = TableQrCodesResponse.parse(
      (await server().post('/api/v1/tables/qr-codes').set(as(manager))).body,
    );
    expect(again.tables.map((table) => tokenOf(table.url))).toEqual(tokens);
  });

  it('sends only each code’s hash to the relay, which then opens the table', async () => {
    const codes = TableQrCodesResponse.parse(
      (await server().get('/api/v1/tables/qr-codes').set(as(manager))).body,
    );
    expect((await sync.sync()).lastError).toBeNull();
    const token = tokenOf(codes.tables[0]?.url ?? null);
    const stored = await relay.admin.query<{ hash: string }>(
      "SELECT encode(token_hash, 'hex') AS hash FROM relay.dining_tables WHERE table_id = $1",
      [ids.T1],
    );
    expect(stored.rows[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored.rows)).not.toContain(token);
    expect(await relayOpens(token)).toBe(200);
  });

  it('stops the printed code when the table gets a new one (acceptance)', async () => {
    const before = TableQrCodesResponse.parse(
      (await server().get('/api/v1/tables/qr-codes').set(as(manager))).body,
    );
    const old = tokenOf(before.tables[0]?.url ?? null);
    const response = await server()
      .post(`/api/v1/tables/${ids.T1 ?? ''}/qr-code`)
      .set(as(manager))
      .send({ reason: 'A guest photographed the code' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const fresh = tokenOf(TableQrView.parse(response.body).url);
    expect(fresh).not.toBe(old);
    await sync.sync();
    expect(await relayOpens(old)).toBe(404);
    expect(await relayOpens(fresh)).toBe(200);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'TABLE_QR_CODE_REGENERATED' },
    });
    expect(audit.reason).toBe('A guest photographed the code');
    expect(JSON.stringify([audit.before, audit.after])).not.toContain(fresh);
  });

  it('is for managers and the Owner only', async () => {
    expect((await server().get('/api/v1/tables/qr-codes').set(as(waiter))).status).toBe(403);
    expect(
      (
        await server()
          .post(`/api/v1/tables/${ids.T2 ?? ''}/qr-code`)
          .set(as(waiter))
          .send({ reason: 'Because' })
      ).status,
    ).toBe(403);
  });
});

describe('[ONB-004] table tents', () => {
  const pdfOf = (body: unknown) =>
    Buffer.from(TableTentsResponse.parse(body).content, 'base64').toString('latin1');
  const pages = (pdf: string) => (pdf.match(/\/Type \/Page\b/g) ?? []).length;

  it('prints an A6 card per table, sized A6', async () => {
    const response = await server()
      .post('/api/v1/tables/qr-codes/tents')
      .set(as(manager))
      .send({ size: 'A6' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const file = TableTentsResponse.parse(response.body);
    expect(file).toMatchObject({ contentType: 'application/pdf', pages: 3 });
    expect(file.filename).toMatch(/^table-tents_A6_\d{4}-\d{2}-\d{2}\.pdf$/);
    const pdf = pdfOf(response.body);
    expect(pdf.startsWith('%PDF-')).toBe(true);
    expect(pages(pdf)).toBe(3);
    expect(pdf).toMatch(/\/MediaBox \[0 0 297\.6\d* 419\.5\d*\]/);
  });

  it('prints chosen tables as A5 tents that fold in the middle', async () => {
    const response = await server()
      .post('/api/v1/tables/qr-codes/tents')
      .set(as(manager))
      .send({ size: 'A5', tableIds: [ids.P1, ids.T2] });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const pdf = pdfOf(response.body);
    expect(pages(pdf)).toBe(2);
    expect(pdf).toMatch(/\/MediaBox \[0 0 595\.2\d* 419\.5\d*\]/);
  });

  it('says what is missing when nothing can be printed', async () => {
    const config = app.get<AppConfig>(APP_CONFIG);
    const withoutSite = new TableQrService(prisma, app.get(AuditService), {
      ...config,
      qrSiteUrl: undefined,
    });
    const principal = {
      restaurantId: kit.restaurantId,
      staffId: kit.staff.MANAGER,
      deviceId: kit.deviceId,
    } as Principal;
    await expect(withoutSite.tents(principal, { size: 'A6' })).rejects.toMatchObject({
      code: 'QR_SITE_NOT_SET',
    });
    const none = await server()
      .post('/api/v1/tables/qr-codes/tents')
      .set(as(manager))
      .send({ size: 'A6', tableIds: [randomUUID()] });
    expect(none.status).toBe(409);
    expect(ApiError.parse(none.body).code).toBe('NO_QR_CODES');
  });
});
