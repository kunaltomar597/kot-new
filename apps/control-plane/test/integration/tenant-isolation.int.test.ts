import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  CloudBackupListResponse,
  CloudBackupView,
  CONTROL_PLANE_ROUTES,
  DigitalBillView,
  DiagnosticsRequestView,
  HeartbeatResponse,
  type MenuDraft,
  MenuExtractionView,
  StartCloudBackupResponse,
  UpdatesResponse,
} from '@rp/contracts/control-plane';
import type { TestDatabase } from '@rp/test-postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OBJECT_STORE } from '../../src/cloud-backups/cloud-backups.service.js';
import { LocalObjectStore } from '../../src/cloud-backups/local-object-store.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { BILL_SENDERS, type BillSender } from '../../src/digital-bills/bill-sender.js';
import { MenuExtractionsService } from '../../src/menu-import/menu-extractions.service.js';
import { MENU_EXTRACTOR, type MenuExtractor } from '../../src/menu-import/menu-extractor.js';
import { enrolledInstallation, heartbeatBody, signedGet, signedPost } from '../helpers/fleet.js';
import { createTestApp, createTestDatabase, httpServer } from '../helpers/test-app.js';
import type { TestInstallation } from '../helpers/test-installation.js';
import { bearer, signInVendor, vendorAccount } from '../helpers/vendor.js';

/**
 * Tenant isolation in the Control Plane (SEC-005, ADR-0021, threat CP-I4): one restaurant's PC
 * calls every endpoint a PC may call with another restaurant's ids, and reaches nothing of the
 * other's. Each PC endpoint is listed below with what it is called with, so a new one fails here
 * until it is.
 */

const DRAFT: MenuDraft = { categories: [], addOns: [], notes: ['Nothing on this page'] };
const reader: MenuExtractor = {
  configured: true,
  extract: () =>
    Promise.resolve({ draft: DRAFT, model: 'scripted', inputTokens: 1, outputTokens: 1 }),
};
const whatsapp: BillSender = {
  channel: 'WHATSAPP',
  send: () => Promise.resolve({ providerMessageId: 'wamid.ok' }),
};

const PART = 1024 * 1024;
const KEY_ID = '0123456789abcdef';
const escrowKey = generateKeyPairSync('rsa', { modulusLength: 3072 });
let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
/** The restaurant whose things the other one tries to reach. */
let own: TestInstallation;
let neighbour: TestInstallation;
const server = () => request(httpServer(app));

/** What `own` has, for the neighbour to name. */
const ids = {
  extraction: '',
  billRequest: '',
  /** The link of their digital bill. */
  bill: '',
  diagnosticsRequest: '',
  uploading: '',
  stored: '',
  storedSha: '',
  heartbeat: '',
  escrowKeyId: '',
};

function backupBody(bytes: Buffer) {
  return JSON.stringify({
    fileName: 'rp-backup-20261003T230000Z-nightly.rpbk',
    backupCreatedAt: '2026-10-03T23:00:00.000Z',
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    keyId: KEY_ID,
  });
}

async function putParts(started: StartCloudBackupResponse, bytes: Buffer) {
  const parts = [];
  for (const part of started.parts) {
    const chunk = bytes.subarray(
      (part.number - 1) * started.partSize,
      part.number * started.partSize,
    );
    const put = await server()
      .put(part.url)
      .set('content-type', 'application/octet-stream')
      .set('content-md5', createHash('md5').update(chunk).digest('base64'))
      .send(chunk);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    parts.push({ number: part.number, etag: String(put.headers.etag) });
  }
  return parts;
}

function escrow(installation: TestInstallation, wrappedKey: string) {
  const path = '/v1/backup-key-escrow';
  const body = JSON.stringify({ keyId: KEY_ID, escrowKeyId: ids.escrowKeyId, wrappedKey });
  return request(httpServer(app))
    .put(path)
    .set(installation.headers('PUT', path, body))
    .set('content-type', 'application/json')
    .send(body);
}

