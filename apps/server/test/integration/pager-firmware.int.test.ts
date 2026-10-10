import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  type LoginResponse,
  PagerCredentialResponse,
  PagerFirmwareOffer,
  PagerFirmwarePagerView,
  PagerFirmwareResponse,
} from '@rp/contracts';
import type { ReleaseInfo } from '@rp/contracts/control-plane';
import mqtt, { type MqttClient } from 'mqtt';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { NOTIFICATION_OPTIONS } from '../../src/notifications/clock.js';
import { PAGER_OPTIONS, PagerBroker } from '../../src/pagers/pager-broker.js';
import {
  firmwareDir,
  firmwareHeartbeat,
  markFirmwareReportDelivered,
  readServedFirmware,
  saveOfferedFirmware,
  saveServedFirmware,
} from '../../src/pager-firmware/firmware-state.js';
import {
  PAGER_FIRMWARE_OPTIONS,
  PagerFirmwareService,
} from '../../src/pager-firmware/pager-firmware.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { firmwareImage, firmwareKey, signFirmware } from '../helpers/pager-firmware.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';
import { until } from '../helpers/wait.js';

/**
 * Pager firmware through the restaurant PC (P2-04b, PGR-011, UPD-003, UPD-004, UPD-007): the
 * vendor's release fetched and checked against the trusted key, offered over MQTT to a free pager
 * (a real MQTT client in its place), downloaded with the offer's token, and the pager's reports.
 */

const key = firmwareKey();
const stranger = firmwareKey();
const IMAGE = signFirmware(firmwareImage({ version: '1.1.0', secureVersion: 2 }), key);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const files = new Map<string, Buffer>([
  ['https://downloads.example.com/pager/rp-pager-1.1.0.bin', IMAGE],
  [
    'https://downloads.example.com/pager/rp-pager-1.2.0.bin',
    signFirmware(firmwareImage({ version: '1.2.0' }), stranger),
  ],
  [
    'https://downloads.example.com/pager/rp-pager-1.4.0.bin',
    signFirmware(firmwareImage({ version: '1.4.0', secureVersion: 1 }), key),
  ],
]);

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let service: PagerFirmwareService;
let kit: AuthKit;
let manager: LoginResponse;
let waiter: LoginResponse;
let port: number;
const dataDir = mkdtempSync(join(tmpdir(), 'rp-pager-firmware-'));
/** 14:30 in India: outside the 03:00-06:00 maintenance window. */
let now = new Date('2026-10-05T09:00:00.000Z');
const fetched: string[] = [];
let offline = false;
const clients: MqttClient[] = [];
/** The broker's clock for the heartbeat rate: each heartbeat comes a minute after the last. */
let brokerMs = 0;

const fakeFetch = ((url: string | URL | Request) => {
  const address = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
  fetched.push(address);
  if (offline) return Promise.reject(new Error('getaddrinfo ENOTFOUND downloads.example.com'));
  const body = files.get(address);
  return Promise.resolve(
    body === undefined
      ? new Response('missing', { status: 404 })
      : new Response(new Uint8Array(body)),
  );
}) as typeof fetch;

const release = (version: string, overrides: Partial<ReleaseInfo> = {}): ReleaseInfo => {
  const url = `https://downloads.example.com/pager/rp-pager-${version}.bin`;
  const body = files.get(url) ?? Buffer.alloc(10);
  return {
    component: 'PAGER_FIRMWARE',
    channel: 'STABLE',
    version,
    url,
    sha256: sha(body),
    sizeBytes: body.length,
    notes: null,
    publishedAt: '2026-10-01T10:00:00.000Z',
    securityCritical: false,
    matrix: null,
    ...overrides,
  };
};

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({
    databaseUrl: database.url,
    config: {
      mqtt: 'on',
      mqttPort: 0,
      host: '127.0.0.1',
      dataDir,
      pagerFirmwareKeys: [key.digest],
    },
    overrides: [
      { provide: NOTIFICATION_OPTIONS, useValue: { tickMs: 0 } },
      { provide: PAGER_OPTIONS, useValue: { offlineCheckMs: 0, clockMs: () => brokerMs } },
      {
        provide: PAGER_FIRMWARE_OPTIONS,
        useValue: {
          firstDelayMs: 0,
          tickMs: 0,
          tokenTtlMs: 15 * 60_000,
          fetch: fakeFetch,
          now: () => now,
        },
      },
    ],
  });
  prisma = app.get(PrismaService);
  service = app.get(PagerFirmwareService);
  port = app.get(PagerBroker).port() ?? 0;
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  waiter = await signIn(app, kit, 'WAITER');
}, 60_000);

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.endAsync(true)));
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const server = () => request(httpServer(app));
const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);

