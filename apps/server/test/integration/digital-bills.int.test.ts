import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ApiError, DigitalBillEntry, InvoiceDigitalBillsResponse } from '@rp/contracts';
import {
  AdminService,
  CONTROL_PLANE_MIGRATIONS_DIR,
  CpConfigSchema,
  createControlPlaneApp,
} from '@rp/control-plane/testing';
import { createMigratedDatabase, type TestDatabase } from '@rp/test-postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SECRET_STORE, type SecretStore } from '../../src/auth/secret-store.js';
import { enrolInstallation } from '../../src/cloud/enrolment.js';
import {
  CONTROL_PLANE_OPTIONS,
  DEFAULT_CONTROL_PLANE_OPTIONS,
} from '../../src/cloud/heartbeat.service.js';
import { newId } from '../../src/common/ids.js';
import { APP_CONFIG, type AppConfig } from '../../src/config/app-config.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import {
  DIGITAL_BILL_OPTIONS,
  DigitalBillsService,
} from '../../src/digital-bills/digital-bills.service.js';
import { appendEvent } from '../../src/events/outbox.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, testAdminUrl } from '../helpers/test-database.js';
import { until } from '../helpers/wait.js';
import { seedDesignCapacity } from '../performance/design-capacity.js';

/**
 * P7-09b acceptance (BILL-012, BILL-011, SEC-002): a settled bill goes to the diner on WhatsApp
 * through a real Vendor Control Plane, whose provider is a stand-in for Meta's Cloud API (CI never
 * messages anyone). Only with consent; queued and retried while the vendor or WhatsApp cannot be
 * reached, for up to a day; the whole number forgotten once sent or given up.
 */

const PHONE = '+919876543210';
let serverDatabase: TestDatabase;
let cpDatabase: TestDatabase;
let controlPlane: INestApplication;
let whatsapp: Server;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let clock = new Date();
/** What the stand-in WhatsApp received, and how it answers next. */
const received: Record<string, unknown>[] = [];
let answer: () => { status: number; body: unknown } = () => ({
  status: 200,
  body: { messages: [{ id: `wamid.${String(received.length)}` }] },
});

const portOf = (listening: Server) => {
  const address = listening.address();
  if (address === null || typeof address === 'string') throw new Error('Not listening');
  return address.port;
};

function readBody(incoming: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    incoming.on('error', reject);
  });
}

