import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  ActivationCodeView,
  ApiError,
  AuditListResponse,
  AvailabilityResponse,
  VendorLicenceView,
  VendorReleaseListResponse,
  VendorTenantDetail,
  VendorTenantListResponse,
  VendorTenantView,
} from '@rp/contracts/control-plane';
import { gstinCheckCharacter } from '@rp/domain';
import type { TestDatabase } from '@rp/test-postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { heartbeatBody, signedPost } from '../helpers/fleet.js';
import { createTestApp, createTestDatabase, httpServer } from '../helpers/test-app.js';
import { TestInstallation } from '../helpers/test-installation.js';
import { bearer, signInVendor, vendorAccount } from '../helpers/vendor.js';

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
const tokens: Record<string, string> = {};
let tenant: VendorTenantView;
let installationId: string;
let pc: TestInstallation;

const BASE = '27AAPFU0939F1Z';
const GSTIN = `${BASE}${gstinCheckCharacter(BASE)}`;
const server = () => request(httpServer(app));
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;
const as = (role: string) => bearer(tokens[role] ?? '');

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp(database.url, {
    licenceReactivationKey: randomBytes(32).toString('base64'),
  });
  prisma = app.get(PrismaService);
  for (const role of ['SUPER_ADMIN', 'ONBOARDING', 'SUPPORT', 'FINANCE', 'READ_ONLY'] as const) {
    tokens[role] = await signInVendor(app, await vendorAccount(app, role));
  }
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

async function enrol(installation: TestInstallation, code: string) {
  const response = await server().post('/v1/enrolments').send(installation.enrolRequest(code));
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  installation.id = (response.body as { installationId: string }).installationId;
}