async function register(serial: string, staffId: string | null) {
  const response = await server()
    .post('/api/v1/pagers')
    .set(as(manager))
    .send({ serial, name: `Pager ${serial}`, staffId });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return PagerCredentialResponse.parse(response.body);
}

interface Pager {
  client: MqttClient;
  offers: PagerFirmwareOffer[];
  credential: PagerCredentialResponse;
  beat: (body: Record<string, unknown>) => Promise<void>;
}

let rssi = -40;

async function connect(credential: PagerCredentialResponse): Promise<Pager> {
  const client = await mqtt.connectAsync(`mqtt://127.0.0.1:${String(port)}`, {
    clientId: credential.deviceId,
    username: credential.mqttUsername,
    password: credential.mqttPassword,
    clean: true,
    reconnectPeriod: 0,
  });
  clients.push(client);
  const offers: PagerFirmwareOffer[] = [];
  const ota = credential.alertsTopic.replace(/alerts$/, 'ota');
  client.on('message', (topic, payload) => {
    if (topic === ota) offers.push(PagerFirmwareOffer.parse(JSON.parse(payload.toString())));
  });
  const granted = await client.subscribeAsync(ota, { qos: 1 });
  expect(granted[0]?.qos).toBe(1);
  return {
    client,
    offers,
    credential,
    // Each heartbeat carries its own signal strength, so the test sees when it was stored.
    beat: async (body) => {
      brokerMs += 60_000;
      rssi -= 1;
      const mine = rssi;
      await client.publishAsync(
        credential.heartbeatTopic,
        JSON.stringify({ battery: 80, rssi: mine, firmware: '1.0.0', ...body }),
        { qos: 1 },
      );
      await until(
        async () =>
          (await prisma.device.findUnique({ where: { id: credential.deviceId } }))?.rssi === mine,
        5_000,
        'the heartbeat to be stored',
      );
      await service.settled();
    },
  };
}

async function firmwareStatus(): Promise<PagerFirmwareResponse> {
  const response = await server().get('/api/v1/pagers/firmware').set(as(manager));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return PagerFirmwareResponse.parse(response.body);
}

async function pagerStatus(deviceId: string): Promise<PagerFirmwarePagerView | undefined> {
  return (await firmwareStatus()).pagers.find((pager) => pager.deviceId === deviceId);
}

const row = (deviceId: string, version = '1.1.0') =>
  prisma.pagerFirmwareUpdate.findUnique({ where: { deviceId_version: { deviceId, version } } });

