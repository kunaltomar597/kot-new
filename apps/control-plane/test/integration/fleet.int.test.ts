import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  AuditHeadListResponse,
  type FleetAlertView,
  FleetAlertListResponse,
  FleetResponse,
  HeartbeatResponse,
} from '@rp/contracts/control-plane';
import { calendarDateOf, WEEKDAYS, weekdayOf } from '@rp/domain';
import type { TestDatabase } from '@rp/test-postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { ALERT_NOTIFIER, type AlertNotifier } from '../../src/fleet/alert-notifier.js';
import { FleetService } from '../../src/fleet/fleet.service.js';
import { enrolledInstallation, heartbeatBody, signedPost } from '../helpers/fleet.js';
import { createTestApp, createTestDatabase, httpServer } from '../helpers/test-app.js';
import type { TestInstallation } from '../helpers/test-installation.js';
import { bearer, signInVendor, vendorAccount } from '../helpers/vendor.js';

/** A webhook that records what it was sent, and can be made to fail. */
class RecordingNotifier implements AlertNotifier {
  readonly configured = true;
  readonly sent: string[] = [];
  failing = false;

  send(text: string): Promise<void> {
    if (this.failing) return Promise.reject(new Error('webhook down'));
    this.sent.push(text);
    return Promise.resolve();
  }
}

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let fleet: FleetService;
const notifier = new RecordingNotifier();
const tokens: Record<string, string> = {};
const as = (role: string) => bearer(tokens[role] ?? '');
const server = () => request(httpServer(app));
const hash = (character: string) => character.repeat(64);

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp(database.url, {}, [{ provide: ALERT_NOTIFIER, useValue: notifier }]);
  prisma = app.get(PrismaService);
  fleet = app.get(FleetService);
  for (const role of ['SUPPORT', 'FINANCE', 'READ_ONLY'] as const) {
    tokens[role] = await signInVendor(app, await vendorAccount(app, role));
  }
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

async function beat(pc: TestInstallation, overrides: Record<string, unknown> = {}) {
  const response = await signedPost(app, pc, '/v1/heartbeats', heartbeatBody(overrides));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return HeartbeatResponse.parse(response.body);
}

async function alertsOf(installationId: string, state: 'OPEN' | 'ALL' = 'OPEN') {
  const response = await server()
    .get('/v1/vendor/fleet/alerts')
    .query({ state, installationId })
    .set(as('READ_ONLY'));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return FleetAlertListResponse.parse(response.body).alerts;
}

const kinds = (alerts: readonly FleetAlertView[]) => alerts.map((alert) => alert.kind).sort();

describe('[VCP-005] [DATA-005] alerts from a heartbeat', () => {
  it('opens one disk alert past 90 % and closes it when space is freed', async () => {
    const pc = await enrolledInstallation(app);
    const full = { disk: { totalBytes: 1_000, freeBytes: 50 } };
    await beat(pc, full);
    await beat(pc, full);
    const open = await alertsOf(pc.id ?? '');
    expect(kinds(open)).toEqual(['DISK_FULL']);
    expect(open[0]).toMatchObject({ tenantName: 'Test Dhaba', details: { usedPercent: 95 } });
    await beat(pc, { disk: { totalBytes: 1_000, freeBytes: 500 } });
    expect(await alertsOf(pc.id ?? '')).toEqual([]);
    const all = await alertsOf(pc.id ?? '', 'ALL');
    expect(all[0]).toMatchObject({ kind: 'DISK_FULL', resolvedBy: 'system:fleet' });
    expect(
      await prisma.auditEntry.count({
        where: {
          targetId: pc.id ?? '',
          action: { in: ['fleet.alert_opened', 'fleet.alert_resolved'] },
        },
      }),
    ).toBe(2);
  });

  it('opens a backup alert while the latest backup failed', async () => {
    const pc = await enrolledInstallation(app);
    await beat(pc, {
      backup: {
        lastSuccessAt: '2026-10-01T20:00:00.000Z',
        lastFailureAt: '2026-10-02T20:00:00.000Z',
        lastError: 'The USB drive is not connected',
      },
    });
    const [alert] = await alertsOf(pc.id ?? '');
    expect(alert).toMatchObject({
      kind: 'BACKUP_FAILED',
      details: { error: 'The USB drive is not connected' },
    });
    await beat(pc, {
      backup: {
        lastSuccessAt: '2026-10-02T21:00:00.000Z',
        lastFailureAt: '2026-10-02T20:00:00.000Z',
        lastError: null,
      },
    });
    expect(await alertsOf(pc.id ?? '')).toEqual([]);
  });
});

