import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  CloudBackupListResponse,
  CloudBackupView,
  FleetResponse,
  StartCloudBackupResponse,
} from '@rp/contracts/control-plane';
import type { TestDatabase } from '@rp/test-postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CloudBackupsService,
  OBJECT_STORE,
} from '../../src/cloud-backups/cloud-backups.service.js';
import { LocalObjectStore } from '../../src/cloud-backups/local-object-store.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { enrolledInstallation, signedGet, signedPost } from '../helpers/fleet.js';
import { createTestApp, createTestDatabase, httpServer } from '../helpers/test-app.js';
import type { TestInstallation } from '../helpers/test-installation.js';
import { bearer, signInVendor, vendorAccount } from '../helpers/vendor.js';

/**
 * The encrypted cloud backup (P7-05d, DATA-003): a PC uploads its backup file in parts with signed
 * URLs, completes it, and the retention keeps 30 daily and 12 monthly per PC. The local store
 * stands in for S3 here, with 1 MiB parts so a small file has several.
 */

const PART = 1024 * 1024;
let database: TestDatabase;
let app: INestApplication;
let store: LocalObjectStore;
let pc: TestInstallation;
let other: TestInstallation;
let vendorToken: string;
const server = () => request(httpServer(app));

function backupFile(sizeBytes: number) {
  const bytes = randomBytes(sizeBytes);
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function startBody(file: { bytes: Buffer; sha256: string }, createdAt = '2026-10-03T23:00:00Z') {
  const stamp = createdAt.replace(/[-:]/g, '').replace('.000', '');
  return JSON.stringify({
    fileName: `rp-backup-${stamp}-nightly.rpbk`,
    backupCreatedAt: new Date(createdAt).toISOString(),
    sizeBytes: file.bytes.length,
    sha256: file.sha256,
    keyId: '0123456789abcdef',
  });
}

/** PUTs each part as the PC does, with its Content-MD5; returns the ETags. */
async function putParts(started: StartCloudBackupResponse, bytes: Buffer) {
  const parts = [];
  for (const part of started.parts) {
    const chunk = bytes.subarray(
      (part.number - 1) * started.partSize,
      part.number * started.partSize,
    );
    const response = await server()
      .put(part.url)
      .set('content-type', 'application/octet-stream')
      .set('content-md5', createHash('md5').update(chunk).digest('base64'))
      .send(chunk);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    parts.push({ number: part.number, etag: String(response.headers.etag) });
  }
  return parts;
}

async function upload(
  installation: TestInstallation,
  file: { bytes: Buffer; sha256: string },
  createdAt?: string,
) {
  const started = await signedPost(
    app,
    installation,
    '/v1/cloud-backups',
    startBody(file, createdAt),
  );
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const body = StartCloudBackupResponse.parse(started.body);
  const parts = await putParts(body, file.bytes);
  const path = `/v1/cloud-backups/${body.id}/complete`;
  return { body, parts, path };
}

beforeAll(async () => {
  database = await createTestDatabase();
  store = new LocalObjectStore(mkdtempSync(join(tmpdir(), 'cp-cloud-')), { partBytes: PART });
  app = await createTestApp(database.url, {}, [{ provide: OBJECT_STORE, useValue: store }]);
  pc = await enrolledInstallation(app);
  other = await enrolledInstallation(app);
  vendorToken = await signInVendor(app, await vendorAccount(app, 'READ_ONLY'));
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('[DATA-003] uploading a backup to the cloud', () => {
  it('takes a backup in parts and stores it byte for byte; the same file again is already there', async () => {
    const file = backupFile(2 * PART + 1234);
    const { body, parts, path } = await upload(pc, file);
    expect(body).toMatchObject({ status: 'UPLOADING', partSize: PART });
    expect(body.parts).toHaveLength(3);
    // Only the PC that started it may complete it.
    const foreign = await signedPost(app, other, path, JSON.stringify({ parts }));
    expect(foreign.status).toBe(404);
    // Every part must be there.
    const missing = await signedPost(app, pc, path, JSON.stringify({ parts: parts.slice(1) }));
    expect([missing.status, ApiError.parse(missing.body).code]).toEqual([
      422,
      'CLOUD_BACKUP_INCOMPLETE',
    ]);
    const done = await signedPost(app, pc, path, JSON.stringify({ parts }));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(CloudBackupView.parse(done.body)).toMatchObject({
      status: 'COMPLETE',
      sizeBytes: file.bytes.length,
      sha256: file.sha256,
    });
    const row = await app
      .get(PrismaService)
      .cloudBackup.findUniqueOrThrow({ where: { id: body.id } });
    const download = store.verify((await store.downloadUrl(row.objectKey, 60)).split('/').at(-1)!);
    const chunks: Buffer[] = [];
    for await (const chunk of store.open(download!)) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(file.bytes)).toBe(true);
    expect(
      await app.get(PrismaService).auditEntry.count({
        where: { action: 'cloud_backup.stored', targetId: pc.id ?? '' },
      }),
    ).toBe(1);

    const again = await signedPost(app, pc, '/v1/cloud-backups', startBody(file));
    expect(StartCloudBackupResponse.parse(again.body)).toMatchObject({
      id: body.id,
      status: 'COMPLETE',
      parts: [],
    });
    const listed = await signedGet(app, pc, '/v1/cloud-backups');
    expect(CloudBackupListResponse.parse(listed.body).backups.map((b) => b.id)).toEqual([body.id]);
    expect(
      CloudBackupListResponse.parse((await signedGet(app, other, '/v1/cloud-backups')).body),
    ).toEqual({ backups: [] });
  });

  it('refuses a part that does not match its MD5, an expired URL, and a changed one', async () => {
    const file = backupFile(1000);
    const started = StartCloudBackupResponse.parse(
      (await signedPost(app, pc, '/v1/cloud-backups', startBody(file, '2026-10-04T23:00:00Z')))
        .body,
    );
    const url = started.parts[0]!.url;
    const bad = await server()
      .put(url)
      .set('content-type', 'application/octet-stream')
      .set('content-md5', createHash('md5').update('other').digest('base64'))
      .send(file.bytes);
    expect([bad.status, ApiError.parse(bad.body).code]).toEqual([400, 'BAD_DIGEST']);
    const changed = await server()
      .put(`${url.slice(0, -3)}AAA`)
      .set('content-type', 'application/octet-stream')
      .send(file.bytes);
    expect(changed.status).toBe(403);
    // Starting the same file again gives the unfinished upload up.
    const restarted = StartCloudBackupResponse.parse(
      (await signedPost(app, pc, '/v1/cloud-backups', startBody(file, '2026-10-04T23:00:00Z')))
        .body,
    );
    expect(restarted.id).not.toBe(started.id);
    const old = await app
      .get(PrismaService)
      .cloudBackup.findUniqueOrThrow({ where: { id: started.id } });
    expect(old.status).toBe('ABORTED');
    const abort = await signedPost(app, pc, `/v1/cloud-backups/${restarted.id}/abort`, '');
    expect(abort.status).toBe(204);
  });

  it('[DATA-002] keeps the newest of each of the last 30 days and 12 months per PC (§9.3)', async () => {
    const service = app.get(CloudBackupsService);
    // 60 nightly backups for the other PC, one a day.
    for (let day = 0; day < 60; day += 1) {
      const createdAt = new Date(Date.UTC(2026, 7, 1 + day, 23, 0, 0)).toISOString();
      const file = backupFile(100);
      const { path, parts } = await upload(other, file, createdAt);
      expect((await signedPost(app, other, path, JSON.stringify({ parts }))).status).toBe(200);
    }
    const kept = await service.list(other.id ?? '');
    // 2 August to 30 September in India: the 30 days of September, and August's last night.
    expect(kept.length).toBe(31);
    expect(kept[0]?.backupCreatedAt).toBe('2026-09-29T23:00:00.000Z');
    expect(kept.at(-1)?.backupCreatedAt).toBe('2026-08-30T23:00:00.000Z');
    const deleted = await app.get(PrismaService).cloudBackup.findMany({
      where: { installationId: other.id ?? '', status: 'DELETED' },
    });
    expect(deleted.length + kept.length).toBe(60);
    // Removed from the store too.
    for (const row of deleted.slice(0, 3)) expect(await store.sizeOf(row.objectKey)).toBeNull();
    // The first PC's backups are its own: untouched.
    expect((await service.list(pc.id ?? '')).length).toBe(1);
  }, 120_000);

  it('[VCP-005] shows vendor staff each PC’s cloud backups and the newest in the fleet view', async () => {
    const listed = await server()
      .get(`/v1/vendor/installations/${pc.id ?? ''}/cloud-backups`)
      .set(bearer(vendorToken));
    expect(listed.status).toBe(200);
    expect(CloudBackupListResponse.parse(listed.body).backups).toHaveLength(1);
    const fleet = FleetResponse.parse(
      (await server().get('/v1/vendor/fleet').set(bearer(vendorToken))).body,
    );
    const row = fleet.installations.find((entry) => entry.installationId === pc.id);
    expect(row?.cloudBackupAt).toBe('2026-10-03T23:00:00.000Z');
  });
});

describe('[DATA-003] without a store', () => {
  it('tells the PC the cloud backup is not set up', async () => {
    const off = await createTestApp(database.url);
    try {
      const response = await signedPost(off, pc, '/v1/cloud-backups', startBody(backupFile(10)));
      expect([response.status, ApiError.parse(response.body).code]).toEqual([
        503,
        'CLOUD_BACKUP_OFF',
      ]);
    } finally {
      await off.close();
    }
  });
});
