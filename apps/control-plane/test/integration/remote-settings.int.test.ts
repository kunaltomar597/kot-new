import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  FleetRemoteSettingsView,
  HeartbeatResponse,
  InstallationRemoteSettingsView,
} from '@rp/contracts/control-plane';
import type { TestDatabase } from '@rp/test-postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { settingsDigest } from '../../src/remote-settings/settings-digest.js';
import { enrolledInstallation, heartbeatBody, signedPost } from '../helpers/fleet.js';
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

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp(database.url);
  prisma = app.get(PrismaService);
  for (const role of ['SUPER_ADMIN', 'SUPPORT', 'READ_ONLY'] as const) {
    tokens[role] = await signInVendor(app, await vendorAccount(app, role));
  }
  pc = await enrolledInstallation(app);
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

async function beat(vendorSettings?: { digest: string | null }) {
  const response = await signedPost(
    app,
    pc,
    '/v1/heartbeats',
    heartbeatBody(vendorSettings === undefined ? {} : { vendorSettings }),
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return HeartbeatResponse.parse(response.body).vendorSettings;
}

describe('[UPD-010] remote configuration', () => {
  it('lists what the vendor may push, typed for editing', async () => {
    const view = FleetRemoteSettingsView.parse(
      (await server().get('/v1/vendor/remote-settings').set(as('READ_ONLY'))).body,
    );
    expect(view.definitions.map((definition) => definition.key)).toContain('features.aiMenuImport');
    expect(
      view.definitions.find((definition) => definition.key === 'features.aiMenuImport'),
    ).toMatchObject({
      kind: 'BOOLEAN',
      defaultValue: true,
    });
    expect(
      view.definitions.find((definition) => definition.key === 'qr.pickupTimeoutSeconds'),
    ).toMatchObject({
      kind: 'INTEGER',
      min: 15,
      max: 600,
      unit: 'seconds',
    });
    expect(view.definitions.some((definition) => definition.key.startsWith('licence.'))).toBe(
      false,
    );
    expect(view.fleet).toEqual({});
  });

  it('lets only the Super Admin set values the settings allow, with a reason', async () => {
    const put = (role: string, values: Record<string, unknown>) =>
      server()
        .put('/v1/vendor/remote-settings')
        .set(as(role))
        .send({ values, reason: 'Pilot tuning' });
    expect((await put('SUPPORT', { 'qr.pickupTimeoutSeconds': 90 })).status).toBe(403);
    const wrongKey = await put('SUPER_ADMIN', { 'licence.graceDays': 10 });
    expect([wrongKey.status, ApiError.parse(wrongKey.body).code]).toEqual([
      422,
      'REMOTE_SETTINGS_INVALID',
    ]);
    expect((await put('SUPER_ADMIN', { 'qr.pickupTimeoutSeconds': 5 })).status).toBe(422);
    const saved = await put('SUPER_ADMIN', { 'qr.pickupTimeoutSeconds': 90 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(FleetRemoteSettingsView.parse(saved.body).fleet).toEqual({
      'qr.pickupTimeoutSeconds': 90,
    });
    const audit = await prisma.auditEntry.findFirstOrThrow({
      where: { action: 'remote_settings.changed' },
    });
    expect(audit.details).toMatchObject({
      reason: 'Pilot tuning',
      after: { 'qr.pickupTimeoutSeconds': 90 },
    });
  });

  it('pushes the fleet’s values with a PC’s own on top, until the PC holds them', async () => {
    const set = await server()
      .put(`/v1/vendor/installations/${pc.id ?? ''}/remote-settings`)
      .set(as('SUPER_ADMIN'))
      .send({ values: { 'features.aiMenuImport': false }, reason: 'AI provider down for them' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const view = InstallationRemoteSettingsView.parse(set.body);
    const effective = { 'qr.pickupTimeoutSeconds': 90, 'features.aiMenuImport': false };
    expect(view).toMatchObject({
      overrides: { 'features.aiMenuImport': false },
      effective,
      appliedDigest: null,
    });
    expect(view.digest).toBe(settingsDigest(effective));

    // A PC older than P7-08c says nothing about settings: it is sent none.
    expect(await beat()).toBeNull();
    const pushed = await beat({ digest: null });
    expect(pushed).toEqual({ digest: view.digest, values: effective });
    // Applied: the PC reports the digest, and nothing more is sent.
    expect(await beat({ digest: view.digest })).toBeNull();
    const after = InstallationRemoteSettingsView.parse(
      (
        await server()
          .get(`/v1/vendor/installations/${pc.id ?? ''}/remote-settings`)
          .set(as('READ_ONLY'))
      ).body,
    );
    expect(after.appliedDigest).toBe(view.digest);
  });

  it('computes the digest the local server computes', () => {
    // The same vector is in apps/server/test/unit/settings-digest.test.ts.
    expect(settingsDigest({ 'qr.pickupTimeoutSeconds': 90, 'features.aiMenuImport': false })).toBe(
      settingsDigest({ 'features.aiMenuImport': false, 'qr.pickupTimeoutSeconds': 90 }),
    );
    expect(settingsDigest({ 'features.aiMenuImport': false, 'qr.pickupTimeoutSeconds': 90 })).toBe(
      'a7a4e8534c8cde7a',
    );
  });
});
