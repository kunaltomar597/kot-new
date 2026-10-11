import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { AuditVerifyResponse, type InvoiceView, type LoginResponse } from '@rp/contracts';
import {
  AdminService,
  CONTROL_PLANE_MIGRATIONS_DIR,
  CpConfigSchema,
  createControlPlaneApp,
  FleetService,
  ReleasesService,
} from '@rp/control-plane/testing';
import { createMigratedDatabase, type TestDatabase } from '@rp/test-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { SECRET_STORE, type SecretStore } from '../../src/auth/secret-store.js';
import { BACKUP_OPTIONS, BackupService } from '../../src/backups/backup.service.js';
import { readOfferedUpdate } from '../../src/cloud/control-plane-state.js';
import { enrolInstallation } from '../../src/cloud/enrolment.js';
import { CONTROL_PLANE_OPTIONS, HeartbeatService } from '../../src/cloud/heartbeat.service.js';
import { APP_CONFIG, type AppConfig } from '../../src/config/app-config.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import {
  createUpdateSnapshot,
  failedDatabaseName,
  runPendingUpdateRollback,
  updateRollbackRequestPath,
} from '../../src/installation/update-snapshot.js';
import { probeHealth } from '../../src/service/health-probe.js';
import {
  UPDATE_AGENT_OPTIONS,
  type UpdateAgentOptions,
  UpdateAgentService,
} from '../../src/updates/update-agent.service.js';
import {
  readUpdateRequest,
  updateOutcomePath,
  type UpdateOutcomeFile,
} from '../../src/updates/update-files.js';
import {
  authHeaders,
  type AuthKit,
  createAuthKit,
  renewDeviceToken,
  signIn,
} from '../helpers/auth-kit.js';
import {
  type SmallRestaurant,
  serveTable,
  setUpSmallRestaurant,
} from '../helpers/small-restaurant.js';
import { api, createTestApp } from '../helpers/test-app.js';
import { createTestDatabase, testAdminUrl } from '../helpers/test-database.js';

/**
 * Phase 7 exit scenario S9 (P7-10, BRD §18.2): update failure: a forced failed health check, then
 * the automatic rollback; the restaurant keeps working.
 *
 * The restaurant PC runs version 1.1.0 and is enrolled with a real Vendor Control Plane, which
 * publishes 1.2.0 to every PC on the channel. The PC downloads it during the evening's service and
 * waits for the night's maintenance window, when it backs up and hands the update to the updater.
 * The updater's steps (`Invoke-RPUpdate`, PowerShell on the PC) are taken here as it takes them:
 * the services stopped, the database copied, the new version installed, which changes the database
 * and then fails its health check, the rollback request written, the previous version installed
 * again, whose service host switches the copy back in before its server starts and answers its
 * health check. The PC records, audits and reports the rollback; the vendor's rollout halts by
 * itself and Support sees the failure on the fleet. The next morning the restaurant works as
 * before: last night's bills are there, the failed version's changes are not, and service goes on.
 *
 * The installer itself, the scheduled task and the real health check over TLS run in the CI job
 * "Windows installer" (`ci/Test-Update.ps1`, scenario S9 on `windows-latest`), and the updater's
 * PowerShell in its Pester tests.
 */

const pgBin = process.env.RP_PG_BIN ?? process.env.PG_BIN;
const ist = (local: string) => new Date(`${local}+05:30`);
const EVENING = ist('2026-11-02T20:00:00');
/** The maintenance window is 03:00 to 06:00 (UPD-004). */
const NIGHT = ist('2026-11-03T03:30:00');
const MORNING = ist('2026-11-03T10:00:00');
const INSTALLER = Buffer.from('MZ Restaurant Platform 1.2.0 '.repeat(4_000));
const SHA = createHash('sha256').update(INSTALLER).digest('hex');
const URL_120 = 'https://downloads.example.com/rp/1.2.0/RestaurantPlatform-Setup-1.2.0.exe';
const vendor = generateKeyPairSync('ed25519');
const VENDOR_KEY = vendor.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

let serverDatabase: TestDatabase;
let cpDatabase: TestDatabase;
let controlPlane: INestApplication;
let pc: INestApplication;
let kit: AuthKit;
let restaurant: SmallRestaurant;
let installationId: string;
let releaseId: string;
let staff: { manager: LoginResponse; waiter: LoginResponse; cashier: LoginResponse };
let lastNight: InvoiceView;
let requestId = '';
const dataDir = mkdtempSync(join(tmpdir(), 'rp-s9-data-'));
/** `%ProgramData%\RestaurantPlatform`: the updater's outcome and rollback request. */
const programData = mkdtempSync(join(tmpdir(), 'rp-s9-programdata-'));
let downloads = 0;

