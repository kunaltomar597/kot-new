import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { type LoginResponse, SystemStatusResponse } from '@rp/contracts';
import type { ReleaseInfo } from '@rp/contracts/control-plane';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service.js';
import { BACKUP_OPTIONS, BackupService } from '../../src/backups/backup.service.js';
import { saveOfferedUpdate } from '../../src/cloud/control-plane-state.js';
import { HeartbeatService } from '../../src/cloud/heartbeat.service.js';
import { APP_CONFIG, type AppConfig } from '../../src/config/app-config.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { SettingsService } from '../../src/settings/settings.service.js';
import { readInstallApproval, saveInstallApproval } from '../../src/system/system-state.js';
import type { SignatureSeen } from '../../src/updates/authenticode.js';
import {
  UPDATE_AGENT_OPTIONS,
  UpdateAgentService,
  type UpdateAgentOptions,
} from '../../src/updates/update-agent.service.js';
import {
  readUpdateRequest,
  updateOutcomePath,
  updatesDir,
  type UpdateOutcomeFile,
} from '../../src/updates/update-files.js';
import {
  markUpdateReportDelivered,
  readUpdateReport,
  saveUpdateReport,
} from '../../src/updates/update-state.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

/**
 * The update agent on the restaurant PC (P7-04c, UPD-004, UPD-005, UPD-007) against a real
 * database and real backups: the download, the timing, the backup, the hand-off to the updater
 * and its outcome. The updater itself is PowerShell (`Update-RestaurantPlatform.ps1`); here the
 * test writes its outcome file, as it does.
 */

const pgBin = process.env.RP_PG_BIN ?? process.env.PG_BIN;
const INSTALLER = Buffer.from('MZ the next version '.repeat(5_000));
const SHA = createHash('sha256').update(INSTALLER).digest('hex');

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let agent: UpdateAgentService;
let kit: AuthKit;
let manager: LoginResponse;
const dataDir = mkdtempSync(join(tmpdir(), 'rp-update-agent-'));
/** `%ProgramData%\RestaurantPlatform`, where the updater writes its outcome. */
const programData = mkdtempSync(join(tmpdir(), 'rp-update-programdata-'));
/** 14:30 in India: outside the 03:00-06:00 window. */
let now = new Date('2026-10-05T09:00:00.000Z');
const IN_WINDOW = new Date('2026-10-05T22:00:00.000Z'); // 03:30 IST on the 6th
let fetches = 0;
let failFetch = false;
let signature: SignatureSeen = { status: 'NotSigned', subject: null };

const fakeFetch = (() => {
  fetches += 1;
  if (failFetch) return Promise.reject(new Error('getaddrinfo ENOTFOUND downloads.example.com'));
  return Promise.resolve(new Response(new Uint8Array(INSTALLER)));
}) as typeof fetch;

const options: UpdateAgentOptions = {
  firstDelayMs: 0,
  tickMs: 0,
  prepareRetryMs: 30 * 60_000,
  pickupTimeoutMs: 10 * 60_000,
  handoffTimeoutMs: 5 * 60 * 60_000,
  signatureCheck: () => Promise.resolve(signature),
  programDataDir: programData,
  fetch: fakeFetch,
  now: () => now,
};

const release = (overrides: Partial<ReleaseInfo> = {}): ReleaseInfo => ({
  component: 'RESTAURANT_PC',
  channel: 'STABLE',
  version: '1.2.0',
  url: 'https://downloads.example.com/RestaurantPlatform-Setup-1.2.0.exe',
  sha256: SHA,
  sizeBytes: INSTALLER.length,
  notes: null,
  publishedAt: '2026-10-01T10:00:00.000Z',
  securityCritical: false,
  matrix: null,
  ...overrides,
});

