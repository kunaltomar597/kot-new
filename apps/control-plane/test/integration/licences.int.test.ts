import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { HeartbeatResponse, type LicencePayload } from '@rp/contracts/control-plane';
import {
  fingerprintOf,
  reactivationSecretOf,
  readReactivationCode,
  verifyLicence,
} from '@rp/licensing';
import type { TestDatabase } from '@rp/test-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../../src/admin/admin.service.js';
import { runCli } from '../../src/cli.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { LicencesService } from '../../src/licences/licences.service.js';
import { ACTOR, enrolledInstallation, heartbeatBody, signedPost } from '../helpers/fleet.js';
import { createTestApp, createTestDatabase } from '../helpers/test-app.js';
import type { TestInstallation } from '../helpers/test-installation.js';

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let licences: LicencesService;
let pc: TestInstallation;
const vendor = generateKeyPairSync('ed25519');
const VENDOR_PUBLIC = vendor.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const MASTER = randomBytes(32);

const identifiers = {
  MACHINE_ID: 'm-1',
  BOARD_SERIAL: 'b-1',
  BIOS_UUID: 'u-1',
  DISK_SERIAL: 'd-1',
  CPU_ID: 'c-1',
};
const fingerprint = (changes: Partial<typeof identifiers> = {}) =>
  fingerprintOf(pc.id ?? '', { ...identifiers, ...changes });

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp(database.url, {
    heartbeatSeconds: 300,
    licenceSigningKey: vendor.privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64'),
    licenceReactivationKey: MASTER.toString('base64'),
  });
  prisma = app.get(PrismaService);
  licences = app.get(LicencesService);
  pc = await enrolledInstallation(app);
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

async function beat(licence: object) {
  const response = await signedPost(app, pc, '/v1/heartbeats', heartbeatBody({ licence }));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return HeartbeatResponse.parse(response.body);
}

const report = (licenceId: string | null, print = fingerprint(), hasSecret = true) => ({
  licenceId,
  fingerprint: print,
  hasReactivationSecret: hasSecret,
});

function payloadOf(answer: HeartbeatResponse): LicencePayload {
  const verified = verifyLicence(answer.licence ?? undefined, [VENDOR_PUBLIC]);
  if (!verified.ok) throw new Error(`Not a valid licence: ${verified.problem}`);
  return verified.payload;
}

let first: LicencePayload;

describe('[LIC-001] [LIC-002] [ONB-003] licences in heartbeats', () => {
  it('issues a signed licence for the enrolled PC, bound to its fingerprint', async () => {
    const answer = await beat(report(null, fingerprint(), false));
    first = payloadOf(answer);
    const tenant = await prisma.installation.findUniqueOrThrow({ where: { id: pc.id ?? '' } });
    expect(first).toMatchObject({
      installationId: pc.id,
      tenantId: tenant.tenantId,
      fingerprint: fingerprint(),
      state: 'ACTIVE',
      plan: 'Standard',
      graceDays: 7,
      deviceLimits: { TABLE_TABLET: 30, PAGER: 15, WAITER_PHONE: 15, KDS: 6 },
    });
    expect(Date.parse(first.validUntil) - Date.parse(first.issuedAt)).toBe(30 * 86_400_000);
    // The secret for offline reactivation codes, sent once to the PC that lacks it.
    expect(answer.reactivationSecret).toBe(
      reactivationSecretOf(MASTER, pc.id ?? '').toString('base64'),
    );
    expect(answer.nextHeartbeatSeconds).toBe(300);
    expect(await prisma.auditEntry.count({ where: { action: 'licence.bound' } })).toBe(1);
  });

  it('sends nothing new while the licence is current, and the same one again if lost', async () => {
    const same = await beat(report(first.licenceId));
    expect([same.licence, same.reactivationSecret]).toEqual([null, null]);
    const lost = await beat(report(null));
    expect(payloadOf(lost).licenceId).toBe(first.licenceId);
    expect(await prisma.licenceFile.count()).toBe(1);
  });

  it('renews it once a day while online', async () => {
    const tomorrow = new Date(Date.now() + 25 * 3_600_000);
    const installation = { id: pc.id ?? '', tenantId: first.tenantId, channel: 'STABLE' as const };
    const renewed = await licences.forHeartbeat(installation, report(first.licenceId), tomorrow);
    const payload = payloadOf(
      HeartbeatResponse.parse({
        receivedAt: tomorrow.toISOString(),
        serverTime: tomorrow.toISOString(),
        nextHeartbeatSeconds: 300,
        update: null,
        licence: renewed.licence,
      }),
    );
    expect(payload.licenceId).not.toBe(first.licenceId);
    expect(payload.validUntil).toBe(new Date(tomorrow.getTime() + 30 * 86_400_000).toISOString());
    first = payload;
  });
});

