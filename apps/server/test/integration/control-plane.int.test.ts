import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
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
import { readOfferedUpdate } from '../../src/cloud/control-plane-state.js';
import { enrolInstallation } from '../../src/cloud/enrolment.js';
import {
  CONTROL_PLANE_OPTIONS,
  type ControlPlaneOptions,
  HeartbeatService,
} from '../../src/cloud/heartbeat.service.js';
import { installationKey } from '../../src/cloud/installation-key.js';
import { APP_CONFIG, type AppConfig } from '../../src/config/app-config.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, testAdminUrl } from '../helpers/test-database.js';
import { until } from '../helpers/wait.js';

/**
 * P0-17 acceptance: the real local server enrols with a real Vendor Control Plane, posts
 * heartbeats and discovers a release published after it started (VCP-005, UPD-002). Without the
 * Control Plane the server keeps working and reports again when it is back (NFR-A01).
 */

const ACTOR = 'ci:acceptance';
const OPTIONS: ControlPlaneOptions = {
  firstHeartbeatDelayMs: 50,
  // Long enough that only the test's own calls send heartbeats after the first.
  defaultIntervalMs: 60_000,
  requestTimeoutMs: 5_000,
};

let serverDatabase: TestDatabase;
let cpDatabase: TestDatabase;
let controlPlane: INestApplication;
let cpPort: number;
let server: INestApplication;
let heartbeats: HeartbeatService;
let prisma: PrismaService;
let code: string;
let installationId: string;

async function startControlPlane(port = 0): Promise<INestApplication> {
  const app = await createControlPlaneApp(
    CpConfigSchema.parse({ databaseUrl: cpDatabase.url, logLevel: 'silent' }),
  );
  await app.listen(port, '127.0.0.1');
  return app;
}

function portOf(app: INestApplication): number {
  const address = (app.getHttpServer() as Server).address();
  if (address === null || typeof address === 'string') throw new Error('Not listening');
  return address.port;
}

beforeAll(async () => {
  serverDatabase = await createTestDatabase();
  cpDatabase = await createMigratedDatabase({
    adminUrl: testAdminUrl(),
    runId: inject('pgRunId'),
    prefix: 'rp',
    migrationsDir: CONTROL_PLANE_MIGRATIONS_DIR,
  });
  controlPlane = await startControlPlane();
  cpPort = portOf(controlPlane);

  const admin = controlPlane.get(AdminService);
  const tenant = await admin.createTenant('Acceptance Dhaba', ACTOR);
  const issued = await admin.createInstallation({ tenantId: tenant.id, name: 'Counter PC' }, ACTOR);
  code = issued.code;
  installationId = issued.installationId;

  server = await createTestApp({
    databaseUrl: serverDatabase.url,
    config: { controlPlaneUrl: `http://127.0.0.1:${String(cpPort)}`, productVersion: '1.0.0' },
    overrides: [{ provide: CONTROL_PLANE_OPTIONS, useValue: OPTIONS }],
  });
  heartbeats = server.get(HeartbeatService);
  prisma = server.get(PrismaService);
  await prisma.restaurant.create({ data: { displayName: 'Acceptance Dhaba' } });
});

afterAll(async () => {
  await server.close();
  await controlPlane.close();
  await serverDatabase.drop();
  await cpDatabase.drop();
});

describe('[VCP-005] [SEC-002] enrolment and heartbeats (P0-17)', () => {
  it('waits for enrolment: the scheduled heartbeat sends nothing until then', async () => {
    const status = await until(() => {
      const current = heartbeats.status();
      return current.lastError === 'NOT_ENROLLED' ? current : undefined;
    });
    expect(status).toMatchObject({ configured: true, installationId: null, lastSuccessAt: null });
  });

  it('enrols with the vendor code as people type it, once', async () => {
    const config = server.get<AppConfig>(APP_CONFIG);
    const secrets = server.get<SecretStore>(SECRET_STORE);
    const typed = code.toLowerCase().replaceAll('-', ' ');
    const enrolment = await enrolInstallation({ config, prisma, secrets, code: typed });
    expect(enrolment).toMatchObject({ installationId, name: 'Counter PC', channel: 'STABLE' });

    // The Control Plane now knows this PC by its Ed25519 public key (heartbeats below prove the
    // signatures verify); the private key stays in this PC's secret store.
    const cpInstallation = await controlPlane
      .get(AdminService)
      .listInstallations()
      .then((all) => all.find((installation) => installation.id === installationId));
    expect(cpInstallation?.status).toBe('ACTIVE');
    expect((await installationKey(secrets)).publicKeySpki).toMatch(/^MCowBQYDK2VwAyEA/);

    // AUD-001: the local audit log records it.
    const audit = await prisma.auditLog.findFirst({ where: { action: 'INSTALLATION_ENROLLED' } });
    expect(audit?.entityId).toBe(installationId);

    await expect(enrolInstallation({ config, prisma, secrets, code })).rejects.toThrow(
      /already enrolled/,
    );
  });

  it('posts heartbeats the Control Plane accepts, with versions, disk and audit head', async () => {
    const status = await heartbeats.beat();
    expect(status).toMatchObject({ installationId, lastError: null, offeredUpdate: null });
    expect(status.lastSuccessAt).not.toBeNull();
    expect(Math.abs(status.clockOffsetMs ?? Infinity)).toBeLessThan(5_000);

    const [listed] = await controlPlane.get(AdminService).listInstallations();
    expect(listed).toMatchObject({ id: installationId, version: '1.0.0' });
    expect(listed?.lastSeenAt).not.toBeNull();
  });

  it('[UPD-002] discovers a release published after it started, and remembers it', async () => {
    await controlPlane.get(AdminService).publishRelease(
      {
        component: 'RESTAURANT_PC',
        channel: 'STABLE',
        version: '1.1.0',
        url: 'https://downloads.example.com/rp/1.1.0/setup.exe',
        sha256: 'e'.repeat(64),
        sizeBytes: 170_000_000,
      },
      ACTOR,
    );
    const status = await heartbeats.beat();
    expect(status.offeredUpdate).toMatchObject({ version: '1.1.0', channel: 'STABLE' });
    expect(await readOfferedUpdate(prisma)).toMatchObject({ version: '1.1.0' });
  });

  it('[NFR-A01] keeps working while the Control Plane is down and reports again when it is back', async () => {
    await controlPlane.close();
    const offline = await heartbeats.beat();
    expect(offline.lastError).toBe('UNREACHABLE');
    // Local operation is unaffected.
    expect((await request(httpServer(server)).get('/api/v1/health')).status).toBe(200);

    controlPlane = await startControlPlane(cpPort);
    const back = await heartbeats.beat();
    expect(back.lastError).toBeNull();
    expect(back.offeredUpdate).toMatchObject({ version: '1.1.0' });
  });

  it('stops being accepted once the vendor revokes the installation', async () => {
    await controlPlane.get(AdminService).revokeInstallation(installationId, 'Test', ACTOR);
    const status = await heartbeats.beat();
    expect(status.lastError).toBe('INSTALLATION_REVOKED');
    expect((await request(httpServer(server)).get('/api/v1/health')).status).toBe(200);
  });
});
