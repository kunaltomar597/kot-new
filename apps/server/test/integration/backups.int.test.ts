import { createReadStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  BackupsResponse,
  type LoginResponse,
  StartBackupResponse,
  SystemStatusResponse,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readArchive } from '../../src/backups/backup-archive.js';
import {
  BackupContentError,
  BackupSecrets,
  verifyBackupFile,
} from '../../src/backups/backup-contents.js';
import { BackupFileError, decryptBackup } from '../../src/backups/backup-file.js';
import { BACKUP_OPTIONS, BackupService } from '../../src/backups/backup.service.js';
import { pgProgram, runPgTool } from '../../src/backups/pg-tools.js';
import { SECRET_STORE, type SecretStore } from '../../src/auth/secret-store.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { HeartbeatService } from '../../src/cloud/heartbeat.service.js';
import { SettingsService } from '../../src/settings/settings.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

/**
 * Encrypted local backups (P7-05a, DATA-002, DATA-005, SEC-007) against a real database, with
 * `pg_dump` and `pg_restore` from `RP_PG_BIN` (or `PG_BIN`, or the PATH).
 */

const pgBin = process.env.RP_PG_BIN ?? process.env.PG_BIN;
let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let backups: BackupService;
let kit: AuthKit;
let manager: LoginResponse;
let waiter: LoginResponse;
const dataDir = mkdtempSync(join(tmpdir(), 'rp-backups-'));
const secondDrive = mkdtempSync(join(tmpdir(), 'rp-usb-'));
/** 05:00 in India on 3 October 2026, after the 04:30 nightly slot. */
let now = new Date('2026-10-02T23:30:00.000Z');

const server = () => request(httpServer(app));
const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const overview = async () => {
  const response = await server().get('/api/v1/backups').set(as(manager));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return BackupsResponse.parse(response.body);
};
const backupKey = () => app.get<SecretStore>(SECRET_STORE).get('backup-key');
const toolOptions = () => ({ pgBin, databaseUrl: database.url });

/** Sets the second location, or goes back to the default (none). */
async function setSecondLocation(value: string | null): Promise<void> {
  const where = { restaurantId: kit.restaurantId, key: 'backups.secondLocation' };
  if (value === null) {
    await prisma.setting.deleteMany({ where });
  } else {
    await prisma.setting.upsert({
      where: { restaurantId_key: where },
      create: { ...where, value },
      update: { value },
    });
  }
  app.get(SettingsService).invalidate();
}

async function backUp(): Promise<BackupsResponse['runs'][number]> {
  const response = await server().post('/api/v1/backups').set(as(manager));
  expect(response.status, JSON.stringify(response.body)).toBe(202);
  const { run } = StartBackupResponse.parse(response.body);
  expect(run).toMatchObject({ kind: 'MANUAL', status: 'RUNNING' });
  expect(run.requestedBy).not.toBeNull();
  await backups.settled();
  const done = (await overview()).runs.find((entry) => entry.id === run.id);
  expect(done).toBeDefined();
  return done!;
}

beforeAll(async () => {
  mkdirSync(join(dataDir, 'photos', 'r1'), { recursive: true });
  writeFileSync(join(dataDir, 'photos', 'r1', '640.webp'), Buffer.from('a photo'));
  mkdirSync(join(dataDir, 'tls'), { recursive: true });
  writeFileSync(join(dataDir, 'tls', 'ca.pem'), '-----BEGIN CERTIFICATE-----\nMIIB\n');
  database = await createTestDatabase();
  app = await createTestApp({
    databaseUrl: database.url,
    config: { dataDir, ...(pgBin !== undefined && { pgBin }) },
    overrides: [
      { provide: BACKUP_OPTIONS, useValue: { firstDelayMs: 0, checkEveryMs: 0, now: () => now } },
    ],
  });
  prisma = app.get(PrismaService);
  backups = app.get(BackupService);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  waiter = await signIn(app, kit, 'WAITER');
});

afterAll(async () => {
  await backups.settled();
  await app.close();
  await database.drop();
});

beforeEach(async () => {
  await setSecondLocation(secondDrive);
});

