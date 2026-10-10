import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  AdminService,
  CONTROL_PLANE_MIGRATIONS_DIR,
  CpConfigSchema,
  createControlPlaneApp,
  DiagnosticsService as CpDiagnosticsService,
  FleetService,
  RemoteSettingsService,
  SupportService,
} from '@rp/control-plane/testing';
import { startRelay, type TestRelay } from '@rp/relay/testing';
import { createMigratedDatabase, type TestDatabase } from '@rp/test-postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { SendDiagnosticsResponse } from '@rp/contracts';
import pg from 'pg';
import type * as ServerFiles from '../../src/integrity/server-files.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { SECRET_STORE, type SecretStore } from '../../src/auth/secret-store.js';
import { readOfferedUpdate } from '../../src/cloud/control-plane-state.js';
import { readUpdateReport, saveUpdateReport } from '../../src/updates/update-state.js';
import {
  firmwareHeartbeat,
  readOfferedFirmware,
  saveFirmwareReport,
  saveServedFirmware,
} from '../../src/pager-firmware/firmware-state.js';
import { enrolInstallation } from '../../src/cloud/enrolment.js';
import {
  CONTROL_PLANE_OPTIONS,
  type ControlPlaneOptions,
  HeartbeatService,
} from '../../src/cloud/heartbeat.service.js';
import { installationKey } from '../../src/cloud/installation-key.js';
import { APP_CONFIG, type AppConfig } from '../../src/config/app-config.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { LicenceAgentService } from '../../src/licensing/licence-agent.service.js';
import { SettingsService } from '../../src/settings/settings.service.js';
import { readRelayCredential } from '../../src/relay/relay-credential.js';
import { authHeaders, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, testAdminUrl } from '../helpers/test-database.js';
import { until } from '../helpers/wait.js';

// LICENCE-T5: this server has a product version (it is "installed") but no list of its files, which
// would be reported as tampering; the check itself is tested in server-files.test.ts.
vi.mock('../../src/integrity/server-files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ServerFiles>()),
  checkServerFiles: () => Promise.resolve('intact' as const),
}));

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
let tenantId: string;
let relay: TestRelay;
/** The vendor's licence key for this test; production keeps it in the cloud KMS. */
const vendor = generateKeyPairSync('ed25519');
const VENDOR_KEY = vendor.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

async function startControlPlane(port = 0): Promise<INestApplication> {
  const app = await createControlPlaneApp(
    CpConfigSchema.parse({
      databaseUrl: cpDatabase.url,
      logLevel: 'silent',
      billingIntervalMinutes: 0,
      licenceSigningKey: vendor.privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64'),
      relayDatabaseUrl: relay.databaseUrl,
      fleetSweepSeconds: 0,
    }),
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
  relay = await startRelay({ adminUrl: testAdminUrl(), runId: inject('pgRunId') });
  controlPlane = await startControlPlane();
  cpPort = portOf(controlPlane);

  const admin = controlPlane.get(AdminService);
  const tenant = await admin.createTenant('Acceptance Dhaba', ACTOR);
  tenantId = tenant.id;
  const issued = await admin.createInstallation({ tenantId: tenant.id, name: 'Counter PC' }, ACTOR);
  code = issued.code;
  installationId = issued.installationId;

  server = await createTestApp({
    databaseUrl: serverDatabase.url,
    config: {
      controlPlaneUrl: `http://127.0.0.1:${String(cpPort)}`,
      productVersion: '1.0.0',
      licenceKeys: [VENDOR_KEY],
    },
    overrides: [{ provide: CONTROL_PLANE_OPTIONS, useValue: OPTIONS }],
  });
  heartbeats = server.get(HeartbeatService);
  prisma = server.get(PrismaService);
  await prisma.restaurant.create({ data: { displayName: 'Acceptance Dhaba' } });
});

let managerHeaders: Record<string, string> | undefined;
/** A manager signed in on a console of this PC's restaurant (made once). */
async function asManager(): Promise<Record<string, string>> {
  if (managerHeaders === undefined) {
    const restaurant = await prisma.restaurant.findFirstOrThrow();
    const kit = await createAuthKit(server, { restaurantId: restaurant.id });
    const manager = await signIn(server, kit, 'MANAGER');
    managerHeaders = authHeaders(kit.deviceId, manager.accessToken);
  }
  return managerHeaders;
}

