import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { SentryReporter } from '@rp/error-reporting';
import type { TestDatabase } from '@rp/test-postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CP_ERROR_REPORTER } from '../../src/errors/error-reporting.js';
import { CpExceptionFilter } from '../../src/errors/cp-exception.filter.js';
import { createTestApp, createTestDatabase, httpServer } from '../helpers/test-app.js';

let database: TestDatabase;
let app: INestApplication;
let service: Server;
const events: Record<string, unknown>[] = [];

beforeAll(async () => {
  service = createServer((incoming, response) => {
    let body = '';
    incoming.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    incoming.on('end', () => {
      events.push(JSON.parse(body.split('\n')[2] ?? '{}') as Record<string, unknown>);
      response.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  const { port } = service.address() as AddressInfo;
  database = await createTestDatabase();
  app = await createTestApp(database.url, { errorDsn: `http://key@127.0.0.1:${String(port)}/3` });
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

describe('[NFR-O02] the Control Plane’s error reports', () => {
  it('reports an unexpected error, scrubbed, and answers without internals', async () => {
    const filter = new CpExceptionFilter(app.get<SentryReporter>(CP_ERROR_REPORTER));
    const response = { status: () => ({ json: () => undefined }) };
    filter.catch(new Error('Query failed for owner asha@spiceroute.example'), {
      switchToHttp: () => ({
        getRequest: () => ({ id: 'corr-1', method: 'GET', path: '/v1/vendor/fleet' }),
        getResponse: () => response,
      }),
    } as never);
    await app.get<SentryReporter>(CP_ERROR_REPORTER).flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tags: { component: 'control-plane' },
      environment: 'development',
      extra: { correlationId: 'corr-1', path: '/v1/vendor/fleet' },
    });
    expect(JSON.stringify(events[0])).not.toContain('asha@spiceroute.example');
    // A refusal the service meant (a 404) is not an error to report.
    await request(httpServer(app)).get('/v1/vendor/nothing-here');
    await app.get<SentryReporter>(CP_ERROR_REPORTER).flush();
    expect(events).toHaveLength(1);
  });
});