describe('[DATA-002] [SEC-007] encrypted local backups', () => {
  it('backs up the database, photos, TLS files and secrets, encrypted, to both places', async () => {
    const run = await backUp();
    expect(run, JSON.stringify(run)).toMatchObject({
      status: 'SUCCEEDED',
      secondCopy: 'COPIED',
      error: null,
      fileName: 'rp-backup-20261002T233000Z-manual.rpbk',
    });
    const view = await overview();
    expect(view).toMatchObject({ health: 'OK', running: false });
    expect(view.nextNightlyAt).toBe('2026-10-03T23:00:00.000Z');
    expect(view.locations.map((location) => [location.location, location.files.length])).toEqual([
      ['DATA_DRIVE', 1],
      ['SECOND', 1],
    ]);

    const file = join(dataDir, 'backups', 'full', run.fileName!);
    const copy = join(secondDrive, 'rp-backups', run.fileName!);
    expect(readFileSync(copy).equals(readFileSync(file))).toBe(true);
    // Nothing readable inside without the key.
    expect(readFileSync(file).includes(Buffer.from('Auth Dhaba'))).toBe(false);
    expect(readFileSync(file).includes(Buffer.from('a photo'))).toBe(false);

    const key = await backupKey();
    const verified = await verifyBackupFile(createReadStream(file), key, toolOptions());
    expect(verified.info).toMatchObject({
      kind: 'MANUAL',
      restaurants: [{ id: kit.restaurantId, name: 'Auth Dhaba' }],
    });
    expect(verified.entries).toEqual([
      'backup.json',
      'database.dump',
      'secrets.json',
      'files/photos/r1/640.webp',
      'files/tls/ca.pem',
      'manifest.json',
    ]);

    // The secrets the data needs are inside; the key that opens the backup is not.
    const contents: Record<string, Buffer> = {};
    await readArchive(createReadStream(file).pipe(decryptBackup(key)), (name) => {
      const parts: Buffer[] = [];
      return {
        write: (part) => {
          parts.push(part);
        },
        end: () => {
          contents[name] = Buffer.concat(parts);
        },
      };
    });
    const secrets = BackupSecrets.parse(JSON.parse(contents['secrets.json']!.toString()));
    expect(Object.keys(secrets.secrets)).not.toContain('backup-key');
    const pepper = await app.get<SecretStore>(SECRET_STORE).get('pin-pepper');
    expect(secrets.secrets['pin-pepper']).toBe(pepper.toString('base64'));
    expect(contents['files/photos/r1/640.webp']?.toString()).toBe('a photo');

    // The dump holds the business tables, ready for pg_restore (P7-05b restores it).
    const listing = runPgTool(pgProgram('pg_restore', pgBin), ['--list'], database.url);
    listing.stdin.end(contents['database.dump']);
    let toc = '';
    listing.stdout.setEncoding('utf8');
    listing.stdout.on('data', (text: string) => (toc += text));
    await listing.done;
    expect(toc).toMatch(/TABLE DATA public orders/);
    expect(toc).toMatch(/TABLE DATA public audit_log/);

    // AUD-001: who asked, and the outcome.
    const audit = await prisma.auditLog.findMany({
      where: { entityType: 'backup_run', entityId: run.id },
      orderBy: { chainSeq: 'asc' },
    });
    expect(audit.map((entry) => [entry.action, entry.actorId])).toEqual([
      ['BACKUP_REQUESTED', kit.staff.MANAGER],
      ['BACKUP_COMPLETED', kit.staff.MANAGER],
    ]);
  });

  it('[DATA-002] detects a changed or cut backup', async () => {
    const [name] = (await readdir(join(dataDir, 'backups', 'full'))).filter((entry) =>
      entry.endsWith('.rpbk'),
    );
    const bytes = readFileSync(join(dataDir, 'backups', 'full', name!));
    const key = await backupKey();
    const check = async (content: Buffer) => {
      const path = join(mkdtempSync(join(tmpdir(), 'rp-tampered-')), 'backup.rpbk');
      writeFileSync(path, content);
      return verifyBackupFile(createReadStream(path), key, toolOptions()).then(
        () => 'accepted',
        (error: unknown) =>
          error instanceof BackupFileError ? error.code : (error as Error).constructor.name,
      );
    };
    const changed = Buffer.from(bytes);
    const middle = Math.floor(bytes.length / 2);
    changed[middle] = changed[middle]! ^ 0x40;
    expect(await check(changed)).toBe('DAMAGED');
    expect(await check(bytes.subarray(0, bytes.length - 1000))).toBe('TRUNCATED');
    expect(await check(bytes)).toBe('accepted');
    await expect(
      verifyBackupFile(
        createReadStream(join(dataDir, 'backups', 'full', name!)),
        Buffer.alloc(32, 7),
        toolOptions(),
      ),
    ).rejects.toMatchObject({ code: 'WRONG_KEY' });
    expect(BackupContentError).toBeDefined();
  });

  it('runs one backup at a time', async () => {
    const results = await Promise.allSettled([backups.start('MANUAL'), backups.start('MANUAL')]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = results.find((result) => result.status === 'rejected');
    expect(refused?.reason).toMatchObject({ status: 409, code: 'BACKUP_RUNNING' });
    await backups.settled();
  });

  it('[DATA-002] keeps 14 daily and 8 weekly backups', async () => {
    const folder = join(dataDir, 'backups', 'full');
    // Nightly backups (stand-ins) since 1 August.
    const start = Date.parse('2026-07-31T23:00:00.000Z');
    for (let day = 0; day < 62; day += 1) {
      const stamp = new Date(start + day * 86_400_000)
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '');
      writeFileSync(join(folder, `rp-backup-${stamp}-nightly.rpbk`), 'old');
    }
    now = new Date('2026-10-03T23:30:00.000Z');
    const run = await backUp();
    expect(run.status).toBe('SUCCEEDED');
    const kept = (await readdir(folder)).filter((name) => name.endsWith('.rpbk')).sort();
    // The 14 newest days (one backup each, the newest of the day) and 5 older weeks.
    expect(kept).toHaveLength(19);
    expect(kept.at(-1)).toBe('rp-backup-20261003T233000Z-manual.rpbk');
    expect(kept).not.toContain('rp-backup-20260731T230000Z-nightly.rpbk');
  });
});