const server = () => request(httpServer(app));
const agentStatus = async () => {
  const response = await server()
    .get('/api/v1/system')
    .set(authHeaders(kit.deviceId, manager.accessToken));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return SystemStatusResponse.parse(response.body).update.agent;
};
const approve = async (version = '1.2.0') => {
  const response = await server()
    .post('/api/v1/system/update/approve')
    .set(authHeaders(kit.deviceId, manager.accessToken))
    .send({ version, reason: 'Security fix from the vendor' });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  // The server stamps the approval with the real clock; the agent here runs on the test's.
  const approval = await readInstallApproval(prisma);
  await saveInstallApproval(prisma, { ...approval!, approvedAt: now.toISOString() });
};
const audited = async (action: string) =>
  prisma.auditLog.findMany({ where: { action }, orderBy: { chainSeq: 'asc' } });
const outcome = (requestId: string, result: Partial<UpdateOutcomeFile>) => {
  const file: UpdateOutcomeFile = {
    format: 1,
    requestId,
    version: '1.2.0',
    previousVersion: '1.1.0',
    outcome: 'INSTALLED',
    error: null,
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    logFile: null,
    ...result,
  };
  writeFileSync(updateOutcomePath(programData), `\uFEFF${JSON.stringify(file)}`);
};

beforeAll(async () => {
  mkdirSync(join(dataDir, 'tls'), { recursive: true });
  database = await createTestDatabase();
  app = await createTestApp({
    databaseUrl: database.url,
    config: {
      dataDir,
      productVersion: '1.1.0',
      updateAllowUnsigned: true,
      ...(pgBin !== undefined && { pgBin }),
    },
    overrides: [
      { provide: UPDATE_AGENT_OPTIONS, useValue: options },
      { provide: BACKUP_OPTIONS, useValue: { firstDelayMs: 0, checkEveryMs: 0, now: () => now } },
    ],
  });
  prisma = app.get(PrismaService);
  agent = app.get(UpdateAgentService);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
});

afterAll(async () => {
  await app.get(BackupService).settled();
  await app.close();
  await database.drop();
});