describe('[PGR-011] [UPD-007] the release the vendor offers', () => {
  it('passes on nothing before a release is checked', async () => {
    expect(await firmwareStatus()).toEqual({ firmware: null, incoming: null, pagers: [] });
    expect(await firmwareHeartbeat(prisma)).toEqual({ version: null, report: null });
  });

  it('downloads the release, checks the image and its signature, and serves it', async () => {
    await saveOfferedFirmware(prisma, {
      update: release('1.1.0'),
      halted: false,
      forVersion: null,
    });
    expect((await firmwareStatus()).incoming).toEqual({ version: '1.1.0', problem: null });
    await service.runOnce();
    const served = await readServedFirmware(prisma);
    expect(served).toMatchObject({ version: '1.1.0', sha256: sha(IMAGE), keyDigest: key.digest });
    expect(readdirSync(firmwareDir(dataDir))).toEqual(['rp-pager-1.1.0.bin']);
    // The Control Plane hears the PC took it (UPD-003), once.
    const beat = await firmwareHeartbeat(prisma);
    expect(beat).toMatchObject({
      version: '1.1.0',
      report: { version: '1.1.0', outcome: 'INSTALLED' },
    });
    await markFirmwareReportDelivered(prisma, beat.report!);
    expect((await firmwareHeartbeat(prisma)).report).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: 'PAGER_FIRMWARE_ACCEPTED' } });
    expect(audit?.after).toMatchObject({ version: '1.1.0', keyDigest: key.digest });
    expect(await firmwareStatus()).toMatchObject({
      firmware: { version: '1.1.0', halted: false },
      incoming: null,
    });
    fetched.length = 0;
    await service.runOnce();
    expect(fetched).toEqual([]);
  });

  it('refuses for good a release signed with a key the pagers do not trust', async () => {
    await saveOfferedFirmware(prisma, {
      update: release('1.2.0'),
      halted: false,
      forVersion: '1.1.0',
    });
    await service.runOnce();
    expect((await readServedFirmware(prisma))?.version).toBe('1.1.0');
    expect((await firmwareStatus()).incoming).toMatchObject({
      version: '1.2.0',
      problem: { code: 'UNTRUSTED_KEY', refused: true },
    });
    expect((await firmwareHeartbeat(prisma)).report).toMatchObject({
      version: '1.2.0',
      outcome: 'FAILED',
    });
    expect(await prisma.auditLog.count({ where: { action: 'PAGER_FIRMWARE_REFUSED' } })).toBe(1);
    expect(readdirSync(firmwareDir(dataDir))).toEqual(['rp-pager-1.1.0.bin']);
    fetched.length = 0;
    await service.runOnce();
    expect(fetched).toEqual([]);
  });

  it('refuses for good a release that would lower the anti-rollback version', async () => {
    const served = await readServedFirmware(prisma);
    expect(served).toMatchObject({ version: '1.1.0', secureVersion: 2 });
    // What a PC kept before P8-03b2b has no secure version: it is read from the image it serves.
    const { secureVersion: _kept, ...older } = served!;
    await saveServedFirmware(prisma, older);
    // PAGER-T4: 1.4.0 is a newer version, signed by the trusted key, but goes back from 2 to 1.
    await saveOfferedFirmware(prisma, {
      update: release('1.4.0'),
      halted: false,
      forVersion: '1.1.0',
    });
    await service.runOnce();
    expect((await readServedFirmware(prisma))?.version).toBe('1.1.0');
    expect((await firmwareStatus()).incoming).toMatchObject({
      version: '1.4.0',
      problem: { code: 'SECURE_VERSION_LOWER', refused: true },
    });
    expect(
      await prisma.auditLog.count({
        where: { action: 'PAGER_FIRMWARE_REFUSED', after: { path: ['version'], equals: '1.4.0' } },
      }),
    ).toBe(1);
    expect(readdirSync(firmwareDir(dataDir))).toEqual(['rp-pager-1.1.0.bin']);
    await saveServedFirmware(prisma, served!);
  });

  it('refuses a download that is not the release, and tries a network failure again later', async () => {
    await saveOfferedFirmware(prisma, {
      update: release('1.1.5', {
        url: 'https://downloads.example.com/pager/rp-pager-1.1.0.bin',
        sha256: 'a'.repeat(64),
        sizeBytes: IMAGE.length,
      }),
      halted: false,
      forVersion: '1.1.0',
    });
    await service.runOnce();
    expect((await firmwareStatus()).incoming?.problem).toMatchObject({
      code: 'HASH',
      refused: true,
    });

    await saveOfferedFirmware(prisma, {
      update: release('1.3.0'),
      halted: false,
      forVersion: '1.1.0',
    });
    offline = true;
    await service.runOnce();
    expect((await firmwareStatus()).incoming?.problem).toMatchObject({
      code: 'NETWORK',
      refused: false,
    });
    fetched.length = 0;
    await service.runOnce();
    expect(fetched).toEqual([]);
    offline = false;
    now = new Date(now.getTime() + 6 * 60_000);
    await service.runOnce();
    // Reached the address this time: no such file there (HTTP 404), tried again later too.
    expect(fetched).toHaveLength(1);
    expect((await firmwareStatus()).incoming?.problem).toMatchObject({
      code: 'HTTP_STATUS',
      refused: false,
    });
    expect(existsSync(join(firmwareDir(dataDir), 'rp-pager-1.3.0.bin'))).toBe(false);
  });
});

