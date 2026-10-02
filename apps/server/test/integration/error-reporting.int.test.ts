import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { SentryReporter } from '@rp/error-reporting';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ERROR_REPORTER,
  ErrorCounter,
  type ErrorReporter,
  SENTRY_REPORTER,
} from '../../src/observability/error-reporter.js';
import { authHeaders, type AuthKit, createAuthKit } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

/**
 * P7-08d: errors from the server and from apps reach the vendor's error service (NFR-O02),
 * scrubbed, through the server's own key. A stand-in service records the envelopes.
 */

let database: TestDatabase;
let app: INestApplication;
let kit: AuthKit;
let service: Server;
const envelopes: { auth: string; event: Record<string, unknown> }[] = [];

beforeAll(async () => {
  service = createServer((incoming, response) => {
    let body = '';
    incoming.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    incoming.on('end', () => {
      const lines = body.split('\n');
      envelopes.push({
        auth: String(incoming.headers['x-sentry-auth']),
        event: JSON.parse(lines[2] ?? '{}') as Record<string, unknown>,
      });
      response.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  const { port } = service.address() as AddressInfo;
  database = await createTestDatabase();
  app = await createTestApp({
    databaseUrl: database.url,
    config: { errorDsn: `http://publickey@127.0.0.1:${String(port)}/7`, productVersion: '1.4.0' },
  });
  kit = await createAuthKit(app);
});

afterAll(async () => {
  await app.close();
  await database.drop();
  await new Promise<void>((resolve) =>
    service.close(() => {
      resolve();
    }),
  );
});

const flush = () => app.get<SentryReporter>(SENTRY_REPORTER).flush();

describe('[NFR-O02] error reporting', () => {
  it('reports a server error, scrubbed, and counts it for the heartbeat', async () => {
    const before = app.get(ErrorCounter).total;
    app
      .get<ErrorReporter>(ERROR_REPORTER)
      .report(new Error('Saving the bill failed for guest 9876543210'), {
        pin: '4821',
        table: 'T4',
      });
    await flush();
    expect(app.get(ErrorCounter).total).toBe(before + 1);
    const { auth, event } = envelopes.at(-1) ?? { auth: '', event: {} };
    expect(auth).toContain('sentry_key=publickey');
    expect(event).toMatchObject({
      release: 'restaurant-pc@1.4.0',
      environment: 'test',
      tags: { component: 'server' },
      extra: { pin: '[REDACTED]', table: 'T4' },
    });
    expect(JSON.stringify(event)).not.toContain('9876543210');
  });

  it('passes an app’s error on with the device type, at most 20 an hour per device', async () => {
    const send = (message: string) =>
      request(httpServer(app)).post('/api/v1/client-errors').set(authHeaders(kit.deviceId)).send({
        component: 'console',
        message,
        stack: 'TypeError: x\n    at render (https://pos.local:8443/assets/index-1a2b.js:1:200)',
        path: '/pos/tables',
        appVersion: '1.4.0',
      });
    const first = await send('Cannot read properties of undefined (reading kiran@example.com)');
    expect(first.status).toBe(204);
    await flush();
    const { event } = envelopes.at(-1) ?? { event: {} };
    expect(event).toMatchObject({
      tags: { component: 'console', deviceType: 'POS' },
      extra: { path: '/pos/tables', appVersion: '1.4.0' },
    });
    expect(JSON.stringify(event)).not.toContain('kiran@example.com');

    const count = envelopes.length;
    for (let index = 0; index < 25; index += 1) await send(`Error number ${String(index)}`);
    await flush();
    expect(envelopes.length - count).toBe(19);

    expect((await request(httpServer(app)).post('/api/v1/client-errors').send({})).status).toBe(
      401,
    );
  });
});
