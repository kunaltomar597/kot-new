import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  type DiagnosticsBundle,
  DiagnosticsUploadResponse,
  VendorDiagnosticsDetail,
  VendorDiagnosticsListResponse,
} from '@rp/contracts/control-plane';
import type { TestDatabase } from '@rp/test-postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { enrolledInstallation, signedPost } from '../helpers/fleet.js';
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
