import type { INestApplication } from '@nestjs/common';
import { HealthResponse, VersionResponse } from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

describe('health and version endpoints', () => {
  let database: TestDatabase;
  let app: INestApplication;

  beforeAll(async () => {
    database = await createTestDatabase();
    app = await createTestApp({ databaseUrl: database.url, config: { buildId: 'test-build' } });
  });

  afterAll(async () => {
    await app.close();
    await database.drop();
  });

  it('reports ok with the database up', async () => {
    const response = await request(httpServer(app)).get('/api/v1/health').expect(200);
    const body = HealthResponse.parse(response.body);
    expect(body.status).toBe('ok');
    expect(body.checks.database.status).toBe('up');
  });

  it('reports the version and build', async () => {
    const response = await request(httpServer(app)).get('/api/v1/version').expect(200);
    const body = VersionResponse.parse(response.body);
    expect(body).toMatchObject({ name: '@rp/server', apiVersion: 'v1', buildId: 'test-build' });
    expect(body.node).toBe(process.version);
  });

  it('[NFR-O01] echoes or creates a correlation id', async () => {
    const echoed = await request(httpServer(app))
      .get('/api/v1/health')
      .set('x-correlation-id', 'pos-01:req-42')
      .expect(200);
    expect(echoed.headers['x-correlation-id']).toBe('pos-01:req-42');

    const created = await request(httpServer(app)).get('/api/v1/version').expect(200);
    expect(created.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not advertise the framework', async () => {
    const response = await request(httpServer(app)).get('/api/v1/version');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});

describe('health with the database down', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Nothing listens on port 1, so every query fails fast.
    app = await createTestApp({ databaseUrl: 'postgresql://postgres@127.0.0.1:1/none' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('[NFR-A04] returns 503 so the watchdog can react', async () => {
    const response = await request(httpServer(app)).get('/api/v1/health').expect(503);
    const body = HealthResponse.parse(response.body);
    expect(body.status).toBe('degraded');
    expect(body.checks.database.status).toBe('down');
  });
});