describe('[VCP-005] offline during business hours', () => {
  it('reports a PC silent for more than 30 minutes of its opening hours, then back', async () => {
    const pc = await enrolledInstallation(app);
    await beat(pc, { businessHours: { timeZone: 'Asia/Kolkata', hours: [] } });
    const later = new Date(Date.now() + 45 * 60_000);
    await fleet.sweep(new Date(Date.now() + 20 * 60_000));
    expect(await alertsOf(pc.id ?? '')).toEqual([]);
    await fleet.sweep(later);
    // Swept again: still one alert.
    await fleet.sweep(new Date(later.getTime() + 60_000));
    const alerts = await alertsOf(pc.id ?? '');
    expect(kinds(alerts)).toEqual(['OFFLINE']);
    const [alert] = alerts;
    expect(alert?.details?.minutes).toBeGreaterThanOrEqual(44);
    await beat(pc);
    expect(await alertsOf(pc.id ?? '')).toEqual([]);
  });

  it('stays quiet while the restaurant is closed', async () => {
    const pc = await enrolledInstallation(app);
    const later = new Date(Date.now() + 45 * 60_000);
    // Open every day except today and yesterday (in IST): closed now and 45 minutes from now.
    const today = calendarDateOf(later);
    const closed = new Set([
      weekdayOf(today),
      weekdayOf(calendarDateOf(new Date(later.getTime() - 86_400_000))),
    ]);
    const hours = WEEKDAYS.filter((day) => !closed.has(day)).map((day) => ({
      day,
      start: '00:00',
      end: '23:59',
    }));
    await beat(pc, { businessHours: { timeZone: 'Asia/Kolkata', hours } });
    await fleet.sweep(later);
    expect(await alertsOf(pc.id ?? '')).toEqual([]);
  });
});

describe('[AUD-003] the audit chain heads', () => {
  it('detects a local chain that went back, and lets Support close the alert with a reason', async () => {
    const pc = await enrolledInstallation(app);
    await beat(pc, { auditChainHead: { sequence: 10, hash: hash('a') } });
    await beat(pc, { auditChainHead: { sequence: 25, hash: hash('b') } });
    // Entries 21 to 25 deleted from the PC's database.
    await beat(pc, { auditChainHead: { sequence: 20, hash: hash('c') } });
    const [alert] = await alertsOf(pc.id ?? '');
    expect(alert).toMatchObject({
      kind: 'AUDIT_CHAIN_MISMATCH',
      details: { reason: 'ROLLED_BACK', sequence: 20 },
    });

    const byFinance = await server()
      .post(`/v1/vendor/fleet/alerts/${alert?.id ?? ''}/resolve`)
      .set(as('FINANCE'))
      .send({ reason: 'Looked at it' });
    expect(byFinance.status).toBe(403);
    const resolved = await server()
      .post(`/v1/vendor/fleet/alerts/${alert?.id ?? ''}/resolve`)
      .set(as('SUPPORT'))
      .send({ reason: 'Restored from the 1 Oct backup after a disk failure' });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body).toMatchObject({
      resolution: 'Restored from the 1 Oct backup after a disk failure',
    });
    // The chain now counts from its new head.
    await beat(pc, { auditChainHead: { sequence: 22, hash: hash('d') } });
    expect(await alertsOf(pc.id ?? '')).toEqual([]);
    const heads = AuditHeadListResponse.parse(
      (
        await server()
          .get(`/v1/vendor/installations/${pc.id ?? ''}/audit-heads`)
          .set(as('READ_ONLY'))
      ).body,
    ).heads;
    expect(heads.map((head) => [head.sequence, head.superseded])).toEqual([
      [22, false],
      [25, true],
      [10, true],
    ]);
  });

  it('asks for an earlier head and catches an old entry rewritten on the PC', async () => {
    const pc = await enrolledInstallation(app);
    await beat(pc, { auditChainHead: { sequence: 10, hash: hash('a') } });
    const asked = await beat(pc, { auditChainHead: { sequence: 15, hash: hash('b') } });
    expect(asked.auditCheck).toEqual({ sequence: 10 });
    // The PC still holds entry 10 as it was: verified.
    await beat(pc, {
      auditChainHead: { sequence: 16, hash: hash('c') },
      auditCheckpoint: { sequence: 10, hash: hash('a'), oldestSequence: 1 },
    });
    const view = FleetResponse.parse(
      (await server().get('/v1/vendor/fleet').set(as('READ_ONLY'))).body,
    );
    const mine = view.installations.find((entry) => entry.installationId === pc.id);
    expect(mine?.auditHead).toMatchObject({ sequence: 16, hash: hash('c') });
    expect(mine?.auditHead?.verifiedAt).not.toBeNull();

    // Entry 10 rewritten (and every hash after it recomputed): the head looks fine, the check not.
    const again = await beat(pc, {
      auditChainHead: { sequence: 17, hash: hash('e') },
      auditCheckpoint: { sequence: 10, hash: hash('f'), oldestSequence: 1 },
    });
    expect(kinds(await alertsOf(pc.id ?? ''))).toEqual(['AUDIT_CHAIN_MISMATCH']);
    expect((await alertsOf(pc.id ?? ''))[0]?.details).toMatchObject({
      reason: 'REWRITTEN',
      sequence: 10,
      byAuditCheck: true,
    });
    // No further checks while the chain is in question.
    expect(again.auditCheck).toBeNull();
  });

  it('accepts entries archived and purged on the PC', async () => {
    const pc = await enrolledInstallation(app);
    await beat(pc, { auditChainHead: { sequence: 10, hash: hash('a') } });
    await beat(pc, { auditChainHead: { sequence: 15, hash: hash('b') } });
    await beat(pc, {
      auditChainHead: { sequence: 16, hash: hash('c') },
      auditCheckpoint: { sequence: 10, hash: null, oldestSequence: 12 },
    });
    expect(await alertsOf(pc.id ?? '')).toEqual([]);
  });

  it('closes only chain alerts by hand', async () => {
    const pc = await enrolledInstallation(app);
    await beat(pc, { disk: { totalBytes: 100, freeBytes: 1 } });
    const [alert] = await alertsOf(pc.id ?? '');
    const response = await server()
      .post(`/v1/vendor/fleet/alerts/${alert?.id ?? ''}/resolve`)
      .set(as('SUPPORT'))
      .send({ reason: 'Cleaned up' });
    expect([response.status, ApiError.parse(response.body).code]).toEqual([
      409,
      'ALERT_CLOSES_ITSELF',
    ]);
  });
});