describe('[VCP-002] tenants and installations, by role', () => {
  it('lets Onboarding add a restaurant with its contacts and GSTIN; Read-only only reads', async () => {
    const body = {
      name: 'Spice Route',
      legalName: 'Spice Route Foods LLP',
      gstin: GSTIN.toLowerCase(),
      stateCode: '27',
      contactName: 'Kunal',
      contactEmail: 'Kunal@SpiceRoute.in',
      contactPhone: '+91 98200 00000',
    };
    const byReader = await server().post('/v1/vendor/tenants').set(as('READ_ONLY')).send(body);
    expect([byReader.status, codeOf(byReader)]).toEqual([403, 'FORBIDDEN']);
    const badGstin = await server()
      .post('/v1/vendor/tenants')
      .set(as('ONBOARDING'))
      .send({ ...body, gstin: '27AAPFU0939F1ZZ' });
    expect(badGstin.status).toBe(400);
    const created = await server().post('/v1/vendor/tenants').set(as('ONBOARDING')).send(body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    tenant = VendorTenantView.parse(created.body);
    expect(tenant).toMatchObject({ gstin: GSTIN, contactEmail: 'kunal@spiceroute.in' });
    const list = VendorTenantListResponse.parse(
      (await server().get('/v1/vendor/tenants').set(as('READ_ONLY'))).body,
    );
    expect(list.tenants.map((entry) => entry.name)).toEqual(['Spice Route']);
    const entry = await prisma.auditEntry.findFirstOrThrow({ where: { action: 'tenant.created' } });
    expect(entry.actor).toMatch(/^vendor:/);
  });

  it('activates a PC with the code Onboarding gives, shown on the tenant', async () => {
    const issued = await server()
      .post(`/v1/vendor/tenants/${tenant.id}/installations`)
      .set(as('ONBOARDING'))
      .send({ name: 'Main PC' });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const code = ActivationCodeView.parse(issued.body);
    installationId = code.installationId;
    pc = TestInstallation.create();
    await enrol(pc, code.code);
    const detail = VendorTenantDetail.parse(
      (await server().get(`/v1/vendor/tenants/${tenant.id}`).set(as('SUPPORT'))).body,
    );
    expect(detail.installationList).toMatchObject([{ id: installationId, status: 'ACTIVE' }]);
    const again = await server()
      .post(`/v1/vendor/installations/${installationId}/code`)
      .set(as('ONBOARDING'));
    expect([again.status, codeOf(again)]).toEqual([409, 'ALREADY_ENROLLED']);
  });

  it('[LIC-004] moves an installation to a new PC: the old key is refused once it activates', async () => {
    const refused = await server()
      .post(`/v1/vendor/installations/${installationId}/move`)
      .set(as('FINANCE'))
      .send({ reason: 'New PC' });
    expect(refused.status).toBe(403);
    const moved = await server()
      .post(`/v1/vendor/installations/${installationId}/move`)
      .set(as('SUPPORT'))
      .send({ reason: 'Motherboard failed' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    // The old PC still works until the new one activates.
    expect((await signedPost(app, pc, '/v1/heartbeats', heartbeatBody())).status).toBe(200);
    const newPc = TestInstallation.create();
    await enrol(newPc, ActivationCodeView.parse(moved.body).code);
    expect(newPc.id).toBe(installationId);
    expect((await signedPost(app, pc, '/v1/heartbeats', heartbeatBody())).status).toBe(401);
    expect((await signedPost(app, newPc, '/v1/heartbeats', heartbeatBody())).status).toBe(200);
    expect(await prisma.auditEntry.count({ where: { action: 'installation.moved' } })).toBe(1);
    pc = newPc;
  });
});

describe('[VCP-003] licences, by role', () => {
  it('lets Finance change a licence with a reason; Onboarding cannot', async () => {
    const byOnboarding = await server()
      .patch(`/v1/vendor/installations/${installationId}/licence`)
      .set(as('ONBOARDING'))
      .send({ state: 'PAYMENT_DUE', reason: 'Invoice overdue' });
    expect(byOnboarding.status).toBe(403);
    const changed = await server()
      .patch(`/v1/vendor/installations/${installationId}/licence`)
      .set(as('FINANCE'))
      .send({ state: 'PAYMENT_DUE', reason: 'Invoice 7 overdue' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(VendorLicenceView.parse(changed.body)).toMatchObject({
      state: 'PAYMENT_DUE',
      reason: 'Invoice 7 overdue',
    });
    const backwards = await server()
      .patch(`/v1/vendor/installations/${installationId}/licence`)
      .set(as('FINANCE'))
      .send({ state: 'TERMINATED', reason: 'Contract ended' });
    expect(backwards.status).toBe(200);
    const revived = await server()
      .patch(`/v1/vendor/installations/${installationId}/licence`)
      .set(as('FINANCE'))
      .send({ state: 'ACTIVE', reason: 'Oops' });
    expect([revived.status, codeOf(revived)]).toEqual([409, 'LICENCE_STATE_CHANGE_NOT_ALLOWED']);
  });

  it('gives Support a reactivation code and a re-binding; Read-only neither', async () => {
    const other = await server()
      .post(`/v1/vendor/tenants/${tenant.id}/installations`)
      .set(as('ONBOARDING'))
      .send({ name: 'Second PC' });
    const second = ActivationCodeView.parse(other.body).installationId;
    const until = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const byReader = await server()
      .post(`/v1/vendor/installations/${second}/licence/codes`)
      .set(as('READ_ONLY'))
      .send({ until });
    expect(byReader.status).toBe(403);
    const code = await server()
      .post(`/v1/vendor/installations/${second}/licence/codes`)
      .set(as('SUPPORT'))
      .send({ until });
    expect(code.status, JSON.stringify(code.body)).toBe(200);
    expect(code.body).toMatchObject({ validUntil: until, counter: 1 });
    const rebind = await server()
      .post(`/v1/vendor/installations/${second}/licence/rebind`)
      .set(as('SUPPORT'))
      .send({ reason: 'Disk replaced twice' });
    expect(VendorLicenceView.parse(rebind.body).boundAt).toBeNull();
  });
});

describe('[VCP-006] [VCP-001] releases and the audit trail, by role', () => {
  it('lets only the Super Admin publish; everyone sees the releases', async () => {
    const release = {
      channel: 'PILOT',
      version: '1.2.0',
      url: 'https://downloads.example.com/rp/1.2.0/setup.exe',
      sha256: 'd'.repeat(64),
      sizeBytes: 150_000_000,
    };
    expect(
      (await server().post('/v1/vendor/releases').set(as('FINANCE')).send(release)).status,
    ).toBe(403);
    const published = await server()
      .post('/v1/vendor/releases')
      .set(as('SUPER_ADMIN'))
      .send(release);
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    const list = VendorReleaseListResponse.parse(
      (await server().get('/v1/vendor/releases').set(as('READ_ONLY'))).body,
    );
    expect(list.releases.map((entry) => entry.version)).toEqual(['1.2.0']);
  });

  it('shows Finance the audit trail of an installation; Support cannot see it', async () => {
    expect((await server().get('/v1/vendor/audit').set(as('SUPPORT'))).status).toBe(403);
    const trail = AuditListResponse.parse(
      (
        await server()
          .get('/v1/vendor/audit')
          .query({ targetId: installationId, limit: 50 })
          .set(as('FINANCE'))
      ).body,
    );
    expect(trail.entries.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['installation.created', 'installation.moved', 'licence.changed']),
    );
    expect(trail.entries.every((entry) => entry.targetId === installationId)).toBe(true);
    const page = AuditListResponse.parse(
      (
        await server()
          .get('/v1/vendor/audit')
          .query({ limit: 2, before: trail.entries[0]?.id })
          .set(as('FINANCE'))
      ).body,
    );
    expect(page.entries).toHaveLength(2);
  });
});

describe('[NFR-A02] local availability from the heartbeat history', () => {
  it('shows the days a PC was silent past the threshold, to fleet viewers only', async () => {
    const hour = 3_600_000;
    const start = Date.now() - 6 * hour;
    // A beat every 10 minutes for the first 2 hours, silence for 2 hours, then every 10 minutes.
    const times = [];
    for (let at = start; at <= start + 2 * hour; at += 600_000) times.push(at);
    for (let at = start + 4 * hour; at <= Date.now(); at += 600_000) times.push(at);
    await prisma.heartbeat.createMany({
      data: times.map((at) => ({
        installationId,
        id: randomUUID(),
        sentAt: new Date(at),
        receivedAt: new Date(at),
        payload: {},
      })),
    });
    const url = `/v1/vendor/installations/${installationId}/availability`;
    expect((await server().get(url)).status).toBe(401);
    const response = await server().get(url).query({ days: 2 }).set(as('READ_ONLY'));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const view = AvailabilityResponse.parse(response.body);
    expect(view.targetBp).toBe(9_990);
    expect(view.totals.downMinutes).toBeGreaterThan(60);
    expect(view.totals.availabilityBp).toBeLessThan(9_990);
    expect(view.meetsTarget).toBe(false);
    expect(view.days.length).toBeGreaterThan(0);
    const bad = await server().get(url).query({ days: 0 }).set(as('READ_ONLY'));
    expect(bad.status).toBe(400);
  });
});