beforeAll(async () => {
  database = await createTestDatabase();
  const store = new LocalObjectStore(mkdtempSync(join(tmpdir(), 'cp-tenants-')), {
    partBytes: PART,
  });
  app = await createTestApp(
    database.url,
    {
      publicUrl: 'https://cloud.example.in',
      digitalBillKey: Buffer.alloc(32, 9).toString('base64'),
      escrowPrivateKey: escrowKey.privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64'),
    },
    [
      { provide: OBJECT_STORE, useValue: store },
      { provide: MENU_EXTRACTOR, useValue: reader },
      { provide: BILL_SENDERS, useValue: { WHATSAPP: whatsapp } },
    ],
  );
  prisma = app.get(PrismaService);
  own = await enrolledInstallation(app);
  neighbour = await enrolledInstallation(app);

  // A menu reading, a digital bill, a support request, an upload under way and one stored, a
  // heartbeat and a release for this PC alone: everything a PC can name by id.
  const photo = { name: 'menu.jpg', contentType: 'image/jpeg', contentBase64: 'AAAA' };
  const reading = await signedPost(
    app,
    own,
    '/v1/menu-extractions',
    JSON.stringify({ files: [photo] }),
  );
  expect(reading.status, JSON.stringify(reading.body)).toBe(202);
  ids.extraction = MenuExtractionView.parse(reading.body).id;
  await app.get(MenuExtractionsService).settled();

  ids.billRequest = randomUUID();
  const sent = await signedPost(
    app,
    own,
    '/v1/digital-bills',
    JSON.stringify({
      id: ids.billRequest,
      channel: 'WHATSAPP',
      phone: '+919876543210',
      restaurantName: 'Spice Route',
      invoiceNumber: 'INV/26-27/0001',
      invoiceDate: '2026-10-04',
      grandTotal: 10_000,
      lines: ['TOTAL Rs 100.00'],
      keepDays: 30,
    }),
  );
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  ids.bill = DigitalBillView.parse(sent.body).link ?? '';

  const support = await signInVendor(app, await vendorAccount(app, 'SUPPORT'));
  const asked = await server()
    .post(`/v1/vendor/installations/${own.id ?? ''}/diagnostics-requests`)
    .set(bearer(support))
    .send({ reason: 'Printer stops at night' });
  expect(asked.status, JSON.stringify(asked.body)).toBe(201);
  ids.diagnosticsRequest = DiagnosticsRequestView.parse(asked.body).id;

  const stored = randomBytes(1000);
  const storing = StartCloudBackupResponse.parse(
    (await signedPost(app, own, '/v1/cloud-backups', backupBody(stored))).body,
  );
  const parts = await putParts(storing, stored);
  const done = await signedPost(
    app,
    own,
    `/v1/cloud-backups/${storing.id}/complete`,
    JSON.stringify({ parts }),
  );
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  ids.stored = CloudBackupView.parse(done.body).id;
  ids.storedSha = CloudBackupView.parse(done.body).sha256;
  ids.uploading = StartCloudBackupResponse.parse(
    (await signedPost(app, own, '/v1/cloud-backups', backupBody(randomBytes(2000)))).body,
  ).id;

  ids.heartbeat = randomUUID();
  const beat = await signedPost(
    app,
    own,
    '/v1/heartbeats',
    heartbeatBody({ heartbeatId: ids.heartbeat, backupKeyId: KEY_ID }),
  );
  expect(beat.status).toBe(200);
  ids.escrowKeyId = HeartbeatResponse.parse(beat.body).backupKeyEscrow?.escrowKeyId ?? '';
  expect((await escrow(own, 'A'.repeat(512))).status).toBe(204);

  const admin = await signInVendor(app, await vendorAccount(app, 'SUPER_ADMIN'));
  const hotfix = await server()
    .post('/v1/vendor/releases')
    .set(bearer(admin))
    .send({
      component: 'RESTAURANT_PC',
      channel: 'STABLE',
      version: '1.0.1-hotfix.1',
      url: 'https://downloads.example.com/rp/1.0.1-hotfix.1/setup.exe',
      sha256: 'e'.repeat(64),
      sizeBytes: 150_000_000,
      targetInstallationId: own.id,
    });
  expect(hotfix.status, JSON.stringify(hotfix.body)).toBe(201);
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const codeOf = (response: request.Response) => ApiError.parse(response.body).code;

/**
 * Each endpoint a PC may call, with the neighbour's call naming `own`'s ids and what shows it
 * reached nothing of theirs. An endpoint that takes no id names only the caller's own things.
 */
const CASES: Record<string, () => Promise<void>> = {
  'GET /v1/menu-extractions/:extractionId': async () => {
    const read = await signedGet(app, neighbour, `/v1/menu-extractions/${ids.extraction}`);
    expect([read.status, codeOf(read)]).toEqual([404, 'MENU_EXTRACTION_NOT_FOUND']);
  },
  'POST /v1/menu-extractions': async () => {
    // A new reading is the neighbour's own: it never answers with another's.
    const photo = { name: 'menu.jpg', contentType: 'image/jpeg', contentBase64: 'AAAA' };
    const reading = await signedPost(
      app,
      neighbour,
      '/v1/menu-extractions',
      JSON.stringify({ files: [photo] }),
    );
    expect(reading.status).toBe(202);
    const row = await prisma.menuExtraction.findUniqueOrThrow({
      where: { id: MenuExtractionView.parse(reading.body).id },
    });
    expect(row.installationId).toBe(neighbour.id);
    await app.get(MenuExtractionsService).settled();
  },
  'POST /v1/cloud-backups/:id/complete': async () => {
    const complete = await signedPost(
      app,
      neighbour,
      `/v1/cloud-backups/${ids.uploading}/complete`,
      JSON.stringify({ parts: [{ number: 1, etag: '"x"' }] }),
    );
    expect(complete.status).toBe(404);
  },
  'POST /v1/cloud-backups/:id/abort': async () => {
    const abort = await signedPost(app, neighbour, `/v1/cloud-backups/${ids.uploading}/abort`, '');
    expect(abort.status).toBe(404);
    const row = await prisma.cloudBackup.findUniqueOrThrow({ where: { id: ids.uploading } });
    expect(row.status).toBe('UPLOADING');
  },
  'POST /v1/cloud-backups': async () => {
    // The same file as the other's stored backup: an upload of its own, never "already there".
    const same = await signedPost(
      app,
      neighbour,
      '/v1/cloud-backups',
      JSON.stringify({ ...JSON.parse(backupBody(randomBytes(1000))), sha256: ids.storedSha }),
    );
    expect(same.status, JSON.stringify(same.body)).toBe(201);
    const started = StartCloudBackupResponse.parse(same.body);
    expect(started.status).toBe('UPLOADING');
    expect(started.id).not.toBe(ids.stored);
  },
  'GET /v1/cloud-backups': async () => {
    const listed = CloudBackupListResponse.parse(
      (await signedGet(app, neighbour, '/v1/cloud-backups')).body,
    );
    expect(listed.backups).toEqual([]);
  },
  'POST /v1/diagnostics-requests/:id/decline': async () => {
    const declined = await signedPost(
      app,
      neighbour,
      `/v1/diagnostics-requests/${ids.diagnosticsRequest}/decline`,
      JSON.stringify({ by: { name: 'Ravi', role: 'MANAGER' } }),
    );
    expect(declined.status).toBe(404);
  },
  'POST /v1/diagnostics': async () => {
    const answered = await signedPost(
      app,
      neighbour,
      '/v1/diagnostics',
      JSON.stringify({
        bundle: {
          format: 1,
          generatedAt: new Date().toISOString(),
          installationId: own.id,
          versions: [],
          platform: {
            os: 'win32',
            release: '10',
            arch: 'x64',
            cpus: 4,
            memoryMb: 8_192,
            uptimeSeconds: 1,
            serverUptimeSeconds: 1,
          },
          configuration: {},
          settings: {},
          status: {},
          devices: [],
          logs: { files: [], truncated: false },
        },
        note: null,
        sentBy: null,
        requestId: ids.diagnosticsRequest,
      }),
    );
    expect(answered.status).toBe(404);
    const asked = await prisma.diagnosticsRequest.findUniqueOrThrow({
      where: { id: ids.diagnosticsRequest },
    });
    expect(asked.state).toBe('PENDING');
    expect(await prisma.diagnosticsBundle.count({ where: { installationId: neighbour.id } })).toBe(
      0,
    );
  },
  'POST /v1/digital-bills': async () => {
    // The other's request id makes a bill of the neighbour's own; theirs is left as it was.
    const sent = await signedPost(
      app,
      neighbour,
      '/v1/digital-bills',
      JSON.stringify({
        id: ids.billRequest,
        channel: 'WHATSAPP',
        phone: '+919812345678',
        restaurantName: 'Corner Cafe',
        invoiceNumber: 'CC/26-27/0001',
        invoiceDate: '2026-10-04',
        grandTotal: 5_000,
        lines: ['TOTAL Rs 50.00'],
        keepDays: 30,
      }),
    );
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(DigitalBillView.parse(sent.body).link).not.toBe(ids.bill);
    const both = await prisma.digitalBill.findMany({
      where: { requestId: ids.billRequest },
      orderBy: { createdAt: 'asc' },
    });
    expect(both.map((row) => [row.installationId, row.restaurantName, row.attempts])).toEqual([
      [own.id, 'Spice Route', 1],
      [neighbour.id, 'Corner Cafe', 1],
    ]);
  },
  'POST /v1/heartbeats': async () => {
    // The other's heartbeat id is stored as the neighbour's; the answer carries only its own.
    const answer = await signedPost(
      app,
      neighbour,
      '/v1/heartbeats',
      heartbeatBody({ heartbeatId: ids.heartbeat }),
    );
    expect(answer.status).toBe(200);
    expect(HeartbeatResponse.parse(answer.body).update).toBeNull();
    expect(await prisma.heartbeat.count({ where: { id: ids.heartbeat } })).toBe(2);
  },
  'GET /v1/updates': async () => {
    const offered = UpdatesResponse.parse(
      (await signedGet(app, neighbour, '/v1/updates?version=1.0.0')).body,
    );
    expect(offered.update).toBeNull();
    // The release made for the other PC is still theirs.
    const theirs = UpdatesResponse.parse(
      (await signedGet(app, own, '/v1/updates?version=1.0.0')).body,
    );
    expect(theirs.update?.version).toBe('1.0.1-hotfix.1');
  },
  'PUT /v1/backup-key-escrow': async () => {
    // The same key id as the other's: kept as the neighbour's own; theirs is left as it was.
    expect((await escrow(neighbour, 'B'.repeat(512))).status).toBe(204);
    const kept = await prisma.backupKeyEscrow.findMany({
      where: { keyId: KEY_ID },
      orderBy: { createdAt: 'asc' },
    });
    expect(kept.map((row) => [row.installationId, row.wrappedKey[0]])).toEqual([
      [own.id, 'A'],
      [neighbour.id, 'B'],
    ]);
  },
};

describe('[SEC-005] [SEC-003] one restaurant’s PC reaches nothing of another’s', () => {
  it('has a case for every endpoint a restaurant PC may call', () => {
    const pcEndpoints = CONTROL_PLANE_ROUTES.filter((route) => route.capability === 'INSTALLATION')
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    expect(Object.keys(CASES).sort()).toEqual(pcEndpoints);
  });

  for (const [endpoint, call] of Object.entries(CASES)) {
    it(`calls ${endpoint} with the other restaurant’s ids`, call);
  }

  it('leaves the other restaurant’s things as they were', async () => {
    expect(
      await prisma.menuExtraction.findUniqueOrThrow({ where: { id: ids.extraction } }),
    ).toMatchObject({ installationId: own.id, status: 'DONE' });
    expect(await prisma.cloudBackup.findUniqueOrThrow({ where: { id: ids.stored } })).toMatchObject(
      { installationId: own.id, status: 'COMPLETE' },
    );
    expect(
      (await prisma.heartbeat.findFirstOrThrow({ where: { installationId: own.id ?? '' } })).id,
    ).toBe(ids.heartbeat);
  });
});