async function startWhatsApp(): Promise<Server> {
  const http = createServer((incoming, outgoing) => {
    void readBody(incoming).then((text) => {
      received.push({
        path: incoming.url,
        token: incoming.headers.authorization,
        ...(JSON.parse(text) as Record<string, unknown>),
      });
      const next = answer();
      outgoing
        .writeHead(next.status, { 'content-type': 'application/json' })
        .end(JSON.stringify(next.body));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return http;
}

const server = () => request(httpServer(app));
const bills = () => app.get(DigitalBillsService);

/** A settled invoice of the seeded day, with the diner's number and consent as given. */
async function settledInvoice(phone: string | null, consent: boolean): Promise<string> {
  const invoice = await prisma.invoice.findFirstOrThrow({
    where: { status: 'SETTLED', customerPhone: null, digitalBills: { none: {} } },
    orderBy: { invoiceNumber: 'asc' },
  });
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { customerPhone: phone ?? '000', customerPhoneConsent: consent },
  });
  return invoice.id;
}

/** What the payments service announces when the last payment settles a bill. */
async function announceSettled(invoiceId: string): Promise<void> {
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  await prisma.transaction((tx) =>
    appendEvent(
      tx,
      {
        version: 1,
        eventId: newId(),
        occurredAt: new Date().toISOString(),
        restaurantId: kit.restaurantId,
        businessDate: invoice.businessDate.toISOString().slice(0, 10),
        type: 'BillSettled',
        payload: { invoiceId, grandTotal: invoice.grandTotal },
      },
      { aggregate: { type: 'invoice', id: invoiceId } },
    ),
  );
}

async function setChannel(channel: 'OFF' | 'WHATSAPP'): Promise<void> {
  const manager = await signIn(app, kit, 'MANAGER');
  const changed = await server()
    .put('/api/v1/settings/bills.digitalBillChannel')
    .set(authHeaders(kit.deviceId, manager.accessToken))
    .send({ value: channel });
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
}

async function listOf(invoiceId: string) {
  const cashier = await signIn(app, kit, 'CASHIER');
  const listed = await server()
    .get(`/api/v1/invoices/${invoiceId}/digital-bills`)
    .set(authHeaders(kit.deviceId, cashier.accessToken));
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  return InvoiceDigitalBillsResponse.parse(listed.body);
}

beforeAll(async () => {
  serverDatabase = await createTestDatabase();
  cpDatabase = await createMigratedDatabase({
    adminUrl: testAdminUrl(),
    runId: inject('pgRunId'),
    prefix: 'rp',
    migrationsDir: CONTROL_PLANE_MIGRATIONS_DIR,
  });
  whatsapp = await startWhatsApp();
  controlPlane = await createControlPlaneApp(
    CpConfigSchema.parse({
      databaseUrl: cpDatabase.url,
      logLevel: 'silent',
      publicUrl: 'https://cloud.example.in',
      digitalBillKey: Buffer.alloc(32, 9).toString('base64'),
      digitalBillSweepSeconds: 0,
      whatsappToken: 'test-only-whatsapp-token',
      whatsappPhoneNumberId: '1234567890',
      whatsappApiUrl: `http://127.0.0.1:${String(portOf(whatsapp))}/v21.0`,
    }),
  );
  await controlPlane.listen(0, '127.0.0.1');
  const admin = controlPlane.get(AdminService);
  const tenant = await admin.createTenant('Spice Route', 'ci:test');
  const issued = await admin.createInstallation(
    { tenantId: tenant.id, name: 'Counter PC' },
    'ci:test',
  );
  app = await createTestApp({
    databaseUrl: serverDatabase.url,
    config: {
      controlPlaneUrl: `http://127.0.0.1:${String(portOf(controlPlane.getHttpServer() as Server))}`,
    },
    overrides: [
      {
        provide: CONTROL_PLANE_OPTIONS,
        useValue: { ...DEFAULT_CONTROL_PLANE_OPTIONS, firstHeartbeatDelayMs: 3_600_000 },
      },
      { provide: DIGITAL_BILL_OPTIONS, useValue: { checkEveryMs: 0, now: () => clock } },
    ],
  });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  await enrolInstallation({
    config: app.get<AppConfig>(APP_CONFIG),
    prisma,
    secrets: app.get<SecretStore>(SECRET_STORE),
    code: issued.code,
  });
  await seedDesignCapacity(app, kit, { lastDay: '2026-10-03', days: 1, ordersPerDay: 12 });
}, 120_000);

afterAll(async () => {
  await app.close();
  await controlPlane.close();
  whatsapp.close();
  await serverDatabase.drop();
  await cpDatabase.drop();
});

describe('[BILL-012] [BILL-011] [SEC-002] digital bills from the restaurant PC', () => {
  it('sends a settled bill with the diner’s consent by itself, once, and forgets the number', async () => {
    await setChannel('WHATSAPP');
    const invoiceId = await settledInvoice('098765 43210', true);
    await announceSettled(invoiceId);
    const queued = await until(
      () => prisma.digitalBill.findFirst({ where: { invoiceId } }).then((row) => row ?? undefined),
      5_000,
      'the bill to be queued',
    );
    expect(queued).toMatchObject({ status: 'QUEUED', phone: PHONE, requestedById: null });

    expect(await bills().runDue()).toBe(1);
    const message = received.at(-1);
    expect(message).toMatchObject({
      path: '/v21.0/1234567890/messages',
      token: 'Bearer test-only-whatsapp-token',
      to: '919876543210',
      type: 'template',
    });
    const sent = await prisma.digitalBill.findUniqueOrThrow({ where: { id: queued.id } });
    expect(sent).toMatchObject({ status: 'SENT', phone: null, phoneMasked: '+91 ******3210' });
    expect(sent.link).toMatch(/^https:\/\/cloud\.example\.in\/v1\/bills\//);

    // The diner's link opens the bill as printed, at the Control Plane.
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const page = await request(controlPlane.getHttpServer() as Server).get(
      (sent.link ?? '').replace('https://cloud.example.in', ''),
    );
    expect(page.status).toBe(200);
    expect(page.text).toContain(invoice.invoiceNumber);

    // The cashier sees what happened, never the whole number.
    const listed = await listOf(invoiceId);
    expect(listed).toMatchObject({ channel: 'WHATSAPP', phone: '+91 ******3210' });
    expect(listed.bills.map((entry) => [entry.status, entry.requestedBy])).toEqual([
      ['SENT', null],
    ]);
    expect(JSON.stringify(listed)).not.toContain('9876543210');

    // The same event again (a replay) sends nothing more.
    await announceSettled(invoiceId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await prisma.digitalBill.count({ where: { invoiceId } })).toBe(1);

    // Audited, without the number.
    const audit = await prisma.auditLog.findMany({
      where: { action: 'DIGITAL_BILL_QUEUED', entityId: invoiceId },
    });
    expect(audit).toHaveLength(1);
    expect(
      JSON.stringify(audit.map((entry) => [entry.before, entry.after, entry.reason])),
    ).not.toContain('9876543210');
  });

  it('sends only to a mobile number given with consent, and only while digital bills are on', async () => {
    const cashier = await signIn(app, kit, 'CASHIER');
    const as = authHeaders(kit.deviceId, cashier.accessToken);
    const noConsent = await settledInvoice('9876543210', false);
    await announceSettled(noConsent);
    const refused = await server().post(`/api/v1/invoices/${noConsent}/digital-bills`).set(as);
    expect([refused.status, ApiError.parse(refused.body).code]).toEqual([
      422,
      'NO_DIGITAL_BILL_CONSENT',
    ]);
    const landline = await settledInvoice('022 2345 6789', true);
    expect((await server().post(`/api/v1/invoices/${landline}/digital-bills`).set(as)).status).toBe(
      422,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await prisma.digitalBill.count({ where: { invoiceId: noConsent } })).toBe(0);

    const waiter = await signIn(app, kit, 'WAITER');
    const notTheirs = await server()
      .post(`/api/v1/invoices/${noConsent}/digital-bills`)
      .set(authHeaders(kit.deviceId, waiter.accessToken));
    expect(notTheirs.status).toBe(403);

    await setChannel('OFF');
    const off = await settledInvoice('9876543210', true);
    await announceSettled(off);
    const whileOff = await server().post(`/api/v1/invoices/${off}/digital-bills`).set(as);
    expect([whileOff.status, ApiError.parse(whileOff.body).code]).toEqual([
      409,
      'DIGITAL_BILLS_OFF',
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await prisma.digitalBill.count({ where: { invoiceId: off } })).toBe(0);
    await setChannel('WHATSAPP');
  });

  it('waits while WhatsApp is down and tries again, then gives up after a day', async () => {
    const cashier = await signIn(app, kit, 'CASHIER');
    const invoiceId = await settledInvoice('9876543210', true);
    const queued = await server()
      .post(`/api/v1/invoices/${invoiceId}/digital-bills`)
      .set(authHeaders(kit.deviceId, cashier.accessToken));
    expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    const entry = DigitalBillEntry.parse(queued.body);
    expect(entry).toMatchObject({ status: 'QUEUED', requestedBy: expect.any(String) as string });

    answer = () => ({ status: 503, body: { error: { code: 2, message: 'Service unavailable' } } });
    await bills().runDue();
    let row = await prisma.digitalBill.findUniqueOrThrow({ where: { id: entry.id } });
    expect(row).toMatchObject({ status: 'QUEUED', attempts: 1, phone: PHONE });
    expect(row.lastError).toContain('503');
    expect(row.nextAttemptAt?.getTime()).toBe(clock.getTime() + 60_000);
    // Not due yet: nothing is tried.
    expect(await bills().runDue()).toBe(0);

    // A minute later WhatsApp is back.
    answer = () => ({ status: 200, body: { messages: [{ id: 'wamid.later' }] } });
    clock = new Date(clock.getTime() + 61_000);
    await bills().runDue();
    row = await prisma.digitalBill.findUniqueOrThrow({ where: { id: entry.id } });
    expect(row).toMatchObject({ status: 'SENT', attempts: 2, phone: null, lastError: null });

    // Another bill while WhatsApp stays down: given up a day after it was queued.
    answer = () => ({ status: 503, body: {} });
    const second = DigitalBillEntry.parse(
      (
        await server()
          .post(`/api/v1/invoices/${await settledInvoice('9876543210', true)}/digital-bills`)
          .set(authHeaders(kit.deviceId, cashier.accessToken))
      ).body,
    );
    // Queued "now" on the server's clock; tried as the PC's clock moves on.
    for (let hour = 0; hour < 30; hour += 1) {
      clock = new Date(clock.getTime() + 3 * 3_600_000);
      await bills().runDue();
      const now = await prisma.digitalBill.findUniqueOrThrow({ where: { id: second.id } });
      if (now.status !== 'QUEUED') break;
    }
    row = await prisma.digitalBill.findUniqueOrThrow({ where: { id: second.id } });
    expect(row).toMatchObject({ status: 'FAILED', phone: null, nextAttemptAt: null });
    answer = () => ({ status: 200, body: { messages: [{ id: 'wamid.ok' }] } });
  });

  it('does not try again a number WhatsApp cannot deliver to', async () => {
    const cashier = await signIn(app, kit, 'CASHIER');
    answer = () => ({ status: 400, body: { error: { code: 131026, message: 'Undeliverable' } } });
    const entry = DigitalBillEntry.parse(
      (
        await server()
          .post(`/api/v1/invoices/${await settledInvoice('9876543210', true)}/digital-bills`)
          .set(authHeaders(kit.deviceId, cashier.accessToken))
      ).body,
    );
    await bills().runDue();
    const row = await prisma.digitalBill.findUniqueOrThrow({ where: { id: entry.id } });
    expect(row).toMatchObject({ status: 'FAILED', attempts: 1, phone: null });
    expect(row.lastError).toContain('131026');
    answer = () => ({ status: 200, body: { messages: [{ id: 'wamid.ok' }] } });
  });

  it('[DATA-011] does not send a waiting bill once the diner’s number is erased', async () => {
    const cashier = await signIn(app, kit, 'CASHIER');
    const entry = DigitalBillEntry.parse(
      (
        await server()
          .post(`/api/v1/invoices/${await settledInvoice('9876543210', true)}/digital-bills`)
          .set(authHeaders(kit.deviceId, cashier.accessToken))
      ).body,
    );
    const owner = await signIn(app, kit, 'OWNER');
    await prisma.session.update({
      where: { id: owner.session.id },
      data: { secondFactorAt: new Date() },
    });
    const erased = await server()
      .post('/api/v1/diner-contacts/erase')
      .set(authHeaders(kit.deviceId, owner.accessToken))
      .send({ phone: '9876543210', reason: 'Diner asked' });
    expect(erased.status, JSON.stringify(erased.body)).toBe(200);
    const row = await prisma.digitalBill.findUniqueOrThrow({ where: { id: entry.id } });
    expect(row).toMatchObject({ status: 'FAILED', phone: null });
    const before = received.length;
    await bills().runDue();
    expect(received).toHaveLength(before);
  });
});