describe('[PGR-011] [UPD-004] the pagers', () => {
  it('offers the firmware to a free pager, which downloads it with its token and runs it', async () => {
    const credential = await register('FREE-01', null);
    const pager = await connect(credential);
    expect(await pagerStatus(credential.deviceId)).toMatchObject({
      status: 'WAITING',
      waitFor: 'BATTERY',
    });
    await pager.beat({});
    const offer = await until(() => pager.offers[0], 5_000, 'a firmware offer');
    expect(offer).toMatchObject({
      version: '1.1.0',
      attempt: 1,
      sha256: sha(IMAGE),
      sizeBytes: IMAGE.length,
    });
    expect(offer.port).toBeGreaterThan(0);
    expect((await row(credential.deviceId))?.state).toBe('OFFERED');
    expect(await pagerStatus(credential.deviceId)).toMatchObject({ status: 'UPDATING' });

    const download = await server()
      .get(offer.path)
      .buffer(true)
      .parse((response, done) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          done(null, Buffer.concat(chunks));
        });
      });
    expect(download.status).toBe(200);
    expect(download.headers['cache-control']).toBe('no-store');
    expect(sha(download.body as Buffer)).toBe(offer.sha256);
    expect((await row(credential.deviceId))?.state).toBe('DOWNLOADING');

    await pager.beat({ firmware: '1.1.0' });
    await until(async () => (await row(credential.deviceId))?.state === 'UPDATED');
    expect(await pagerStatus(credential.deviceId)).toMatchObject({ status: 'UP_TO_DATE' });
    expect(pager.offers).toHaveLength(1);
  });

  it('refuses an unknown or expired download token', async () => {
    const unknown = await server().get(`/api/v1/pager-firmware/${'A'.repeat(43)}`);
    expect(unknown.status).toBe(404);
    expect((await server().get('/api/v1/pager-firmware/short')).status).toBe(400);
  });

  it('keeps a pager to its own firmware offers', async () => {
    const credential = await register('ACL-01', null);
    const other = await register('ACL-02', null);
    const pager = await connect(credential);
    await expect(
      pager.client.subscribeAsync(other.alertsTopic.replace(/alerts$/, 'ota'), { qos: 1 }),
    ).rejects.toThrow('Subscribe error');
  });

  it('waits for a worn pager until the window or "Update now", and tries a failure again later', async () => {
    const credential = await register('WORN-01', kit.staff.WAITER);
    const pager = await connect(credential);
    await pager.beat({});
    expect(await pagerStatus(credential.deviceId)).toMatchObject({
      status: 'WAITING',
      waitFor: 'IN_SERVICE',
    });
    expect(pager.offers).toEqual([]);

    const path = `/api/v1/pagers/${credential.deviceId}/firmware-update`;
    expect((await server().post(path).set(as(waiter))).status).toBe(403);
    const asked = await server().post(path).set(as(manager));
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(PagerFirmwarePagerView.parse(asked.body)).toMatchObject({
      status: 'UPDATING',
      requested: true,
    });
    const first = await until(() => pager.offers[0], 5_000, 'the first offer');
    expect(first.attempt).toBe(1);
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'PAGER_FIRMWARE_UPDATE_REQUESTED', entityId: credential.deviceId },
    });
    expect(audit?.actorId).toBe(kit.staff.MANAGER);

    // A report about another attempt changes nothing; this one's failure waits a while.
    await pager.beat({ ota: { version: '1.1.0', attempt: 9, state: 'FAILED', error: 'x' } });
    expect((await row(credential.deviceId))?.state).toBe('OFFERED');
    await pager.beat({
      ota: { version: '1.1.0', attempt: 1, state: 'FAILED', error: 'SHA-256 mismatch' },
    });
    expect(await pagerStatus(credential.deviceId)).toMatchObject({
      status: 'WAITING',
      waitFor: 'RETRY_LATER',
      error: 'SHA-256 mismatch',
      attempts: 1,
    });
    now = new Date(now.getTime() + 31 * 60_000);
    await pager.beat({});
    const second = await until(() => pager.offers[1], 5_000, 'the second offer');
    expect(second.attempt).toBe(2);
    expect(second.path).not.toBe(first.path);

    // It boots the new firmware, which does not come up, and goes back (PGR-011).
    const rolledBack = { version: '1.1.0', attempt: 2, state: 'ROLLED_BACK', error: 'no MQTT' };
    await pager.beat({ ota: rolledBack });
    expect(await pagerStatus(credential.deviceId)).toMatchObject({
      status: 'GAVE_UP',
      rolledBack: true,
    });
    expect((await firmwareHeartbeat(prisma)).report).toMatchObject({
      version: '1.1.0',
      outcome: 'ROLLED_BACK',
      error: 'no MQTT',
    });
    now = new Date(now.getTime() + 24 * 60 * 60_000);
    await pager.beat({});
    expect(pager.offers).toHaveLength(2);
    // "Update now" tries it again from the start, even while the pager still reports the old
    // rollback; here it waits for its battery first (above the 15 % that raises an alert).
    await pager.beat({ battery: 20, ota: rolledBack });
    expect((await server().post(path).set(as(manager))).status).toBe(200);
    await pager.beat({ battery: 20, ota: rolledBack });
    expect(await pagerStatus(credential.deviceId)).toMatchObject({
      status: 'WAITING',
      waitFor: 'BATTERY',
      rolledBack: false,
      requested: true,
    });
    await pager.beat({ battery: 90, ota: rolledBack });
    const third = await until(() => pager.offers[2], 5_000, 'the offer after "Update now"');
    // Offers keep their numbers, so the old report cannot be taken for this one.
    expect(third.attempt).toBe(3);
    await pager.beat({ battery: 90, ota: rolledBack });
    expect(await pagerStatus(credential.deviceId)).toMatchObject({
      status: 'UPDATING',
      attempts: 1,
    });
  });

  it('stops offering a version whose rollout the vendor halted', async () => {
    await saveOfferedFirmware(prisma, { update: null, halted: true, forVersion: '1.1.0' });
    const credential = await register('HALT-01', null);
    const pager = await connect(credential);
    await pager.beat({ charging: true, battery: 5 });
    expect((await firmwareStatus()).firmware?.halted).toBe(true);
    expect(await pagerStatus(credential.deviceId)).toMatchObject({
      status: 'WAITING',
      waitFor: null,
    });
    expect(pager.offers).toEqual([]);
    const asked = await server()
      .post(`/api/v1/pagers/${credential.deviceId}/firmware-update`)
      .set(as(manager));
    expect(asked.status).toBe(409);
    expect(asked.body).toMatchObject({ code: 'PAGER_FIRMWARE_HALTED' });
    await saveOfferedFirmware(prisma, { update: null, halted: false, forVersion: '1.1.0' });
    await pager.beat({ charging: true, battery: 5 });
    await until(() => pager.offers[0], 5_000, 'an offer once the rollout goes on');
  });

  it('answers "Update now" for a pager without firmware to update to', async () => {
    const credential = await register('CUR-01', null);
    const pager = await connect(credential);
    await pager.beat({ firmware: '1.1.0' });
    const asked = await server()
      .post(`/api/v1/pagers/${credential.deviceId}/firmware-update`)
      .set(as(manager));
    expect(asked.status).toBe(409);
    expect(asked.body).toMatchObject({ code: 'PAGER_FIRMWARE_CURRENT' });
    const missing = await server()
      .post(`/api/v1/pagers/${kit.deviceId}/firmware-update`)
      .set(as(manager));
    expect(missing.status).toBe(404);
  });
});