const agentOptions: UpdateAgentOptions = {
  firstDelayMs: 0,
  tickMs: 0,
  prepareRetryMs: 30 * 60_000,
  pickupTimeoutMs: 10 * 60_000,
  handoffTimeoutMs: 5 * 60 * 60_000,
  // Off Windows the updater checks the signature; here the build is an unsigned test build.
  signatureCheck: null,
  programDataDir: programData,
  fetch: ((url: string) => {
    downloads += 1;
    if (url !== URL_120) return Promise.resolve(new Response('Not found', { status: 404 }));
    return Promise.resolve(new Response(new Uint8Array(INSTALLER)));
  }) as typeof fetch,
  now: () => new Date(),
};

/** Version 1.1.0 of the server on this PC's database and data folder. */
function startServer(cpUrl: string): Promise<INestApplication> {
  return createTestApp({
    databaseUrl: serverDatabase.url,
    config: {
      dataDir,
      controlPlaneUrl: cpUrl,
      productVersion: '1.1.0',
      updateAllowUnsigned: true,
      licenceKeys: [VENDOR_KEY],
      ...(pgBin !== undefined && { pgBin }),
    },
    overrides: [
      { provide: UPDATE_AGENT_OPTIONS, useValue: agentOptions },
      {
        provide: BACKUP_OPTIONS,
        useValue: { firstDelayMs: 0, checkEveryMs: 0, now: () => new Date() },
      },
      {
        provide: CONTROL_PLANE_OPTIONS,
        useValue: {
          firstHeartbeatDelayMs: 600_000,
          defaultIntervalMs: 600_000,
          requestTimeoutMs: 5_000,
        },
      },
    ],
  });
}

async function onDuty(at: Date): Promise<void> {
  vi.setSystemTime(at);
  await renewDeviceToken(pc, kit.deviceId);
  staff = {
    manager: await signIn(pc, kit, 'MANAGER'),
    waiter: await signIn(pc, kit, 'WAITER'),
    cashier: await signIn(pc, kit, 'CASHIER'),
  };
}

const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);

