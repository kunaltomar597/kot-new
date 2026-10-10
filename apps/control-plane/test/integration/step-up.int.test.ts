import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  CONTROL_PLANE_ROUTES,
  STEP_UP_HEADER,
  STEP_UP_OPERATIONS,
} from '@rp/contracts/control-plane';
import type { TestDatabase } from '@rp/test-postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { createTestApp, createTestDatabase, httpServer } from '../helpers/test-app.js';
import { bearerOnly, signInVendor, stepUp, vendorAccount } from '../helpers/vendor.js';

let database: TestDatabase;
let app: INestApplication;
let token: string;

const server = () => request(httpServer(app));

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp(database.url);
  token = await signInVendor(app, await vendorAccount(app, 'SUPER_ADMIN'));
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const route = (operationId: string) => {
  const found = CONTROL_PLANE_ROUTES.find((r) => r.operationId === operationId);
  if (found === undefined) throw new Error(operationId);
  return found;
};

describe('[VCP-001] [SEC-018] step-up authentication (CP-S2)', () => {
  it('lists only operations that exist and need a role', () => {
    for (const id of STEP_UP_OPERATIONS) {
      expect(['PUBLIC', 'INSTALLATION']).not.toContain(route(id).capability);
    }
  });

  it('refuses every listed operation without a fresh code, and keeps the session', async () => {
    for (const id of STEP_UP_OPERATIONS) {
      const { method, path } = route(id);
      const concrete = path.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');
      const response = await server()
        [method.toLowerCase() as 'post'](concrete)
        .set(bearerOnly(token))
        .send({});
      expect(response.status, id).toBe(403);
      expect(ApiError.parse(response.body).code, id).toBe('STEP_UP_REQUIRED');
    }
    await server().get('/v1/vendor/me').set(bearerOnly(token)).expect(200);
  });

  it('accepts a new code once, and refuses it again', async () => {
    const headers = { ...bearerOnly(token), ...stepUp(token) };
    const first = await server().post('/v1/vendor/access-reviews').set(headers).send({});
    expect(first.status).not.toBe(403);
    const again = await server().post('/v1/vendor/access-reviews').set(headers).send({});
    expect(again.status).toBe(403);
    expect(ApiError.parse(again.body).code).toBe('STEP_UP_REQUIRED');
  });

  it('counts wrong codes towards the account lock and audits them', async () => {
    const fresh = await vendorAccount(app, 'SUPER_ADMIN');
    const own = await signInVendor(app, fresh);
    for (let i = 0; i < 5; i += 1) {
      const response = await server()
        .post('/v1/vendor/access-reviews')
        .set({ ...bearerOnly(own), [STEP_UP_HEADER]: '000000' })
        .send({});
      expect(response.status).toBe(403);
    }
    const locked = await server()
      .post('/v1/vendor/access-reviews')
      .set({ ...bearerOnly(own), ...stepUp(own) })
      .send({});
    expect(locked.status).toBe(423);
    const failed = await app
      .get(PrismaService)
      .auditEntry.count({ where: { action: 'vendor.step_up_failed' } });
    expect(failed).toBeGreaterThanOrEqual(5);
  });
});