describe('[LIC-005] [LIC-006] [VCP-003] the vendor changes a licence', () => {
  it('carries a new state at the next heartbeat, and asks for heartbeats every minute', async () => {
    const code = await runCli(
      [
        'licence:set',
        '--installation',
        pc.id ?? '',
        '--state',
        'GRACE',
        '--reason',
        'Invoice 42 overdue',
      ],
      { admin: app.get(AdminService), licences, actor: ACTOR, out: () => undefined },
    );
    expect(code).toBe(0);
    const answer = await beat(report(first.licenceId));
    const grace = payloadOf(answer);
    expect(grace).toMatchObject({ state: 'GRACE', reason: 'Invoice 42 overdue' });
    expect(grace.graceStartedAt).not.toBeNull();
    expect(answer.nextHeartbeatSeconds).toBe(60);
    expect(
      await prisma.auditEntry.findFirstOrThrow({ where: { action: 'licence.changed' } }),
    ).toMatchObject({
      actor: ACTOR,
      details: {
        reason: 'Invoice 42 overdue',
        before: { state: 'ACTIVE' },
        after: { state: 'GRACE' },
      },
    });

    // Payment recorded: active again at the next heartbeat (within a minute).
    await licences.change(pc.id ?? '', { state: 'ACTIVE', reason: 'Paid by UPI' }, ACTOR);
    const paid = await beat(report(grace.licenceId));
    expect(payloadOf(paid)).toMatchObject({ state: 'ACTIVE', graceStartedAt: null });
    expect(paid.nextHeartbeatSeconds).toBe(300);
    first = payloadOf(paid);
  });

  it('follows LIC-005: never out of a terminated contract, and always with a reason', async () => {
    await expect(
      licences.change(pc.id ?? '', { state: 'ACTIVE', reason: 'x' }, ACTOR),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const other = await enrolledInstallation(app);
    await licences.change(other.id ?? '', { state: 'TERMINATED', reason: 'Contract ended' }, ACTOR);
    await expect(
      licences.change(other.id ?? '', { state: 'ACTIVE', reason: 'Oops' }, ACTOR),
    ).rejects.toMatchObject({ code: 'LICENCE_STATE_CHANGE_NOT_ALLOWED' });
    // Device limits and days change too.
    const summary = await licences.change(
      pc.id ?? '',
      {
        reason: 'Upgraded plan',
        plan: 'Large',
        deviceLimits: { TABLE_TABLET: 60, PAGER: 30, WAITER_PHONE: 30, KDS: 10 },
        validityDays: 45,
      },
      ACTOR,
    );
    expect(summary).toMatchObject({ plan: 'Large', validityDays: 45, state: 'ACTIVE' });
    const upgraded = payloadOf(await beat(report(first.licenceId)));
    expect(upgraded.deviceLimits.TABLE_TABLET).toBe(60);
    first = upgraded;
  });

  it('[LIC-006] gives an offline reactivation code once, readable only by that PC', async () => {
    const until = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const lines: string[] = [];
    const code = await runCli(['licence:code', '--installation', pc.id ?? '', '--until', until], {
      admin: app.get(AdminService),
      licences,
      actor: ACTOR,
      out: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    const shown = /: ([0-9A-Z-]{19})$/.exec(lines[0] ?? '')?.[1] ?? '';
    const secret = reactivationSecretOf(MASTER, pc.id ?? '');
    expect(readReactivationCode(shown, secret, pc.id ?? '')).toEqual({
      validUntil: until,
      counter: 1,
    });
    const second = await licences.reactivationCode(pc.id ?? '', until, ACTOR);
    expect(second.counter).toBe(2);
    const audit = await prisma.auditEntry.findFirstOrThrow({
      where: { action: 'licence.reactivation_code' },
    });
    expect(JSON.stringify(audit.details)).not.toContain(shown);
    await expect(licences.reactivationCode(pc.id ?? '', '2020-01-01', ACTOR)).rejects.toMatchObject(
      {
        code: 'VALIDATION_FAILED',
      },
    );
  });
});

describe('[LIC-004] the PC the licence is bound to', () => {
  it('follows one part changed, refuses another PC until support re-binds it', async () => {
    const newDisk = fingerprint({ DISK_SERIAL: 'd-2' });
    const followed = payloadOf(await beat(report(first.licenceId, newDisk)));
    expect(followed.fingerprint).toEqual(newDisk);

    const otherPc = fingerprint({ MACHINE_ID: 'm-9', BOARD_SERIAL: 'b-9', BIOS_UUID: 'u-9' });
    const refused = await beat(report(null, otherPc));
    expect(refused.licence).toBeNull();

    await licences.rebind(pc.id ?? '', 'Motherboard replaced', ACTOR);
    const rebound = payloadOf(await beat(report(null, otherPc)));
    expect(rebound.fingerprint).toEqual(otherPc);
    expect(await prisma.auditEntry.count({ where: { action: 'licence.rebound' } })).toBe(1);
  });

  it('[LIC-007] records what the PC reports as tampering, once per heartbeat', async () => {
    const body = heartbeatBody({
      licence: report(null),
      tamper: [{ kind: 'CLOCK_ROLLBACK', at: '2026-10-03T10:00:00.000Z' }],
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await signedPost(app, pc, '/v1/heartbeats', body)).status).toBe(200);
    }
    expect(await prisma.auditEntry.findMany({ where: { action: 'licence.tamper' } })).toMatchObject(
      [{ details: { kind: 'CLOCK_ROLLBACK' } }],
    );
  });

  it('[LIC-004] binds and renews nothing on a fingerprint read of fewer than three identifiers', async () => {
    const fresh = await enrolledInstallation(app);
    const beatAs = async (licence: object) => {
      const response = await signedPost(app, fresh, '/v1/heartbeats', heartbeatBody({ licence }));
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return HeartbeatResponse.parse(response.body);
    };
    const full = fingerprintOf(fresh.id ?? '', identifiers);
    const partial = fingerprintOf(fresh.id ?? '', { MACHINE_ID: 'm-1', CPU_ID: 'c-1' });
    expect((await beatAs(report(null, partial))).licence).toBeNull();
    expect(
      (await prisma.installationLicence.findUniqueOrThrow({ where: { installationId: fresh.id } }))
        .boundAt,
    ).toBeNull();
    const bound = payloadOf(await beatAs(report(null, full)));
    expect(bound.fingerprint).toEqual(full);
    // A failed read later: no licence for it, and the binding stays as it was.
    expect((await beatAs(report(null, partial))).licence).toBeNull();
    expect(
      (await prisma.installationLicence.findUniqueOrThrow({ where: { installationId: fresh.id } }))
        .fingerprint,
    ).toEqual(full);
  });

  it('[LIC-006] [SEC-015] checks the code a PC took against those issued, and alerts on another', async () => {
    const until = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const issued = await licences.reactivationCode(pc.id ?? '', until, ACTOR);
    const row = await prisma.licenceReactivationCode.findUniqueOrThrow({
      where: { installationId_counter: { installationId: pc.id ?? '', counter: issued.counter } },
    });
    expect(row).toMatchObject({ issuedBy: ACTOR, usedAt: null });
    await beat({ ...report(null), reactivation: { counter: issued.counter, validUntil: until } });
    expect(
      (
        await prisma.licenceReactivationCode.findUniqueOrThrow({
          where: {
            installationId_counter: { installationId: pc.id ?? '', counter: issued.counter },
          },
        })
      ).usedAt,
    ).not.toBeNull();
    expect(await prisma.auditEntry.count({ where: { action: 'licence.reactivation_used' } })).toBe(
      1,
    );
    expect(
      await prisma.fleetAlert.count({
        where: { installationId: pc.id, kind: 'LICENCE_TAMPERING' },
      }),
    ).toBe(0);

    // A code with a counter the vendor never gave, or another day: made with the PC's secret.
    await beat({
      ...report(null),
      reactivation: { counter: issued.counter, validUntil: '2026-12-31' },
    });
    const alert = await prisma.fleetAlert.findFirstOrThrow({
      where: { installationId: pc.id, kind: 'LICENCE_TAMPERING', resolvedAt: null },
    });
    expect(alert.details).toMatchObject({
      kinds: ['REACTIVATION_CODE_NOT_ISSUED'],
      reactivation: { counter: issued.counter, validUntil: '2026-12-31' },
    });
    expect(
      await prisma.auditEntry.findFirstOrThrow({
        where: { action: 'licence.reactivation_unknown' },
      }),
    ).toMatchObject({ details: { issuedValidUntil: until } });
    // No code reaches past 60 days.
    const tooFar = new Date(Date.now() + 61 * 86_400_000).toISOString().slice(0, 10);
    await expect(licences.reactivationCode(pc.id ?? '', tooFar, ACTOR)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('sends no licence to an installation too old to report one', async () => {
    const answer = await beat(undefined as unknown as object);
    expect(answer.licence).toBeNull();
  });
});
