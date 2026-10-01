import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  EraseDinerContactResponse,
  FeedbackReportResponse,
  type LoginResponse,
  ReportExportResponse,
  TableSessionView,
  TabletFeedbackResponse,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
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
 * Diners' feedback after the bill (P3-05b, TAB-014, RPT-013): once per visit from the table's
 * tablet; a number only with consent recorded with its purpose and words (BILL-011, SEC-019);
 * erased on request (DATA-011).
 */

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let waiter: LoginResponse;
let manager: LoginResponse;
let owner: LoginResponse;
const ids: Record<string, string> = {};
const id = (name: string) => ids[name] ?? '';
let today = '';

const server = () => request(httpServer(app));
const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;
const CONSENT = 'Send my bill and follow up on my feedback on WhatsApp or SMS at this number.';

const send = (body: object, device = 'tablet') =>
  server()
    .post('/api/v1/devices/current/feedback')
    .set(authHeaders(id(device)))
    .send(body);

async function openT1(): Promise<string> {
  const opened = await server()
    .post(`/api/v1/tables/${id('T1')}/open`)
    .set(as(waiter))
    .send({ covers: 2 });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  return TableSessionView.parse(opened.body).id;
}

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  waiter = await signIn(app, kit, 'WAITER');
  manager = await signIn(app, kit, 'MANAGER');
  owner = await signIn(app, kit, 'OWNER');
  // The Owner has confirmed the second factor in this session (AUTH-006, DATA_ADMIN).
  await prisma.session.update({
    where: { id: owner.session.id },
    data: { secondFactorAt: new Date() },
  });
  const section = await prisma.section.create({
    data: { restaurantId: kit.restaurantId, name: 'Hall' },
  });
  ids.T1 = (
    await prisma.diningTable.create({
      data: { restaurantId: kit.restaurantId, sectionId: section.id, label: 'T1' },
    })
  ).id;
  ids.tablet = await addDevice(app, kit, 'TABLE_TABLET', { tableId: id('T1') });
  ids.kds = await addDevice(app, kit, 'KDS');
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('[TAB-014] feedback from the table', () => {
  it('needs an open table and a table tablet', async () => {
    const closed = await send({ foodRating: 5, serviceRating: 4 });
    expect(closed.status).toBe(409);
    expect(codeOf(closed)).toBe('TABLE_NOT_OPEN');
    const kds = await send({ foodRating: 5, serviceRating: 4 }, 'kds');
    expect(kds.status).toBe(403);
  });

  it('takes ratings and a comment once per visit', async () => {
    ids.first = await openT1();
    const response = await send({ foodRating: 5, serviceRating: 4, comment: 'Lovely dal' });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    TabletFeedbackResponse.parse(response.body);
    const again = await send({ foodRating: 1, serviceRating: 1 });
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBe('FEEDBACK_ALREADY_GIVEN');
    const bad = await send({ foodRating: 6, serviceRating: 1 });
    expect(bad.status).toBe(400);
  });

  it('[BILL-011] [SEC-019] keeps a number only with consent, with its purpose and words', async () => {
    const closed = await server()
      .post(`/api/v1/table-sessions/${id('first')}/close-without-bill`)
      .set(as(manager))
      .send({ reason: 'Guests left' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    await openT1();
    const unconsented = await send({ foodRating: 3, serviceRating: 2, phone: '9876543210' });
    expect(unconsented.status).toBe(400);
    const response = await send({
      foodRating: 3,
      serviceRating: 2,
      comment: 'Slow service',
      phone: '+91 98765 43210',
      consent: true,
      consentText: CONSENT,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const contact = await prisma.dinerContact.findFirstOrThrow({});
    expect(contact).toMatchObject({
      phone: '+919876543210',
      consentPurpose: 'DIGITAL_BILL_AND_FEEDBACK',
      consentText: CONSENT,
      consentSource: 'TABLE_TABLET',
      deviceId: id('tablet'),
      erasedAt: null,
    });
    const consent = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'DINER_CONSENT_GIVEN' },
    });
    expect(JSON.stringify([consent.before, consent.after, consent.reason])).not.toContain(
      '9876543210',
    );
  });
});

describe('[RPT-013] the feedback report', () => {
  it('gives the averages by day and every comment, without the numbers', async () => {
    const preview = await server().get('/api/v1/day-end').set(as(manager));
    today = (preview.body as { businessDate: string }).businessDate;
    const response = await server()
      .get('/api/v1/reports/feedback')
      .query({ from: today, to: today })
      .set(as(manager));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const report = FeedbackReportResponse.parse(response.body);
    expect(report).toMatchObject({ count: 2, averageFood: 400, averageService: 300 });
    expect(report.byDay).toEqual([
      { businessDate: today, count: 2, averageFood: 400, averageService: 300 },
    ]);
    expect(
      report.entries.map((entry) => [entry.comment, entry.tableLabel, entry.hasContact]),
    ).toEqual([
      ['Slow service', 'T1', true],
      ['Lovely dal', 'T1', false],
    ]);
    expect(JSON.stringify(report)).not.toContain('98765');
  });

  it('[RPT-017] exports with the other reports', async () => {
    const response = await server()
      .post('/api/v1/reports/exports')
      .set(as(manager))
      .send({ report: 'FEEDBACK', from: today, to: today, format: 'CSV' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const file = ReportExportResponse.parse(response.body);
    expect(file.content).toContain('Customer feedback');
    expect(file.content).toContain('Lovely dal');
    expect(file.content).not.toContain('98765');
  });
});

describe('[DATA-011] erasing a diner’s number', () => {
  it('lets the Owner erase it everywhere but invoices, audited without the number', async () => {
    const byManager = await server()
      .post('/api/v1/diner-contacts/erase')
      .set(as(manager))
      .send({ phone: '9876543210', reason: 'Asked at the counter' });
    expect(byManager.status).toBe(403);
    const response = await server()
      .post('/api/v1/diner-contacts/erase')
      .set(as(owner))
      .send({ phone: '9876543210', reason: 'Asked at the counter' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(EraseDinerContactResponse.parse(response.body)).toEqual({ erased: 1 });
    const contact = await prisma.dinerContact.findFirstOrThrow({});
    expect(contact.phone).toBeNull();
    expect(contact.erasedAt).not.toBeNull();
    expect(await prisma.feedback.count({ where: { dinerContactId: { not: null } } })).toBe(0);
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'DINER_CONTACT_ERASED' },
    });
    expect(entry.actorId).toBe(kit.staff.OWNER);
    expect(JSON.stringify([entry.before, entry.after, entry.reason])).not.toContain('9876543210');
    // The consent record stays: it was given, and withdrawn.
    expect(contact.consentGivenAt).toBeInstanceOf(Date);
  });
});