describe('[DATA-005] backup failures', () => {
  it('alerts the Owner and managers, shows on the System page and reaches the vendor', async () => {
    // The second location is a file, not a folder: the copy fails.
    const blocked = join(secondDrive, 'not-a-folder');
    writeFileSync(blocked, 'x');
    await setSecondLocation(blocked);
    now = new Date('2026-10-04T23:30:00.000Z');
    const partial = await backUp();
    expect(partial).toMatchObject({ status: 'PARTIAL', secondCopy: 'FAILED' });
    expect(partial.error).toMatch(/^The copy to the second location failed/);
    expect((await overview()).health).toBe('FAILED');
    const alert = await prisma.alert.findFirst({
      where: { restaurantId: kit.restaurantId, dedupeKey: 'backup', status: 'OPEN' },
    });
    expect(alert).toMatchObject({ type: 'DISK_OR_BACKUP' });
    const system = SystemStatusResponse.parse(
      (await server().get('/api/v1/system').set(as(manager))).body,
    );
    expect(system.backup?.lastError).toBe(partial.error);
    const heartbeat: unknown = app.get(HeartbeatService);
    const report = await (
      heartbeat as { collect(errors: number): Promise<{ backup: unknown }> }
    ).collect(0);
    expect(report.backup).toMatchObject({ lastError: partial.error });

    // The data drive folder cannot be made: nothing is backed up.
    await setSecondLocation(null);
    const fullFolder = join(dataDir, 'backups', 'full');
    const moved = `${fullFolder}-moved`;
    await import('node:fs/promises').then((fs) => fs.rename(fullFolder, moved));
    writeFileSync(fullFolder, 'in the way');
    const failed = await backUp();
    expect(failed).toMatchObject({ status: 'FAILED', fileName: null });
    await import('node:fs/promises').then(async (fs) => {
      await fs.rm(fullFolder);
      await fs.rename(moved, fullFolder);
    });

    // It works again: the alert closes.
    const fixed = await backUp();
    expect(fixed).toMatchObject({ status: 'SUCCEEDED', secondCopy: 'NOT_SET' });
    expect(
      await prisma.alert.count({
        where: { restaurantId: kit.restaurantId, dedupeKey: 'backup', status: 'OPEN' },
      }),
    ).toBe(0);
    expect((await overview()).health).toBe('OK');
  });

  it('marks a backup cut off by a restart as failed', async () => {
    const stuck = await prisma.backupRun.create({
      data: { kind: 'NIGHTLY', status: 'RUNNING', startedAt: now },
    });
    await backups.onApplicationBootstrap();
    expect(await prisma.backupRun.findUniqueOrThrow({ where: { id: stuck.id } })).toMatchObject({
      status: 'FAILED',
      error: 'The backup was interrupted (the server stopped).',
    });
  });
});

describe('[DATA-002] the nightly backup', () => {
  it('runs once after its time, then waits for the next night', async () => {
    now = new Date('2026-10-06T23:10:00.000Z'); // 04:40 in India
    const run = await backups.runIfDue();
    expect(run).toMatchObject({ kind: 'NIGHTLY' });
    await backups.settled();
    expect(await prisma.backupRun.findUniqueOrThrow({ where: { id: run!.id } })).toMatchObject({
      status: 'SUCCEEDED',
      requestedById: null,
    });
    now = new Date('2026-10-06T23:40:00.000Z');
    expect(await backups.runIfDue()).toBeNull();
  });

  it('[SEC-003] is not for waiters', async () => {
    const response = await server().get('/api/v1/backups').set(as(waiter));
    expect([response.status, ApiError.parse(response.body).code]).toEqual([403, 'FORBIDDEN']);
    expect((await server().post('/api/v1/backups').set(as(waiter))).status).toBe(403);
  });
});
