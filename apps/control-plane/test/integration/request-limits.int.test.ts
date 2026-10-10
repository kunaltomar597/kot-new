import type { INestApplication } from '@nestjs/common';
import { ApiError } from '@rp/contracts/control-plane';
import type { TestDatabase } from '@rp/test-postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestDatabase, httpServer } from '../helpers/test-app.js';

let database: TestDatabase;
let app: INestApplication;

beforeAll(async () => {
  database = await createTestDatabase();
  // A slow refill, so the test sees the burst and nothing comes back while it runs.
  app = await createTestApp(database.url, {
    requestBurst: 20,
    requestsPerSecond: 1,
    publicRequestBurst: 4,
    publicRequestsPerSecond: 1,
  });
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const bad = () => request(httpServer(app)).post('/v1/enrolments').send({});

describe('[SEC-001] flooding the Control Plane (CP-D1)', () => {
  it('answers 429 RATE_LIMITED with Retry-After once an address is past its burst', async () => {
    const answers = [];
    for (let i = 0; i < 30; i += 1) answers.push(await bad());
    const allowed = answers.filter((answer) => answer.status !== 429);
    const refused = answers.filter((answer) => answer.status === 429);
    expect(allowed.length).toBeGreaterThanOrEqual(20);
    expect(allowed.length).toBeLessThan(25);
    expect(refused.length).toBeGreaterThan(0);
    expect(ApiError.parse(refused[0]?.body).code).toBe('RATE_LIMITED');
    expect(Number(refused[0]?.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // The refusal still carries the security headers and a correlation id.
    expect(refused[0]?.headers['x-content-type-options']).toBe('nosniff');
    expect(refused[0]?.headers['x-correlation-id']).toBeTruthy();
  });

  it('still answers the health probe while an address is limited', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await request(httpServer(app)).get('/v1/health')).status).not.toBe(429);
    }
  });
});
