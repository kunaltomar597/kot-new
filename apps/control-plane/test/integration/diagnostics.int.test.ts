import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  type DiagnosticsBundle,
  DiagnosticsRequestListResponse,
  DiagnosticsRequestView,
  HeartbeatResponse,
  DiagnosticsUploadResponse,
  VendorDiagnosticsDetail,
  VendorDiagnosticsListResponse,
} from '@rp/contracts/control-plane';
import type { TestDatabase } from '@rp/test-postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../../src/admin/admin.service.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { DiagnosticsService } from '../../src/diagnostics/diagnostics.service.js';
import { ACTOR, enrolledInstallation, heartbeatBody, signedPost } from '../helpers/fleet.js';
import { createTestApp, createTestDatabase, httpServer } from '../helpers/test-app.js';
import type { TestInstallation } from '../helpers/test-installation.js';
import { bearer, signInVendor, vendorAccount } from '../helpers/vendor.js';

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let pc: TestInstallation;
const tokens: Record<string, string> = {};
const as = (role: string) => bearer(tokens[role] ?? '');
const server = () => request(httpServer(app));

function bundle(lines: string[] = ['2026-10-02 10:00 server started']): DiagnosticsBundle {
  return {
    format: 1,
    generatedAt: new Date().toISOString(),
    installationId: pc.id ?? null,
    versions: [{ name: 'Server', version: '1.4.0' }],
    platform: {
      os: 'win32',
      release: '10.0.26100',
      arch: 'x64',
      cpus: 4,
      memoryMb: 8_192,
      uptimeSeconds: 3_600,
      serverUptimeSeconds: 600,
    },
    configuration: { tls: true, mqtt: true },
    settings: { 'storage.warnPercent': 75 },
    status: { database: { status: 'up' } },
    devices: [
      {
        type: 'KDS',
        name: 'Kitchen screen',
        status: 'ACTIVE',
        online: true,
        lastSeenAt: null,
        appVersion: '1.4.0',
      },
    ],
    logs: { files: [{ name: 'server.log', lines }], truncated: false },
  };
}

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp(database.url);
  prisma = app.get(PrismaService);
  for (const role of ['SUPPORT', 'READ_ONLY'] as const) {
    tokens[role] = await signInVendor(app, await vendorAccount(app, role));
  }
  pc = await enrolledInstallation(app);
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('[UPD-008] [VCP-007] diagnostics bundles', () => {
  let id: string;

  it('takes a bundle a PC sends, with who sent it and why', async () => {
    const response = await signedPost(
      app,
      pc,
      '/v1/diagnostics',
      JSON.stringify({
        bundle: bundle(),
        note: 'Printer in the kitchen stops every evening',
        sentBy: { name: 'Meena', role: 'MANAGER' },
      }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    id = DiagnosticsUploadResponse.parse(response.body).id;
    expect(
      await prisma.auditEntry.count({
        where: { action: 'diagnostics.received', targetId: pc.id ?? '' },
      }),
    ).toBe(1);
  });

  it('lists bundles for every role, and opens one only for Support, audited', async () => {
    const listed = await server()
      .get(`/v1/vendor/installations/${pc.id ?? ''}/diagnostics`)
      .set(as('READ_ONLY'));
    expect(listed.status).toBe(200);
    const [entry] = VendorDiagnosticsListResponse.parse(listed.body).bundles;
    expect(entry).toMatchObject({
      id,
      note: 'Printer in the kitchen stops every evening',
      sentBy: { name: 'Meena', role: 'MANAGER' },
      requestId: null,
    });
    expect((listed.body as { bundles: object[] }).bundles[0]).not.toHaveProperty('bundle');

    expect((await server().get(`/v1/vendor/diagnostics/${id}`).set(as('READ_ONLY'))).status).toBe(
      403,
    );
    const opened = await server().get(`/v1/vendor/diagnostics/${id}`).set(as('SUPPORT'));
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(VendorDiagnosticsDetail.parse(opened.body).bundle.devices[0]?.name).toBe(
      'Kitchen screen',
    );
    const audit = await prisma.auditEntry.findFirstOrThrow({
      where: { action: 'diagnostics.opened' },
    });
    expect(audit).toMatchObject({ targetId: pc.id, details: { bundleId: id } });
    expect(audit.actor).toMatch(/^vendor:/);
  });

  it('[SEC-018] deletes a bundle 30 days after it arrived, audited (threat CP-I2)', async () => {
    const send = async () =>
      DiagnosticsUploadResponse.parse(
        (
          await signedPost(
            app,
            pc,
            '/v1/diagnostics',
            JSON.stringify({ bundle: bundle(), note: null, sentBy: null }),
          )
        ).body,
      ).id;
    const old = await send();
    const recent = await send();
    const now = new Date();
    const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
    await prisma.diagnosticsBundle.update({
      where: { id: old },
      data: { receivedAt: daysAgo(31) },
    });
    await prisma.diagnosticsBundle.update({
      where: { id: recent },
      data: { receivedAt: daysAgo(29) },
    });
    expect(await app.get(DiagnosticsService).purge(now)).toBe(1);
    expect(await prisma.diagnosticsBundle.findUnique({ where: { id: old } })).toBeNull();
    expect(await prisma.diagnosticsBundle.findUnique({ where: { id: recent } })).not.toBeNull();
    expect(
      await prisma.auditEntry.findFirstOrThrow({ where: { action: 'diagnostics.removed' } }),
    ).toMatchObject({
      actor: 'system:retention',
      targetId: pc.id,
      details: { bundleIds: [old], keptDays: 30 },
    });
    const opened = await server().get(`/v1/vendor/diagnostics/${old}`).set(as('SUPPORT'));
    expect(opened.status).toBe(404);
    expect(await app.get(DiagnosticsService).purge(now)).toBe(0);
  });

  it('refuses a bundle larger than 4 MB, and one that is not a bundle', async () => {
    const big = await signedPost(
      app,
      pc,
      '/v1/diagnostics',
      JSON.stringify({
        bundle: bundle(Array.from({ length: 4_500 }, () => 'x'.repeat(1_000))),
        note: null,
        sentBy: null,
      }),
    );
    expect([big.status, ApiError.parse(big.body).code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    const wrong = await signedPost(
      app,
      pc,
      '/v1/diagnostics',
      JSON.stringify({ bundle: { format: 2 }, note: null, sentBy: null }),
    );
    expect(wrong.status).toBe(400);
  });
});

describe('[UPD-008] support asks for diagnostics', () => {
  const ask = (reason: string, role = 'SUPPORT') =>
    server()
      .post(`/v1/vendor/installations/${pc.id ?? ''}/diagnostics-requests`)
      .set(as(role))
      .send({ reason });
  const pending = async () => {
    const answer = await signedPost(app, pc, '/v1/heartbeats', heartbeatBody());
    return HeartbeatResponse.parse(answer.body).diagnosticsRequests;
  };
  const requests = async () =>
    DiagnosticsRequestListResponse.parse(
      (
        await server()
          .get(`/v1/vendor/installations/${pc.id ?? ''}/diagnostics-requests`)
          .set(as('READ_ONLY'))
      ).body,
    ).requests;
  const upload = (requestId: string) =>
    signedPost(
      app,
      pc,
      '/v1/diagnostics',
      JSON.stringify({
        bundle: bundle(),
        note: null,
        sentBy: { name: 'Meena', role: 'MANAGER' },
        requestId,
      }),
    );

  it('reaches the PC in heartbeats until its manager declines it', async () => {
    expect((await ask('Orders stuck', 'READ_ONLY')).status).toBe(403);
    const asked = await ask('Bills print twice since Tuesday');
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const request = DiagnosticsRequestView.parse(asked.body);
    expect(request).toMatchObject({
      state: 'PENDING',
      requestedBy: expect.stringMatching(/^Staff /) as unknown,
    });
    expect((await pending()).map((entry) => entry.reason)).toEqual([
      'Bills print twice since Tuesday',
    ]);

    const declined = await signedPost(
      app,
      pc,
      `/v1/diagnostics-requests/${request.id}/decline`,
      JSON.stringify({ by: { name: 'Meena', role: 'MANAGER' } }),
    );
    expect(declined.status, JSON.stringify(declined.body)).toBe(204);
    expect(await pending()).toEqual([]);
    expect((await requests())[0]).toMatchObject({
      state: 'DECLINED',
      answeredBy: { name: 'Meena', role: 'MANAGER' },
      bundleId: null,
    });
    const again = await signedPost(
      app,
      pc,
      `/v1/diagnostics-requests/${request.id}/decline`,
      JSON.stringify({ by: { name: 'Meena', role: 'MANAGER' } }),
    );
    expect([again.status, ApiError.parse(again.body).code]).toEqual([
      409,
      'DIAGNOSTICS_REQUEST_CLOSED',
    ]);
    expect(
      await prisma.auditEntry.count({ where: { action: 'diagnostics.request_declined' } }),
    ).toBe(1);
  });

  it('is fulfilled by the bundle sent for it, once', async () => {
    const request = DiagnosticsRequestView.parse((await ask('Printer stops')).body);
    const sent = await upload(request.id);
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const [latest] = await requests();
    expect(latest).toMatchObject({
      id: request.id,
      state: 'FULFILLED',
      bundleId: DiagnosticsUploadResponse.parse(sent.body).id,
    });
    const twice = await upload(request.id);
    expect([twice.status, ApiError.parse(twice.body).code]).toEqual([
      409,
      'DIAGNOSTICS_REQUEST_CLOSED',
    ]);
  });

  it('lapses after 7 days, and is only for an activated PC', async () => {
    const diagnostics = app.get(DiagnosticsService);
    const user = await prisma.vendorUser.findFirstOrThrow();
    const old = await diagnostics.request(
      pc.id ?? '',
      'Old question',
      { userId: user.id, actor: `vendor:${user.id}` },
      new Date(Date.now() - 8 * 86_400_000),
    );
    expect((await requests()).find((entry) => entry.id === old.id)?.state).toBe('EXPIRED');
    expect(await pending()).toEqual([]);
    expect((await upload(old.id)).status).toBe(409);

    const admin = app.get(AdminService);
    const tenant = await admin.createTenant('Not yet open', ACTOR);
    const waiting = await admin.createInstallation({ tenantId: tenant.id, name: 'New PC' }, ACTOR);
    const refused = await server()
      .post(`/v1/vendor/installations/${waiting.installationId}/diagnostics-requests`)
      .set(as('SUPPORT'))
      .send({ reason: 'Hello' });
    expect([refused.status, ApiError.parse(refused.body).code]).toEqual([
      409,
      'INSTALLATION_NOT_ACTIVE',
    ]);
  });
});
