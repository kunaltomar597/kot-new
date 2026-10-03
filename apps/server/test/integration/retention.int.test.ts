import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { SystemStatusResponse } from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { RETENTION_OPTIONS, RetentionService } from '../../src/lifecycle/retention.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

/**
 * The automatic retention of BRD §9.3 (P7-06a, DATA-007, DATA-011): operational data after 90
 * days, a diner's number after 24 months without a visit, feedback comments after 24 months;
 * orders, bills and the audit log are never touched; each run that changes something is audited.
 */

const DAY = 24 * 60 * 60_000;
const now = new Date('2026-10-03T06:00:00Z');
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);
const dataDir = mkdtempSync(join(tmpdir(), 'rp-retention-'));
let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;

/** A file whose last change was `days` ago. */
function oldFile(path: string, days: number): void {
  writeFileSync(path, 'x');
  const at = daysAgo(days);
  utimesSync(path, at, at);
}

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({
    databaseUrl: database.url,
    config: { dataDir },
    overrides: [
      { provide: RETENTION_OPTIONS, useValue: { firstDelayMs: 0, everyMs: 0, now: () => now } },
    ],
  });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('[DATA-007] [DATA-011] the automatic retention (BRD §9.3)', () => {
  it('removes old operational data and anonymises old personal data, audited', async () => {
    const restaurantId = kit.restaurantId;
    const businessDate = new Date('2026-06-01');
    const base = { restaurantId, businessDate };
    const old = daysAgo(100);
    const recent = daysAgo(10);

    // Alerts: an old cleared one goes; an old open one, a recent one, and one a request holds stay.
    const alert = (status: 'OPEN' | 'CLEARED', at: Date) =>
      prisma.alert.create({
        data: { ...base, type: 'WATER_REQUEST', status, createdAt: at, updatedAt: at },
      });
    const oldCleared = await alert('CLEARED', old);
    const oldOpen = await alert('OPEN', old);
    const recentCleared = await alert('CLEARED', recent);
    const held = await alert('CLEARED', old);
    const section = await prisma.section.create({ data: { restaurantId, name: 'Main' } });
    const table = await prisma.diningTable.create({
      data: { restaurantId, sectionId: section.id, label: 'T1' },
    });
    const session = await prisma.tableSession.create({
      data: { restaurantId, tableId: table.id, businessDate },
    });
    const requestBase = {
      ...base,
      tableSessionId: session.id,
      tableId: table.id,
      type: 'WATER' as const,
      source: 'TABLE_TABLET' as const,
    };
    const closedOld = await prisma.serviceRequest.create({
      data: { ...requestBase, closedAt: old, createdAt: old },
    });
    const openOld = await prisma.serviceRequest.create({
      data: { ...requestBase, alertId: held.id, createdAt: old },
    });

    const station = await prisma.station.create({ data: { restaurantId, name: 'Kitchen' } });
    const notice = (printStatus: 'PRINTED' | 'PENDING', at: Date) =>
      prisma.printNotice.create({
        data: {
          ...base,
          stationId: station.id,
          title: 'Note',
          lines: [],
          printStatus,
          createdAt: at,
        },
      });
    const printedOld = await notice('PRINTED', old);
    const pendingOld = await notice('PENDING', old);

    const record = (expiresAt: Date) =>
      prisma.idempotencyRecord.create({
        data: {
          restaurantId,
          scope: 'order',
          key: randomUUID(),
          requestHash: 'h',
          expiresAt,
        },
      });
    const expiredOld = await record(old);
    const expiredRecently = await record(recent);

    // Diners: one last seen 25 months ago, one who came back 3 months ago.
    const contact = (givenAt: Date, phone: string) =>
      prisma.dinerContact.create({
        data: {
          restaurantId,
          phone,
          consentPurpose: 'DIGITAL_BILL_AND_FEEDBACK',
          consentText: 'Send me my bill',
          consentGivenAt: givenAt,
          consentSource: 'TABLE_TABLET',
        },
      });
    const gone = await contact(daysAgo(25 * 31), '+919800000001');
    const regular = await contact(daysAgo(25 * 31), '+919800000002');
    const feedback = (at: Date, dinerContactId: string | null) =>
      prisma.feedback.create({
        data: {
          ...base,
          source: 'TABLE_TABLET',
          foodRating: 4,
          serviceRating: 5,
          comment: 'Lovely dal',
          dinerContactId,
          createdAt: at,
        },
      });
    const oldFeedback = await feedback(daysAgo(25 * 31), gone.id);
    const newFeedback = await feedback(daysAgo(90), regular.id);

    mkdirSync(join(dataDir, 'logs'), { recursive: true });
    oldFile(join(dataDir, 'logs', 'server.2026-06-01.log'), 100);
    oldFile(join(dataDir, 'logs', 'server.log'), 1);
    mkdirSync(join(dataDir, '.restore-20261001t000000z'));
    utimesSync(join(dataDir, '.restore-20261001t000000z'), daysAgo(2), daysAgo(2));

    const result = await app.get(RetentionService).run();
    expect(result).toEqual({
      alerts: 1,
      serviceRequests: 1,
      printNotices: 1,
      idempotencyRecords: 1,
      dinerContactsAnonymised: 1,
      feedbackAnonymised: 1,
      files: 2,
    });
    const left = async (ids: { id: string }[]) => {
      const where = { id: { in: ids.map((row) => row.id) } };
      return [
        ...(await prisma.alert.findMany({ where, select: { id: true } })),
        ...(await prisma.serviceRequest.findMany({ where, select: { id: true } })),
        ...(await prisma.printNotice.findMany({ where, select: { id: true } })),
        ...(await prisma.idempotencyRecord.findMany({ where, select: { id: true } })),
      ].map((row) => row.id);
    };
    const removed = [oldCleared, closedOld, printedOld, expiredOld];
    const kept = [oldOpen, recentCleared, held, openOld, pendingOld, expiredRecently];
    expect(await left(removed)).toEqual([]);
    expect((await left(kept)).sort()).toEqual(kept.map((row) => row.id).sort());

    expect(await prisma.dinerContact.findUniqueOrThrow({ where: { id: gone.id } })).toMatchObject({
      phone: null,
      erasedAt: now,
    });
    expect((await prisma.dinerContact.findUniqueOrThrow({ where: { id: regular.id } })).phone).toBe(
      '+919800000002',
    );
    // The ratings stay for the reports; nothing that identifies a person.
    expect(
      await prisma.feedback.findUniqueOrThrow({ where: { id: oldFeedback.id } }),
    ).toMatchObject({ comment: null, dinerContactId: null, foodRating: 4, serviceRating: 5 });
    expect(
      (await prisma.feedback.findUniqueOrThrow({ where: { id: newFeedback.id } })).comment,
    ).toBe('Lovely dal');

    expect(existsSync(join(dataDir, 'logs', 'server.2026-06-01.log'))).toBe(false);
    expect(existsSync(join(dataDir, 'logs', 'server.log'))).toBe(true);
    expect(existsSync(join(dataDir, '.restore-20261001t000000z'))).toBe(false);

    const audit = await prisma.auditLog.findMany({ where: { action: 'RETENTION_APPLIED' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.after).toMatchObject({ alerts: 1, dinerContactsAnonymised: 1 });

    // Nothing more to do: no new audit entry.
    expect(Object.values(await app.get(RetentionService).run()).every((n) => n === 0)).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: 'RETENTION_APPLIED' } })).toBe(1);
  });

  it('shows the last run on the System page', async () => {
    const manager = await signIn(app, kit, 'MANAGER');
    const response = await request(httpServer(app))
      .get('/api/v1/system')
      .set(authHeaders(kit.deviceId, manager.accessToken));
    expect(response.status).toBe(200);
    expect(SystemStatusResponse.parse(response.body).storage.retention).toEqual({
      operationalDays: 90,
      dinerContactMonths: 24,
      lastRunAt: now.toISOString(),
      lastRunTotal: 0,
    });
  });
});
