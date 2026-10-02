import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { TestDatabase } from '@rp/test-postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { webMiddleware } from '../../src/http/web-static.js';
import { createTestApp, createTestDatabase, httpServer } from '../helpers/test-app.js';

let database: TestDatabase;
let app: INestApplication;
let webDir: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), 'cp-web-'));
  mkdirSync(join(webDir, 'assets'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Vendor</title>');
  writeFileSync(join(webDir, 'assets', 'app-1a2b.js'), 'console.log(1)');
  database = await createTestDatabase();
  app = await createTestApp(database.url, { webDir });
});

afterAll(async () => {
  await app.close();
  await database.drop();
  rmSync(webDir, { recursive: true, force: true });
});

describe('[VCP-001] the vendor web app on the API’s own origin', () => {
  it('serves the app with strict security headers, and its routes from the shell', async () => {
    const page = await request(httpServer(app)).get('/restaurants/abc').set('accept', 'text/html');
    expect(page.status).toBe(200);
    expect(page.text).toContain('<title>Vendor</title>');
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(page.headers['cache-control']).toBe('no-cache');
    const script = await request(httpServer(app)).get('/assets/app-1a2b.js');
    expect(script.headers['cache-control']).toContain('immutable');
    expect((await request(httpServer(app)).get('/assets/missing.js')).status).toBe(404);
  });

  it('never answers the API with the app', async () => {
    const health = await request(httpServer(app)).get('/v1/health').set('accept', 'text/html');
    expect(health.headers['content-type']).toContain('application/json');
    const unknown = await request(httpServer(app)).get('/v1/nothing').set('accept', 'text/html');
    expect(unknown.status).toBe(404);
    expect(unknown.text).not.toContain('<title>Vendor</title>');
  });

  it('refuses to start without a build', () => {
    expect(() => webMiddleware(join(webDir, 'missing'))).toThrow(/build is missing/);
  });
});