describe('[VCP-005] [NFR-O03] the fleet view and the webhook', () => {
  it('shows each PC’s health from its latest heartbeat', async () => {
    const pc = await enrolledInstallation(app);
    await beat(pc, {
      devices: { POS: 1, KDS: 2, PAGER: 4 },
      devicesConnected: { POS: 1, KDS: 1, PAGER: 3 },
      errorCount: 2,
      disk: { totalBytes: 1_000, freeBytes: 400 },
    });
    const view = FleetResponse.parse(
      (await server().get('/v1/vendor/fleet').set(as('READ_ONLY'))).body,
    );
    const mine = view.installations.find((entry) => entry.installationId === pc.id);
    expect(mine).toMatchObject({
      tenantName: 'Test Dhaba',
      status: 'ACTIVE',
      online: true,
      errorCount: 2,
      disk: { usedPercent: 60 },
      backup: null,
      openAlerts: [],
      devices: [
        { type: 'KDS', paired: 2, connected: 1 },
        { type: 'PAGER', paired: 4, connected: 3 },
        { type: 'POS', paired: 1, connected: 1 },
      ],
    });
    expect(mine?.components.map((component) => component.name)).toContain('RESTAURANT_PC');
  });

  it('sends alerts to the webhook as they open and close, retrying what failed', async () => {
    // Whatever the tests above opened goes out first.
    await fleet.deliver();
    notifier.sent.length = 0;
    const pc = await enrolledInstallation(app);
    notifier.failing = true;
    await beat(pc, { disk: { totalBytes: 1_000, freeBytes: 20 } });
    await fleet.deliver();
    expect(notifier.sent).toEqual([]);
    notifier.failing = false;
    await fleet.deliver();
    expect(notifier.sent).toEqual(['Test Dhaba, Main PC: data drive 98 % full.']);
    await beat(pc, { disk: { totalBytes: 1_000, freeBytes: 500 } });
    await fleet.deliver();
    expect(notifier.sent.at(-1)).toBe(
      'Resolved: Test Dhaba, Main PC: disk use back below the threshold.',
    );
    await fleet.deliver();
    expect(notifier.sent).toHaveLength(2);
  });
});
