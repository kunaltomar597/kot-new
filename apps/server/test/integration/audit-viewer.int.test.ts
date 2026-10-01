import type { INestApplication } from '@nestjs/common';
import {
  AuditListResponse,
  DayEndPreview,
  type LoginResponse,
  ReportExportResponse,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

/** The audit viewer (P4-07a, AUD-005) over entries the app writes itself. */

let database: TestDatabase;
let app: INestApplication;
let kit: AuthKit;
let manager: LoginResponse;
let waiter: LoginResponse;
let today: string;

const server = () => request(httpServer(app));
const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const list = (query: Record<string, string | number>, login = manager) =>
  server()
    .get('/api/v1/audit')
    .query({ from: today, to: today, ...query })
    .set(as(login));

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  waiter = await signIn(app, kit, 'WAITER');
  for (const minutes of [12, 15]) {
    const changed = await server()
      .put('/api/v1/settings/kds.ageAmberMinutes')
      .set(as(manager))
      .send({ value: minutes, reason: `Busy grill ${String(minutes)}` });
    expect(changed.status).toBe(200);
  }
  today = DayEndPreview.parse(
    (await server().get('/api/v1/day-end').set(as(manager))).body,
  ).businessDate;
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('[AUD-005] the audit viewer', () => {
  it('lists the day’s entries newest first, naming who, where and why', async () => {
    const response = await list({});
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const audit = AuditListResponse.parse(response.body);
    expect(audit.actions).toEqual(expect.arrayContaining(['LOGIN', 'SETTING_CHANGED']));
    expect(audit.people.map((person) => person.id)).toContain(kit.staff.MANAGER);
    const seqs = audit.entries.map((entry) => entry.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
    const latest = audit.entries.find((entry) => entry.action === 'SETTING_CHANGED');
    expect(latest).toMatchObject({
      reason: 'Busy grill 15',
      actor: { id: kit.staff.MANAGER },
      device: { id: kit.deviceId },
    });
    expect(latest?.after).toMatchObject({ value: 15 });
  });

  it('filters by action and person, and reads a page at a time', async () => {
    const settings = AuditListResponse.parse((await list({ action: 'SETTING_CHANGED' })).body);
    expect(settings.total).toBe(2);
    expect(settings.entries.every((entry) => entry.action === 'SETTING_CHANGED')).toBe(true);
    const waiters = AuditListResponse.parse((await list({ actorId: kit.staff.WAITER })).body);
    expect(waiters.entries.length).toBeGreaterThan(0);
    expect(waiters.entries.every((entry) => entry.actor?.id === kit.staff.WAITER)).toBe(true);
    const first = AuditListResponse.parse(
      (await list({ action: 'SETTING_CHANGED', limit: 1 })).body,
    );
    expect(first).toMatchObject({ total: 2, offset: 0, nextOffset: 1 });
    expect(first.entries[0]?.reason).toBe('Busy grill 15');
    const second = AuditListResponse.parse(
      (await list({ action: 'SETTING_CHANGED', limit: 1, offset: 1 })).body,
    );
    expect(second).toMatchObject({ nextOffset: null });
    expect(second.entries[0]?.reason).toBe('Busy grill 12');
  });

  it('is for the Owner and managers, over at most a year', async () => {
    expect((await list({}, waiter)).status).toBe(403);
    expect((await list({ from: '2020-01-01' })).status).toBe(400);
    expect((await list({ action: 'not an action' })).status).toBe(400);
  });

  it('[RPT-017] exports the log with its filters, and not to people without it', async () => {
    const exported = await server()
      .post('/api/v1/reports/exports')
      .set(as(manager))
      .send({ report: 'AUDIT', from: today, to: today, format: 'CSV', action: 'SETTING_CHANGED' });
    expect(exported.status, JSON.stringify(exported.body)).toBe(200);
    const file = ReportExportResponse.parse(exported.body);
    expect(file.content).toContain('Action,SETTING_CHANGED');
    expect(file.content).toContain('Busy grill 12');
    expect(file.content).not.toContain(',LOGIN,');
    const refused = await server()
      .post('/api/v1/reports/exports')
      .set(as(waiter))
      .send({ report: 'AUDIT', from: today, to: today, format: 'CSV' });
    expect(refused.status).toBe(403);
  });
});
