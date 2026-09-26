import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

let database: TestDatabase;
let app: INestApplication;
let consoleDir: string;

beforeAll(async () => {
  consoleDir = mkdtempSync(join(tmpdir(), 'rp-console-'));
  mkdirSync(join(consoleDir, 'assets'));
  writeFileSync(join(consoleDir, 'index.html'), '<!doctype html><title>Console</title>');
  writeFileSync(join(consoleDir, 'assets', 'app-3f2a1b.js'), 'console.log(1)');
  writeFileSync(join(consoleDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url, config: { consoleDir } });
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const server = () => request(httpServer(app));

describe('[MGR-001] [KDS-001] the local server serves the web console', () => {
  it('serves the app shell with strict security headers, for every client-side route', async () => {
    for (const path of ['/', '/pos', '/kds/station', '/manage/devices']) {
      const response = await server().get(path).set('accept', 'text/html').expect(200);
      expect(response.text).toContain('<title>Console</title>');
      expect(response.headers['content-security-policy']).toContain("script-src 'self'");
      expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cache-control']).toBe('no-cache');
    }
  });

  it('caches content-hashed assets for good and revalidates other files', async () => {
    const asset = await server().get('/assets/app-3f2a1b.js').expect(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(asset.headers['content-type']).toMatch(/javascript/);
    const icon = await server().get('/favicon.svg').expect(200);
    expect(icon.headers['cache-control']).toBe('no-cache');
  });

  it('leaves the API and the socket path to the server', async () => {
    const health = await server().get('/api/v1/health').set('accept', 'text/html,application/json');
    expect(health.headers['content-type']).toMatch(/json/);
    const missing = await server().get('/api/v1/nothing-here').set('accept', 'text/html');
    expect(missing.status).toBe(404);
    expect(missing.headers['content-type']).toMatch(/json/);
    const socket = await server().get('/socket.io/?EIO=4&transport=polling');
    expect(socket.text).not.toContain('<title>Console</title>');
  });

  it('only answers GET requests that want a page', async () => {
    expect((await server().post('/pos').set('accept', 'text/html')).status).toBe(404);
    expect((await server().get('/pos').set('accept', 'application/json')).status).toBe(404);
    expect((await server().get('/assets/missing.js').set('accept', 'text/html')).status).toBe(404);
  });

  it('refuses to start when the console build is missing', async () => {
    await expect(
      createTestApp({ databaseUrl: database.url, config: { consoleDir: join(consoleDir, 'no') } }),
    ).rejects.toThrow(/console build is missing/);
  });
});
