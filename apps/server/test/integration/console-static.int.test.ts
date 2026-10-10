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

  it('[SEC-017] lets no string reach a script or HTML sink in the console (Trusted Types)', async () => {
    const response = await server().get('/').set('accept', 'text/html').expect(200);
    const policy = response.headers['content-security-policy'];
    expect(policy).toContain("require-trusted-types-for 'script'");
    expect(policy).toContain("trusted-types 'none'");
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).not.toContain('unsafe-eval');
  });

  it('[SEC-017] puts the security headers on every answer that is not a page of the console', async () => {
    const answers = [
      await server().get('/api/v1/health').expect(200),
      await server().get('/api/v1/nothing-here').expect(404),
      await server()
        .post('/api/v1/devices/challenge')
        .set('content-type', 'application/json')
        .send('{"broken":')
        .expect(400),
      await server().get('/assets/missing.js').expect(404),
      await server().get('/wp-login.php').expect(404),
      await server().post('/pos').set('accept', 'text/html').expect(404),
    ];
    for (const response of answers) {
      expect(response.headers).toMatchObject({
        'content-security-policy':
          "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'cross-origin-resource-policy': 'same-origin',
        'cache-control': 'no-store',
      });
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.headers['strict-transport-security']).toBeUndefined();
      expect(response.headers['x-powered-by']).toBeUndefined();
    }
    // A folder of the console's files is no redirect page: it is a route of the console.
    const folder = await server().get('/assets').set('accept', 'text/html').expect(200);
    expect(folder.headers['content-security-policy']).toContain("trusted-types 'none'");
    // The console's own pages keep their policy and caching, and are not framed either.
    const page = await server().get('/pos').set('accept', 'text/html').expect(200);
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.headers['cache-control']).toBe('no-cache');
    expect(page.headers['x-frame-options']).toBe('DENY');
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
