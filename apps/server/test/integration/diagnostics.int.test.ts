import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { ApiError, type LoginResponse } from '@rp/contracts';
import { DiagnosticsBundle } from '@rp/contracts/control-plane';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SECRET_STORE, type SecretName, type SecretStore } from '../../src/auth/secret-store.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { saveRelayCredential } from '../../src/relay/relay-credential.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

/**
 * P7-08a acceptance: "Send diagnostics to support" (UPD-008) never carries a secret or a guest's
 * contact details. Secrets are planted where a careless log line, setting or device name would
 * put them, next to the PC's real secrets, and the bundle is scanned for all of them.
 */

let database: TestDatabase;
let app: INestApplication;
let kit: AuthKit;
let manager: LoginResponse;
let waiter: LoginResponse;
const dataDir = mkdtempSync(join(tmpdir(), 'rp-diagnostics-'));

const RELAY_CREDENTIAL = 'Rq7XvT2mLp9Kw4Zb8Nc3Jd5Hf1Gs6Ae0Bi9Cu3Dv7Ew2';
const PLANTED = {
  jwt: 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJzdGFmZi0xIn0.U2lnbmF0dXJlT2ZUaGVUb2tlbkhlcmU',
  bearer: 'Rz9yX4wV7uT1sR5qP3oN8mL2kJ6hG0fE',
  dbPassword: 'Pg-Sup3r-S3cret',
  pin: '4821',
  pagerPassword: 'pager-wifi-pass-77',
  privateKey: 'MC4CAQAwBQYDK2VwBCIEIDhQkf8sM2vXkZ9yPq1',
  guestPhone: '98201 23456',
  guestEmail: 'kiran.shah@example.com',
};

const server = () => request(httpServer(app));
const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);

beforeAll(async () => {
  mkdirSync(join(dataDir, 'logs'));
  writeFileSync(
    join(dataDir, 'logs', 'server.out.log'),
    [
      '{"level":30,"msg":"Server started","port":8443}',
      `{"level":40,"msg":"Request rejected","authorization":"Bearer ${PLANTED.bearer}"}`,
      `{"level":50,"msg":"Token was ${PLANTED.jwt}"}`,
      `{"level":50,"msg":"connect failed postgres://rp_app:${PLANTED.dbPassword}@127.0.0.1:5432/rp"}`,
      `{"level":30,"msg":"login","pin":"${PLANTED.pin}"}`,
      `{"level":30,"msg":"pager","password":"${PLANTED.pagerPassword}"}`,
      `-----BEGIN PRIVATE KEY-----\n${PLANTED.privateKey}\n-----END PRIVATE KEY-----`,
      `{"level":30,"msg":"relay credential ${RELAY_CREDENTIAL} saved"}`,
      `{"level":30,"msg":"Feedback from ${PLANTED.guestEmail}, phone +91 ${PLANTED.guestPhone}"}`,
      '{"level":30,"msg":"Printer KITCHEN-1 out of paper"}',
    ].join('\n'),
  );
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url, config: { dataDir } });
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  waiter = await signIn(app, kit, 'WAITER');
  const prisma = app.get(PrismaService);
  const secrets = app.get<SecretStore>(SECRET_STORE);
  await saveRelayCredential(prisma, secrets, RELAY_CREDENTIAL);
  const restaurant = await prisma.restaurant.findFirstOrThrow();
  await prisma.device.updateMany({ data: { name: `Ravi's phone ${PLANTED.guestPhone}` } });
  await prisma.setting.create({
    data: {
      restaurantId: restaurant.id,
      key: 'notifications.nudgeMessages',
      value: [`Call the owner on ${PLANTED.guestPhone}`],
    },
  });
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('[UPD-008] [SEC-015] the diagnostics bundle', () => {
  it('holds versions, configuration, devices, status and logs, and no secret', async () => {
    const response = await server().get('/api/v1/system/diagnostics').set(as(manager));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const bundle = DiagnosticsBundle.parse(response.body);
    expect(bundle.versions.map((version) => version.name)).toContain('Server');
    expect(bundle.configuration).toMatchObject({
      dataDir,
      controlPlane: null,
      licenceEnforced: expect.any(Boolean) as unknown,
    });
    expect(bundle.devices.length).toBeGreaterThan(0);
    expect(bundle.logs.files[0]?.name).toBe('server.out.log');
    expect(bundle.logs.files[0]?.lines).toContain(
      '{"level":30,"msg":"Printer KITCHEN-1 out of paper"}',
    );
    expect(bundle.status).toHaveProperty('database');

    const text = JSON.stringify(bundle);
    // What was planted, and the PC's real secrets.
    const secrets = app.get<SecretStore>(SECRET_STORE);
    const names: SecretName[] = [
      'token-signing-key',
      'pin-pepper',
      'device-token-key',
      'relay-credential-key',
    ];
    const real = await Promise.all(
      names.map(async (name) => (await secrets.get(name)).toString('base64')),
    );
    for (const secret of [
      ...Object.values(PLANTED),
      RELAY_CREDENTIAL,
      manager.accessToken,
      ...real,
    ]) {
      expect(text, `contains ${secret.slice(0, 6)}…`).not.toContain(secret);
    }
    expect(text).not.toContain(database.url);
    // And nothing that looks like one.
    const patterns = [
      /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /:\/\/[^\s:/@"]+:(?!\[REDACTED\])[^\s@"]+@/,
      /Bearer (?!\[REDACTED\])/,
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
      /(?<!\d)[6-9]\d{4}\s?\d{5}(?!\d)/,
      // 40+ random-looking characters, other than a file path.
      /(?<![A-Za-z0-9+/_-])(?!\/)[A-Za-z0-9+/_-]{40,}/,
    ];
    for (const pattern of patterns) expect(text).not.toMatch(pattern);
  });

  it('is for managers only, and says why it cannot be sent before the PC is connected', async () => {
    expect((await server().get('/api/v1/system/diagnostics').set(as(waiter))).status).toBe(403);
    const send = await server()
      .post('/api/v1/system/diagnostics')
      .set(as(manager))
      .send({ note: 'Printer trouble' });
    expect([send.status, ApiError.parse(send.body).code]).toEqual([
      409,
      'CONTROL_PLANE_NOT_CONNECTED',
    ]);
  });
});