describe('[UPD-004] [UPD-005] [UPD-007] the update agent', () => {
  it('has nothing to do while this PC is up to date', async () => {
    await agent.runOnce();
    expect(await agentStatus()).toEqual({
      state: 'IDLE',
      version: null,
      waitingFor: null,
      error: null,
      retryAt: null,
      lastOutcome: null,
    });
    await saveOfferedUpdate(prisma, release({ version: '1.1.0' }));
    await agent.runOnce();
    expect((await agentStatus()).state).toBe('IDLE');
    expect(fetches).toBe(0);
  });

  it('downloads the release on offer in the background, then waits for the window', async () => {
    await saveOfferedUpdate(prisma, release());
    await agent.runOnce();
    expect(await agentStatus()).toMatchObject({
      state: 'WAITING',
      version: '1.2.0',
      waitingFor: 'WINDOW',
    });
    expect(readdirSync(updatesDir(dataDir))).toEqual(['RestaurantPlatform-Setup-1.2.0.exe']);
    await agent.runOnce();
    expect(fetches).toBe(1);
  });

  it('tries a failed download again later, and refuses a bad signature or another version', async () => {
    // A re-published release (another file) is downloaded again; this attempt fails.
    await saveOfferedUpdate(prisma, release({ sha256: 'b'.repeat(64) }));
    failFetch = true;
    await agent.runOnce();
    const failed = await agentStatus();
    expect(failed).toMatchObject({ state: 'DOWNLOAD_FAILED', version: '1.2.0' });
    expect(failed.error).toMatch(/ENOTFOUND/);
    expect(failed.retryAt).toBe(new Date(now.getTime() + 5 * 60_000).toISOString());
    expect(readdirSync(updatesDir(dataDir))).toEqual([]);
    failFetch = false;
    await agent.runOnce();
    expect(fetches).toBe(2);

    // Five minutes on, the right file but a damaged signature.
    await saveOfferedUpdate(prisma, release());
    now = new Date(now.getTime() + 5 * 60_000);
    signature = { status: 'HashMismatch', subject: null };
    await agent.runOnce();
    expect(await agentStatus()).toMatchObject({
      state: 'DOWNLOAD_FAILED',
      error: 'The installer’s signature is not valid (HashMismatch).',
    });
    expect(readdirSync(updatesDir(dataDir))).toEqual([]);

    // UPD-002: an older installer under the release's name and SHA-256 is not taken either.
    signature = { status: 'NotSigned', subject: null, productVersion: '1.0.5' };
    now = new Date(now.getTime() + 10 * 60_000);
    await agent.runOnce();
    expect(await agentStatus()).toMatchObject({
      state: 'DOWNLOAD_FAILED',
      error: 'The installer installs version 1.0.5, not version 1.2.0 as the release says.',
    });
    expect(readdirSync(updatesDir(dataDir))).toEqual([]);
    signature = { status: 'NotSigned', subject: null, productVersion: '1.2.0' };
    now = new Date(now.getTime() + 20 * 60_000);
    await agent.runOnce();
    expect(await agentStatus()).toMatchObject({ state: 'WAITING', waitingFor: 'WINDOW' });
  });

  it('never installs with open tables, unless security-critical and approved', async () => {
    const section = await prisma.section.create({
      data: { restaurantId: kit.restaurantId, name: 'Main' },
    });
    const table = await prisma.diningTable.create({
      data: { restaurantId: kit.restaurantId, sectionId: section.id, label: 'T1' },
    });
    await prisma.tableSession.create({
      data: {
        restaurantId: kit.restaurantId,
        tableId: table.id,
        businessDate: new Date('2026-10-05'),
      },
    });
    now = IN_WINDOW;
    await agent.runOnce();
    expect(await agentStatus()).toMatchObject({ state: 'WAITING', waitingFor: 'OPEN_TABLES' });
    await approve();
    await agent.runOnce();
    expect(await agentStatus()).toMatchObject({ state: 'WAITING', waitingFor: 'OPEN_TABLES' });
    expect(await readUpdateRequest(dataDir)).toBeNull();
  });

  let firstRequest = '';

  it('backs up, then hands a security fix the manager approved to the updater', async () => {
    await saveOfferedUpdate(prisma, release({ securityCritical: true }));
    await agent.runOnce();
    expect(await agentStatus()).toMatchObject({ state: 'INSTALLING', version: '1.2.0' });
    const backup = await prisma.backupRun.findFirst({ where: { kind: 'UPDATE' } });
    expect(backup, 'the full backup before the update').toMatchObject({
      status: 'SUCCEEDED',
      fileName: 'rp-backup-20261005T220000Z-update.rpbk',
    });
    const handed = await readUpdateRequest(dataDir);
    expect(handed).toMatchObject({
      version: '1.2.0',
      previousVersion: '1.1.0',
      fileName: 'RestaurantPlatform-Setup-1.2.0.exe',
      sha256: SHA,
      sizeBytes: INSTALLER.length,
      securityCritical: true,
      trigger: 'APPROVED',
      approvedByStaffId: kit.staff.MANAGER,
      backupFileName: 'rp-backup-20261005T220000Z-update.rpbk',
    });
    firstRequest = handed!.requestId;
    const [started] = await audited('UPDATE_STARTED');
    expect(started).toMatchObject({ actorId: kit.staff.MANAGER, reason: 'Install now' });
    expect(started!.after).toMatchObject({ version: '1.2.0', trigger: 'APPROVED' });
    expect(await readUpdateReport(prisma)).toMatchObject({
      version: '1.2.0',
      outcome: 'INSTALLING',
      error: null,
    });
    // While the updater works, nothing else happens.
    await agent.runOnce();
    expect(await prisma.backupRun.count({ where: { kind: 'UPDATE' } })).toBe(1);
  });

  it('records a rollback, reports it, and does not try that version again by itself', async () => {
    now = new Date(now.getTime() + 9 * 60_000);
    outcome(firstRequest, {
      outcome: 'ROLLED_BACK',
      error: 'Version 1.2.0 did not pass its health check: the server did not answer.',
    });
    await agent.runOnce();
    const status = await agentStatus();
    expect(status).toMatchObject({
      state: 'WAITING',
      version: '1.2.0',
      waitingFor: 'RETRY_APPROVAL',
      lastOutcome: {
        version: '1.2.0',
        previousVersion: '1.1.0',
        outcome: 'ROLLED_BACK',
        error: 'Version 1.2.0 did not pass its health check: the server did not answer.',
        backupFileName: 'rp-backup-20261005T220000Z-update.rpbk',
      },
    });
    expect(await readUpdateReport(prisma)).toMatchObject({ outcome: 'ROLLED_BACK' });
    const [rolledBack] = await audited('UPDATE_ROLLED_BACK');
    expect(rolledBack?.reason).toMatch(/health check/);
    // The download stays for a retry.
    expect(readdirSync(updatesDir(dataDir))).toEqual(['RestaurantPlatform-Setup-1.2.0.exe']);
  });

  it('tries again after "Install now", and fails an update the updater never took', async () => {
    now = new Date(now.getTime() + 60_000);
    await approve();
    await agent.runOnce();
    const second = await readUpdateRequest(dataDir);
    expect(second?.requestId).not.toBe(firstRequest);
    expect(await agentStatus()).toMatchObject({ state: 'INSTALLING' });
    now = new Date(now.getTime() + 11 * 60_000);
    await agent.runOnce();
    expect(await readUpdateRequest(dataDir)).toBeNull();
    expect((await agentStatus()).lastOutcome).toMatchObject({
      outcome: 'FAILED',
      error: expect.stringMatching(/updater did not start/) as unknown,
    });
    expect(await audited('UPDATE_FAILED')).toHaveLength(1);
  });

  it('records an installed update and removes the download', async () => {
    now = new Date(now.getTime() + 60_000);
    await approve();
    await agent.runOnce();
    const third = await readUpdateRequest(dataDir);
    expect(third).not.toBeNull();
    // The updater takes the request; however long it works, the update is not given up on.
    outcome(third!.requestId, { outcome: 'RUNNING' });
    now = new Date(now.getTime() + 30 * 60_000);
    await agent.runOnce();
    expect(await agentStatus()).toMatchObject({ state: 'INSTALLING', version: '1.2.0' });
    // The new version passes its health check.
    outcome(third!.requestId, { outcome: 'INSTALLED' });
    // The Control Plane offers nothing newer to the new version.
    await saveOfferedUpdate(prisma, null);
    await agent.runOnce();
    expect(await agentStatus()).toMatchObject({
      state: 'IDLE',
      lastOutcome: { version: '1.2.0', outcome: 'INSTALLED', error: null },
    });
    expect(existsSync(updatesDir(dataDir)) ? readdirSync(updatesDir(dataDir)) : []).toEqual([]);
    // The request is the server's to remove (the updater only reads in the data folder).
    expect(await readUpdateRequest(dataDir)).toBeNull();
    expect(await audited('UPDATE_INSTALLED')).toHaveLength(1);
    expect(await readUpdateReport(prisma)).toMatchObject({ outcome: 'INSTALLED' });
  });

  it('sends the report with heartbeats until one is answered', async () => {
    const report = {
      version: '1.3.0',
      outcome: 'INSTALLING' as const,
      at: now.toISOString(),
      error: null,
    };
    await saveUpdateReport(prisma, report);
    // An answer to an older report leaves the newer one to be sent.
    await markUpdateReportDelivered(prisma, { ...report, outcome: 'FAILED' });
    expect(await readUpdateReport(prisma)).toEqual(report);
    await markUpdateReportDelivered(prisma, report);
    expect(await readUpdateReport(prisma)).toBeNull();
  });

  it('is unavailable without a version from the installer, or a way to check signatures', async () => {
    const config = app.get<AppConfig>(APP_CONFIG);
    const agentWith = (overrides: Partial<AppConfig>) =>
      new UpdateAgentService(
        prisma,
        app.get(SettingsService),
        app.get(BackupService),
        app.get(HeartbeatService),
        app.get(AuditService),
        { ...config, ...overrides },
        options,
      );
    const development = agentWith({ productVersion: undefined });
    await development.runOnce();
    expect(await development.status()).toMatchObject({
      state: 'UNAVAILABLE',
      error: expect.stringMatching(/restaurant PC/) as unknown,
    });
    const unsigned = agentWith({ updateAllowUnsigned: false });
    await unsigned.runOnce();
    expect(await unsigned.status()).toMatchObject({
      state: 'UNAVAILABLE',
      error: expect.stringMatching(/code-signing certificate/) as unknown,
    });
  });
});