async function admin<T extends pg.QueryResultRow>(sql: string, database = 'postgres') {
  const url = new URL(testAdminUrl());
  url.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

function writeOutcome(outcome: Partial<UpdateOutcomeFile>): void {
  const file: UpdateOutcomeFile = {
    format: 1,
    requestId,
    version: '1.2.0',
    previousVersion: '1.1.0',
    outcome: 'RUNNING',
    error: null,
    startedAt: NIGHT.toISOString(),
    finishedAt: new Date().toISOString(),
    logFile: null,
    ...outcome,
  };
  // As Windows PowerShell 5.1 writes UTF-8.
  writeFileSync(updateOutcomePath(programData), `\uFEFF${JSON.stringify(file)}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
  });
}

const portOf = (app: INestApplication) => {
  const address = (app.getHttpServer() as Server).address();
  if (address === null || typeof address === 'string') throw new Error('Not listening');
  return address.port;
};

let cpUrl = '';

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(EVENING);
  mkdirSync(join(dataDir, 'tls'), { recursive: true });
  serverDatabase = await createTestDatabase();
  cpDatabase = await createMigratedDatabase({
    adminUrl: testAdminUrl(),
    runId: inject('pgRunId'),
    prefix: 'rp',
    migrationsDir: CONTROL_PLANE_MIGRATIONS_DIR,
  });
  controlPlane = await createControlPlaneApp(
    CpConfigSchema.parse({
      databaseUrl: cpDatabase.url,
      logLevel: 'silent',
      billingIntervalMinutes: 0,
      fleetSweepSeconds: 0,
      licenceSigningKey: vendor.privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64'),
      // A single PC that rolls back halts the rollout here (the default waits for two).
      rolloutMinFailures: 1,
      rolloutMaxFailurePercent: 20,
    }),
  );
  await controlPlane.listen(0, '127.0.0.1');
  cpUrl = `http://127.0.0.1:${String(portOf(controlPlane))}`;
  const admin = controlPlane.get(AdminService);
  const tenant = await admin.createTenant('Update Dhaba', 'vendor:sales');
  const issued = await admin.createInstallation(
    { tenantId: tenant.id, name: 'Counter PC' },
    'vendor:sales',
  );
  installationId = issued.installationId;

  pc = await startServer(cpUrl);
  kit = await createAuthKit(pc);
  await enrolInstallation({
    config: pc.get<AppConfig>(APP_CONFIG),
    prisma: pc.get(PrismaService),
    secrets: pc.get<SecretStore>(SECRET_STORE),
    code: issued.code,
  });
  await onDuty(EVENING);
  restaurant = await setUpSmallRestaurant(pc, kit, staff.manager);
  expect((await pc.get(HeartbeatService).beat()).lastError).toBeNull();
}, 120_000);

afterAll(async () => {
  vi.useRealTimers();
  await pc.close();
  await controlPlane.close();
  await serverDatabase.drop();
  await admin(`DROP DATABASE IF EXISTS "${failedDatabaseName(serverDatabase.name)}" WITH (FORCE)`);
  await cpDatabase.drop();
});

describe('[S9] [UPD-004] [UPD-005] [UPD-003] an update that fails its health check', () => {
  it('the vendor publishes 1.2.0; the PC downloads it during service and waits for the night', async () => {
    const release = await controlPlane.get(AdminService).publishRelease(
      {
        component: 'RESTAURANT_PC',
        channel: 'STABLE',
        version: '1.2.0',
        url: URL_120,
        sha256: SHA,
        sizeBytes: INSTALLER.length,
      },
      'vendor:release',
    );
    releaseId = release.id;
    expect(release.rollout).toMatchObject({ percent: 100, state: 'ACTIVE' });
    expect((await pc.get(HeartbeatService).beat()).offeredUpdate).toMatchObject({
      version: '1.2.0',
    });
    // The evening's service: a table seated, served, billed and paid.
    lastNight = await serveTable(pc, kit, staff, restaurant.tables.T1 ?? '', [
      [restaurant.items.Dal, 2],
      [restaurant.items.Naan, 4],
    ]);
    const agent = pc.get(UpdateAgentService);
    await agent.runOnce();
    expect(await agent.status()).toMatchObject({
      state: 'WAITING',
      version: '1.2.0',
      waitingFor: 'WINDOW',
    });
    expect(downloads).toBe(1);
  });

  it('in the night’s window it backs up, then hands the update to the updater', async () => {
    vi.setSystemTime(NIGHT);
    const agent = pc.get(UpdateAgentService);
    await agent.runOnce();
    expect(await agent.status()).toMatchObject({ state: 'INSTALLING', version: '1.2.0' });
    const backup = await pc.get(PrismaService).backupRun.findFirst({ where: { kind: 'UPDATE' } });
    expect(backup?.status).toBe('SUCCEEDED');
    const handed = await readUpdateRequest(dataDir);
    expect(handed).toMatchObject({ version: '1.2.0', previousVersion: '1.1.0', sha256: SHA });
    requestId = handed!.requestId;
    // The vendor hears it is installing.
    await pc.get(HeartbeatService).beat();
    const [view] = (await controlPlane.get(ReleasesService).list()).filter(
      (entry) => entry.id === releaseId,
    );
    expect(view?.installs).toMatchObject({ attempts: 1, failures: 0 });
  });

  it('1.2.0 fails its health check; the updater goes back to 1.1.0 and the database before it', async () => {
    // The updater takes the request and stops the services.
    writeOutcome({ outcome: 'RUNNING' });
    await pc.get(BackupService).settled();
    await pc.close();
    // The database copied.
    await createUpdateSnapshot({
      adminUrl: testAdminUrl(),
      database: serverDatabase.name,
      freeBytes: null,
    });
    // Version 1.2.0's installer migrates the database and writes to it ...
    await admin('CREATE TABLE from_version_120 (id TEXT PRIMARY KEY)', serverDatabase.name);
    await admin(`UPDATE restaurants SET display_name = 'Changed by 1.2.0'`, serverDatabase.name);
    // ... and its server never answers its health check.
    expect(await probeHealth({ port: await freePort(), timeoutMs: 500 })).toBe('unanswered');
    const reason =
      'Version 1.2.0 did not pass its health check within 180 seconds (version 1.2.0, server STARTING, health unanswered).';

    // The way back: the rollback request where only administrators write, then 1.1.0's
    // installer, whose service host switches the copy back in before its server starts.
    writeFileSync(
      updateRollbackRequestPath(programData),
      `\uFEFF${JSON.stringify({ format: 1, requestId, version: '1.2.0', requestedAt: new Date().toISOString() })}`,
    );
    const switched = await runPendingUpdateRollback({
      requestFile: updateRollbackRequestPath(programData),
      dataDir,
      adminUrl: testAdminUrl(),
      database: serverDatabase.name,
    });
    expect(switched).toMatchObject({
      ok: true,
      failedDatabase: failedDatabaseName(serverDatabase.name),
    });
    pc = await startServer(cpUrl);
    expect(await probeHealth({ port: portOf(pc) })).toBe('ok');
    writeOutcome({ outcome: 'ROLLED_BACK', error: reason });
  }, 120_000);

  it('[VCP-006] the PC records and reports the rollback; the vendor’s rollout halts by itself', async () => {
    const agent = pc.get(UpdateAgentService);
    await agent.runOnce();
    expect(await agent.status()).toMatchObject({
      lastOutcome: {
        version: '1.2.0',
        previousVersion: '1.1.0',
        outcome: 'ROLLED_BACK',
        error: expect.stringMatching(/did not pass its health check/) as unknown,
      },
    });
    const audited = await pc
      .get(PrismaService)
      .auditLog.findFirst({ where: { action: 'UPDATE_ROLLED_BACK' } });
    expect(audited?.reason).toMatch(/health check/);

    expect((await pc.get(HeartbeatService).beat()).lastError).toBeNull();
    const [view] = (await controlPlane.get(ReleasesService).list()).filter(
      (entry) => entry.id === releaseId,
    );
    expect(view?.rollout.state).toBe('HALTED');
    expect(view?.rollout.haltReason).toMatch(/1 failed or rolled back, of 1 PC/);
    expect(view?.installs).toMatchObject({ attempts: 1, failures: 1 });
    const alerts = await controlPlane.get(FleetService).alerts({ installationId });
    expect(alerts.map((alert) => alert.kind)).toContain('UPDATE_FAILED');
    // UPD-007: this is a test build, which takes unsigned updates; the vendor sees it too.
    expect(alerts.find((alert) => alert.kind === 'UNSIGNED_UPDATES')).toMatchObject({
      resolvedAt: null,
      details: { version: '1.1.0' },
    });

    // The halted release is offered no more, so the PC does not try it again.
    expect((await pc.get(HeartbeatService).beat()).offeredUpdate).toBeNull();
    expect(await readOfferedUpdate(pc.get(PrismaService))).toBeNull();
    await agent.runOnce();
    expect(await agent.status()).toMatchObject({
      state: 'IDLE',
      lastOutcome: { outcome: 'ROLLED_BACK' },
    });
  });

  it('the next morning the restaurant works as before', async () => {
    await onDuty(MORNING);
    const prisma = pc.get(PrismaService);
    // Last night's bill and its payment; nothing the failed version wrote.
    const bill = await prisma.invoice.findUniqueOrThrow({
      where: { id: lastNight.id },
      include: { payments: true },
    });
    expect(bill).toMatchObject({ status: 'SETTLED', grandTotal: lastNight.grandTotal });
    expect((await prisma.restaurant.findFirstOrThrow()).displayName).not.toBe('Changed by 1.2.0');
    expect(
      await admin<{ gone: boolean }>(
        `SELECT to_regclass('public.from_version_120') IS NULL AS gone`,
        serverDatabase.name,
      ),
    ).toEqual([{ gone: true }]);
    // Support finds the failed version's database kept.
    expect(
      await admin<{ kept: boolean }>(
        `SELECT to_regclass('public.from_version_120') IS NOT NULL AS kept`,
        failedDatabaseName(serverDatabase.name),
      ),
    ).toEqual([{ kept: true }]);

    // Service as usual, and the audit trail holds.
    const breakfast = await serveTable(pc, kit, staff, restaurant.tables.T2 ?? '', [
      [restaurant.items.Lassi, 2],
    ]);
    expect(breakfast.invoiceNumber).not.toBe(lastNight.invoiceNumber);
    const chain = AuditVerifyResponse.parse(
      (await api(pc).get('/api/v1/audit/verify').set(as(staff.manager))).body,
    );
    expect(chain, JSON.stringify(chain.firstBreak)).toMatchObject({ valid: true });
  });
});