afterAll(async () => {
  await server.close();
  await controlPlane.close();
  await relay.stop();
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

  it('[LIC-001] [VCP-002] receives its signed licence and its QR relay credential in heartbeats', async () => {
    await controlPlane.get(SupportService).provisionRelay(tenantId, ACTOR);
    expect((await heartbeats.beat()).lastError).toBeNull();
    const licence = await server.get(LicenceAgentService).view(true);
    expect(licence).toMatchObject({ state: 'ACTIVE', problem: null, details: { installationId } });
    const secrets = server.get<SecretStore>(SECRET_STORE);
    const credential = await readRelayCredential(prisma, secrets);
    expect(credential).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    // The relay knows the restaurant by it.
    const known = await relay.admin.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM relay.verify_credential($1)',
      [credential],
    );
    expect(known.rows[0]?.tenant_id).toBe(tenantId);
    // The next heartbeat says the PC holds it: delivered, and not sent again.
    await heartbeats.beat();
    expect((await controlPlane.get(SupportService).relayProvisioning(tenantId)).delivered).toBe(
      true,
    );
  });

  it('[AUD-003] [VCP-005] answers audit checks with the hashes it holds; a rewritten log is caught', async () => {
    const audit = server.get(AuditService);
    const fleet = controlPlane.get(FleetService);
    const record = (action: string) =>
      prisma.transaction((tx) => audit.record(tx, { action, entityType: 'test', reason: 'P7-03' }));
    await record('ACCEPTANCE_ONE');
    await heartbeats.beat();
    await record('ACCEPTANCE_TWO');
    // The answer asks about an earlier head; the next heartbeat answers with the hash it holds.
    await heartbeats.beat();
    await heartbeats.beat();
    const heads = await fleet.auditHeads(installationId);
    expect(heads.some((head) => head.verifiedAt !== null)).toBe(true);
    const view = (await fleet.fleet()).installations.find(
      (entry) => entry.installationId === installationId,
    );
    // No backup made yet (P7-05a): nothing has failed.
    expect(view).toMatchObject({
      online: true,
      errorCount: 0,
      openAlerts: [],
      backup: { lastSuccessAt: null, lastFailureAt: null, lastError: null },
    });
    expect(view?.auditHead?.verifiedAt).not.toBeNull();

    // Someone with access to the database rewrites every entry but the newest (and so every hash
    // after the first change): the head still looks right, the answer to the check does not.
    await record('ACCEPTANCE_THREE');
    await heartbeats.beat();
    const client = new pg.Client({ connectionString: serverDatabase.url });
    await client.connect();
    try {
      await client.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_guard');
      await client.query(
        `UPDATE audit_log SET hash = encode(sha256(convert_to(hash, 'UTF8')), 'hex')
         WHERE chain_seq < (SELECT max(chain_seq) FROM audit_log)`,
      );
      await client.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_guard');
    } finally {
      await client.end();
    }
    await heartbeats.beat();
    const alerts = await fleet.alerts({ state: 'OPEN', installationId });
    expect(alerts.map((alert) => alert.kind)).toEqual(['AUDIT_CHAIN_MISMATCH']);
    expect(alerts[0]?.details).toMatchObject({ reason: 'REWRITTEN', byAuditCheck: true });
  });

  it('[UPD-008] [VCP-007] sends a manager’s diagnostics to support, who can open them', async () => {
    const sent = await request(httpServer(server))
      .post('/api/v1/system/diagnostics')
      .set(await asManager())
      .send({ note: 'The kitchen printer stops at night' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const { id } = SendDiagnosticsResponse.parse(sent.body);
    const diagnostics = controlPlane.get(CpDiagnosticsService);
    const [listed] = await diagnostics.list(installationId);
    expect(listed).toMatchObject({
      id,
      note: 'The kitchen printer stops at night',
      sentBy: { name: 'Test manager', role: 'MANAGER' },
    });
    const opened = await diagnostics.open(id, 'vendor:acceptance');
    expect(opened.bundle).toMatchObject({
      installationId,
      configuration: { productVersion: '1.0.0' },
    });
    expect(
      await prisma.auditLog.count({ where: { action: 'DIAGNOSTICS_SENT', entityId: id } }),
    ).toBe(1);
  });

  it('[UPD-008] lets a manager answer support’s requests: one allowed, one declined', async () => {
    const diagnostics = controlPlane.get(CpDiagnosticsService);
    const support = { userId: randomUUID(), actor: 'vendor:support' };
    const first = await diagnostics.request(installationId, 'Bills print twice', support);
    await heartbeats.beat();
    const headers = await asManager();
    const listed = await request(httpServer(server))
      .get('/api/v1/system/diagnostics/requests')
      .set(headers);
    expect(listed.body).toMatchObject({
      requests: [{ id: first.id, reason: 'Bills print twice' }],
    });
    // The Owner and the managers on duty are alerted.
    const alert = await prisma.alert.findFirstOrThrow({
      where: { type: 'SUPPORT_REQUEST', status: 'OPEN' },
    });
    expect(alert.payload).toMatchObject({ requestId: first.id, reason: 'Bills print twice' });

    const allowed = await request(httpServer(server))
      .post(`/api/v1/system/diagnostics/requests/${first.id}/allow`)
      .set(headers);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    const [answered] = await diagnostics.requests(installationId);
    expect(answered).toMatchObject({
      id: first.id,
      state: 'FULFILLED',
      bundleId: (allowed.body as { id: string }).id,
      answeredBy: { name: 'Test manager', role: 'MANAGER' },
    });
    expect(await prisma.alert.count({ where: { type: 'SUPPORT_REQUEST', status: 'OPEN' } })).toBe(
      0,
    );

    const second = await diagnostics.request(installationId, 'Just checking', support);
    await heartbeats.beat();
    const declined = await request(httpServer(server))
      .post(`/api/v1/system/diagnostics/requests/${second.id}/decline`)
      .set(headers);
    expect(declined.status, JSON.stringify(declined.body)).toBe(204);
    const [latest] = await diagnostics.requests(installationId);
    expect(latest).toMatchObject({ id: second.id, state: 'DECLINED', bundleId: null });
    expect(
      (await request(httpServer(server)).get('/api/v1/system/diagnostics/requests').set(headers))
        .body,
    ).toEqual({ requests: [] });
    expect(await prisma.auditLog.count({ where: { action: 'DIAGNOSTICS_REQUEST_DECLINED' } })).toBe(
      1,
    );
  });

  it('[UPD-010] applies the vendor’s settings and feature flags, and the flag gates AI import', async () => {
    const remote = controlPlane.get(RemoteSettingsService);
    await remote.setFleet({ 'qr.pickupTimeoutSeconds': 90 }, 'Pilot tuning', 'vendor:admin');
    const view = await remote.setInstallation(
      installationId,
      { 'features.aiMenuImport': false },
      'AI provider down for this restaurant',
      'vendor:admin',
    );
    await heartbeats.beat();
    const restaurant = await prisma.restaurant.findFirstOrThrow();
    const settings = await server.get(SettingsService).snapshot(restaurant.id);
    expect(settings.get('qr.pickupTimeoutSeconds')).toBe(90);
    expect(settings.get('features.aiMenuImport')).toBe(false);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'VENDOR_SETTINGS_APPLIED' },
    });
    expect(audit.after).toEqual({ 'qr.pickupTimeoutSeconds': 90, 'features.aiMenuImport': false });
    // The next heartbeat reports holding them; nothing more is pushed.
    await heartbeats.beat();
    expect((await remote.installation(installationId)).appliedDigest).toBe(view.digest);

    const headers = await asManager();
    const ai = await request(httpServer(server))
      .post('/api/v1/menu/ai-imports')
      .set(headers)
      .send({ files: [{ name: 'menu.jpg', contentType: 'image/jpeg', contentBase64: 'AAAA' }] });
    expect([ai.status, (ai.body as { code: string }).code]).toEqual([409, 'FEATURE_OFF']);
    // Managers see the vendor's value but cannot change it.
    const change = await request(httpServer(server))
      .put('/api/v1/settings/qr.pickupTimeoutSeconds')
      .set(headers)
      .send({ value: 60 });
    expect(change.status).toBe(403);

    // Taken back by the vendor: the default returns.
    await remote.setInstallation(installationId, {}, 'Provider is back', 'vendor:admin');
    await heartbeats.beat();
    server.get(SettingsService).invalidate();
    expect(
      (await server.get(SettingsService).snapshot(restaurant.id)).get('features.aiMenuImport'),
    ).toBe(true);
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

  it('[UPD-003] [UPD-005] reports how an update went until the Control Plane has it', async () => {
    const at = new Date().toISOString();
    await saveUpdateReport(prisma, {
      version: '1.1.0',
      outcome: 'ROLLED_BACK',
      at,
      error: 'Version 1.1.0 did not pass its health check.',
    });
    expect((await heartbeats.beat()).lastError).toBeNull();
    const client = new pg.Client({ connectionString: cpDatabase.url });
    await client.connect();
    try {
      const { rows } = await client.query<{ outcome: string; error: string | null }>(
        `SELECT i.outcome, i.error FROM release_installs i JOIN releases r ON r.id = i.release_id
          WHERE i.installation_id = $1 AND r.version = '1.1.0'`,
        [installationId],
      );
      expect(rows).toEqual([
        { outcome: 'ROLLED_BACK', error: 'Version 1.1.0 did not pass its health check.' },
      ]);
    } finally {
      await client.end();
    }
    // Delivered: the next heartbeat no longer carries it.
    expect(await readUpdateReport(prisma)).toBeNull();
  });

  it('[UPD-007] tells the Control Plane how it checks its updates', async () => {
    // This PC names no publisher and takes no unsigned installer: it installs no update, which
    // alerts nobody. A test build that takes unsigned ones alerts the vendor (S9, update-exit).
    expect((await heartbeats.beat()).lastError).toBeNull();
    const client = new pg.Client({ connectionString: cpDatabase.url });
    await client.connect();
    try {
      const { rows } = await client.query<{ signing: string | null; alerts: string }>(
        `SELECT last_heartbeat->>'updateSigning' AS signing,
                (SELECT count(*) FROM fleet_alerts a WHERE a.installation_id = i.id
                   AND a.kind = 'UNSIGNED_UPDATES')::text AS alerts
           FROM installations i WHERE i.id = $1`,
        [installationId],
      );
      expect(rows).toEqual([{ signing: 'NONE', alerts: '0' }]);
    } finally {
      await client.end();
    }
  });

  it('[PGR-011] [UPD-003] hears of pager firmware, and reports what its pagers did with it', async () => {
    await controlPlane.get(AdminService).publishRelease(
      {
        component: 'PAGER_FIRMWARE',
        channel: 'STABLE',
        version: '2.0.0',
        url: 'https://downloads.example.com/rp/pager/rp-pager-2.0.0.bin',
        sha256: 'f'.repeat(64),
        sizeBytes: 1_500_000,
      },
      ACTOR,
    );
    expect((await heartbeats.beat()).lastError).toBeNull();
    expect(await readOfferedFirmware(prisma)).toMatchObject({
      update: { component: 'PAGER_FIRMWARE', version: '2.0.0' },
      halted: false,
      forVersion: null,
    });
    // The firmware service checked and served it; then a pager rolled back from it.
    await saveServedFirmware(prisma, {
      version: '2.0.0',
      sha256: 'f'.repeat(64),
      sizeBytes: 1_500_000,
      fileName: 'rp-pager-2.0.0.bin',
      keyDigest: 'a'.repeat(64),
      acceptedAt: new Date().toISOString(),
    });
    await saveFirmwareReport(prisma, {
      version: '2.0.0',
      outcome: 'ROLLED_BACK',
      at: new Date().toISOString(),
      error: 'No connection after the update',
    });
    expect((await heartbeats.beat()).lastError).toBeNull();
    const client = new pg.Client({ connectionString: cpDatabase.url });
    await client.connect();
    try {
      const { rows } = await client.query<{ outcome: string; error: string | null }>(
        `SELECT i.outcome, i.error FROM release_installs i JOIN releases r ON r.id = i.release_id
          WHERE i.installation_id = $1 AND r.component = 'PAGER_FIRMWARE'`,
        [installationId],
      );
      expect(rows).toEqual([{ outcome: 'ROLLED_BACK', error: 'No connection after the update' }]);
    } finally {
      await client.end();
    }
    expect((await firmwareHeartbeat(prisma)).report).toBeNull();
    expect(await readOfferedFirmware(prisma)).toEqual({
      update: null,
      halted: false,
      forVersion: '2.0.0',
    });
  });

  it('stops being accepted once the vendor revokes the installation', async () => {
    await controlPlane.get(AdminService).revokeInstallation(installationId, 'Test', ACTOR);
    const status = await heartbeats.beat();
    expect(status.lastError).toBe('INSTALLATION_REVOKED');
    expect((await request(httpServer(server)).get('/api/v1/health')).status).toBe(200);
  });
});
