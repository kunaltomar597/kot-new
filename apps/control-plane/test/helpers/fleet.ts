import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { ReleaseChannel } from '@rp/contracts/control-plane';
import request from 'supertest';
import { AdminService } from '../../src/admin/admin.service.js';
import { InstallationsService } from '../../src/installations/installations.service.js';
import { httpServer } from './test-app.js';
import { TestInstallation } from './test-installation.js';

export const ACTOR = 'cli:test';

let enrolments = 0;

/** A tenant with one installation, enrolled through the real service (not rate-limited here). */
export async function enrolledInstallation(
  app: INestApplication,
  channel: ReleaseChannel = 'STABLE',
): Promise<TestInstallation> {
  const admin = app.get(AdminService);
  const tenant = await admin.createTenant('Test Dhaba', ACTOR);
  const issued = await admin.createInstallation(
    { tenantId: tenant.id, name: 'Main PC', channel },
    ACTOR,
  );
  const installation = TestInstallation.create();
  enrolments += 1;
  const enrolled = await app
    .get(InstallationsService)
    .enrol(installation.enrolRequest(issued.code), `test-${String(enrolments)}`);
  installation.id = enrolled.installationId;
  return installation;
}

/** A heartbeat body as a restaurant PC sends it. */
export function heartbeatBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    heartbeatId: randomUUID(),
    sentAt: new Date().toISOString(),
    components: [
      { name: 'RESTAURANT_PC', version: '1.0.0' },
      { name: 'node', version: '24.1.0' },
    ],
    disk: { totalBytes: 500_000_000_000, freeBytes: 350_000_000_000 },
    auditChainHead: { sequence: 12, hash: 'a'.repeat(64) },
    devices: { POS: 1, KDS: 1 },
    ...overrides,
  });
}

/** A signed POST with exactly `body` as its bytes. */
export function signedPost(
  app: INestApplication,
  installation: TestInstallation,
  path: string,
  body: string,
  options: Parameters<TestInstallation['headers']>[3] = {},
) {
  return request(httpServer(app))
    .post(path)
    .set(installation.headers('POST', path, body, options))
    .set('content-type', 'application/json')
    .send(body);
}

export function signedGet(
  app: INestApplication,
  installation: TestInstallation,
  path: string,
  options: Parameters<TestInstallation['headers']>[3] = {},
) {
  return request(httpServer(app))
    .get(path)
    .set(installation.headers('GET', path, '', options));
}
