import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ApiError, INSTALLATION_HEADERS } from '@rp/contracts/control-plane';
import type { TestDatabase } from '@rp/test-postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../../src/admin/admin.service.js';
import { NonceStore } from '../../src/auth/nonce-store.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import {
  ACTOR,
  enrolledInstallation,
  heartbeatBody,
  signedGet,
  signedPost,
} from '../helpers/fleet.js';
import { createTestApp, createTestDatabase, httpServer } from '../helpers/test-app.js';
import type { TestInstallation } from '../helpers/test-installation.js';

let database: TestDatabase;
let app: INestApplication;
let pc: TestInstallation;

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp(database.url);
  pc = await enrolledInstallation(app);
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const codeOf = (response: request.Response) => ApiError.parse(response.body).code;

describe('[SEC-002] [SEC-003] signed requests (ADR-0012)', () => {
  it('accepts a request signed by an enrolled installation', async () => {
    const response = await signedPost(app, pc, '/v1/heartbeats', heartbeatBody());
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });

  it('refuses requests without a valid signature, deny by default', async () => {
    const body = heartbeatBody();
    const unsigned = await request(httpServer(app))
      .post('/v1/heartbeats')
      .set('content-type', 'application/json')
      .send(body);
    expect([unsigned.status, codeOf(unsigned)]).toEqual([401, 'SIGNATURE_INVALID']);

    const otherKey = generateKeyPairSync('ed25519').privateKey;
    expect(codeOf(await signedPost(app, pc, '/v1/heartbeats', body, { key: otherKey }))).toBe(
      'SIGNATURE_INVALID',
    );
    expect(codeOf(await signedPost(app, pc, '/v1/heartbeats', body, { id: randomUUID() }))).toBe(
      'SIGNATURE_INVALID',
    );

    // The signature covers the body: changing one byte breaks it.
    const headers = pc.headers('POST', '/v1/heartbeats', body);
    const tampered = await request(httpServer(app))
      .post('/v1/heartbeats')
      .set(headers)
      .set('content-type', 'application/json')
      .send(body.replace('"POS":1', '"POS":9'));
    expect(codeOf(tampered)).toBe('SIGNATURE_INVALID');

    // ... and the path with its query.
    const signedFor = pc.headers('GET', '/v1/updates?version=1.0.0');
    const moved = await request(httpServer(app)).get('/v1/updates?version=0.0.1').set(signedFor);
    expect(codeOf(moved)).toBe('SIGNATURE_INVALID');

    const malformed = await request(httpServer(app))
      .get('/v1/updates?version=1.0.0')
      .set({
        ...pc.headers('GET', '/v1/updates?version=1.0.0'),
        [INSTALLATION_HEADERS.nonce]: 'x',
      });
    expect(codeOf(malformed)).toBe('SIGNATURE_INVALID');
  });

  it('refuses a replayed request (same nonce)', async () => {
    const body = heartbeatBody();
    const nonce = 'cmVwbGF5LXJlcGxheS1yZXBsYXk';
    expect((await signedPost(app, pc, '/v1/heartbeats', body, { nonce })).status).toBe(200);
    const replay = await signedPost(app, pc, '/v1/heartbeats', body, { nonce });
    expect([replay.status, codeOf(replay)]).toEqual([401, 'NONCE_REUSED']);
  });

  it('[LIC-007] tells an installation with a wrong clock the server time', async () => {
    const response = await signedGet(app, pc, '/v1/updates?version=1.0.0', {
      timestamp: Date.now() - 6 * 60_000,
    });
    expect(response.status).toBe(401);
    const error = ApiError.parse(response.body);
    expect(error.code).toBe('CLOCK_SKEW');
    const serverTime = new Date(String(error.details?.serverTime)).getTime();
    expect(Math.abs(serverTime - Date.now())).toBeLessThan(10_000);
  });

  it('refuses a revoked installation and one that never enrolled', async () => {
    const revoked = await enrolledInstallation(app);
    expect((await signedGet(app, revoked, '/v1/updates?version=1.0.0')).status).toBe(200);
    await app.get(AdminService).revokeInstallation(revoked.id ?? '', 'Contract ended', ACTOR);
    const refused = await signedGet(app, revoked, '/v1/updates?version=1.0.0');
    expect([refused.status, codeOf(refused)]).toEqual([403, 'INSTALLATION_REVOKED']);

    const prisma = app.get(PrismaService);
    const tenant = await prisma.tenant.findFirstOrThrow();
    const pending = await app
      .get(AdminService)
      .createInstallation({ tenantId: tenant.id, name: 'Not yet' }, ACTOR);
    const response = await signedGet(app, pc, '/v1/updates?version=1.0.0', {
      id: pending.installationId,
    });
    expect(codeOf(response)).toBe('SIGNATURE_INVALID');
  });

  it('purges nonces once their window has passed', async () => {
    const prisma = app.get(PrismaService);
    const before = await prisma.requestNonce.count();
    expect(before).toBeGreaterThan(0);
    expect(await app.get(NonceStore).purge(new Date(Date.now() + 10 * 60_000))).toBe(before);
    expect(await prisma.requestNonce.count()).toBe(0);
  });
});
