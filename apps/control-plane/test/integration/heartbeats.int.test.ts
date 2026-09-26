import type { INestApplication } from '@nestjs/common';
import { HeartbeatResponse, UpdatesResponse } from '@rp/contracts/control-plane';
import type { TestDatabase } from '@rp/test-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../../src/admin/admin.service.js';
import type { PublishRelease } from '../../src/releases/releases.service.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import {
  ACTOR,
  enrolledInstallation,
  heartbeatBody,
  signedGet,
  signedPost,
} from '../helpers/fleet.js';
import { createTestApp, createTestDatabase } from '../helpers/test-app.js';
import type { TestInstallation } from '../helpers/test-installation.js';

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let admin: AdminService;
let stable: TestInstallation;
let pilot: TestInstallation;

function release(version: string, channel: 'STABLE' | 'PILOT' = 'STABLE') {
  return {
    component: 'RESTAURANT_PC',
    channel,
    version,
    url: `https://downloads.example.com/rp/${version}/setup.exe`,
    sha256: 'c'.repeat(64),
    sizeBytes: 150_000_000,
  } as const;
}

async function heartbeat(pc: TestInstallation, body = heartbeatBody()) {
  const response = await signedPost(app, pc, '/v1/heartbeats', body);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return HeartbeatResponse.parse(response.body);
}

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp(database.url, { heartbeatSeconds: 120 });
  prisma = app.get(PrismaService);
  admin = app.get(AdminService);
  stable = await enrolledInstallation(app, 'STABLE');
  pilot = await enrolledInstallation(app, 'PILOT');
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('[VCP-005] [NFR-O03] heartbeat ingest', () => {
  it('stores the heartbeat, marks the installation seen and sets the next interval', async () => {
    const body = heartbeatBody({ backups: { lastSuccessAt: null } });
    const answer = await heartbeat(stable, body);
    expect(answer.nextHeartbeatSeconds).toBe(120);
    expect(answer.update).toBeNull();
    expect(Math.abs(new Date(answer.serverTime).getTime() - Date.now())).toBeLessThan(10_000);

    const { heartbeatId } = JSON.parse(body) as { heartbeatId: string };
    const stored = await prisma.heartbeat.findUniqueOrThrow({
      where: { installationId_id: { installationId: stable.id ?? '', id: heartbeatId } },
    });
    // Fields this Control Plane does not know yet are kept (P7-03 reads them).
    expect(stored.payload).toMatchObject({ backups: { lastSuccessAt: null }, devices: { POS: 1 } });
    const installation = await prisma.installation.findUniqueOrThrow({
      where: { id: stable.id ?? '' },
    });
    expect(installation.lastSeenAt?.toISOString()).toBe(answer.receivedAt);
    expect(installation.lastHeartbeat).toMatchObject({ heartbeatId });
  });

  it('stores a retried heartbeat once', async () => {
    const body = heartbeatBody();
    await heartbeat(stable, body);
    await heartbeat(stable, body);
    const { heartbeatId } = JSON.parse(body) as { heartbeatId: string };
    expect(await prisma.heartbeat.count({ where: { id: heartbeatId } })).toBe(1);
  });

  it('refuses a heartbeat that does not match the contract', async () => {
    const response = await signedPost(
      app,
      stable,
      '/v1/heartbeats',
      heartbeatBody({ components: [] }),
    );
    expect(response.status).toBe(400);
  });
});

describe('[UPD-002] [UPD-007] release channels', () => {
  it('offers the newest release of the installation channel only when it is newer', async () => {
    await admin.publishRelease(release('1.1.0'), ACTOR);
    await admin.publishRelease(release('1.2.0-beta.1', 'PILOT'), ACTOR);
    await admin.publishRelease(release('1.0.5'), ACTOR);

    const onStable = await heartbeat(stable);
    expect(onStable.update).toMatchObject({ version: '1.1.0', channel: 'STABLE' });
    expect(onStable.update?.url).toMatch(/^https:/);

    const onPilot = await heartbeat(pilot);
    expect(onPilot.update).toMatchObject({ version: '1.2.0-beta.1', channel: 'PILOT' });

    const upToDate = await heartbeat(
      stable,
      heartbeatBody({ components: [{ name: 'RESTAURANT_PC', version: '1.1.0' }] }),
    );
    expect(upToDate.update).toBeNull();
    const unknownVersion = await heartbeat(
      stable,
      heartbeatBody({ components: [{ name: 'RESTAURANT_PC', version: 'dev-build' }] }),
    );
    expect(unknownVersion.update).toBeNull();
  });

  it('answers GET /v1/updates the same way, for the channel of the caller', async () => {
    const response = await signedGet(app, stable, '/v1/updates?version=1.0.0');
    expect(response.status).toBe(200);
    expect(UpdatesResponse.parse(response.body)).toMatchObject({
      channel: 'STABLE',
      update: { version: '1.1.0' },
    });
    const invalid = await signedGet(app, stable, '/v1/updates?version=latest');
    expect(invalid.status).toBe(400);
  });

  it('refuses a duplicate or unsafe release and audits each publication', async () => {
    await expect(admin.publishRelease(release('1.1.0'), ACTOR)).rejects.toMatchObject({
      code: 'RELEASE_EXISTS',
    });
    const insecure: PublishRelease = { ...release('1.3.0'), url: 'http://downloads.example.com/x' };
    await expect(admin.publishRelease(insecure, ACTOR)).rejects.toThrow();
    const audit = await prisma.auditEntry.findMany({ where: { action: 'release.published' } });
    expect(audit.map((entry) => (entry.details as { version: string }).version).sort()).toEqual([
      '1.0.5',
      '1.1.0',
      '1.2.0-beta.1',
    ]);
  });
});
