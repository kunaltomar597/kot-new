import type { Server } from 'node:http';
import { Server as HttpsServer } from 'node:https';
import type { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { configureApp, httpsOptionsFor, NEST_APP_OPTIONS } from '../../src/app.factory.js';
import { LOG_DESTINATION, type LogDestination } from '../../src/config/config.module.js';
import { AppModule } from '../../src/app.module.js';
import { type AppConfig, AppConfigSchema } from '../../src/config/app-config.js';
import { TlsService } from '../../src/tls/tls.service.js';

/** A parsed configuration for tests; `overrides` are already-parsed values (e.g. `tls: true`). */
export function testConfig(overrides: Partial<AppConfig> & { databaseUrl: string }): AppConfig {
  const { databaseUrl, ...parsed } = overrides;
  return Object.freeze({
    ...AppConfigSchema.parse({
      nodeEnv: 'test',
      logLevel: 'silent',
      databaseUrl,
      // Each test app gets its own data folder, so its secrets (pepper, token key) are its own.
      dataDir: parsed.dataDir ?? mkdtempSync(join(tmpdir(), 'rp-server-data-')),
    }),
    ...parsed,
  });
}

/**
 * Boots the real application module against a test database. Extra controllers can be mounted
 * to exercise cross-cutting behaviour (error mapping, validation) end to end. With
 * `config: { tls: true }` it serves HTTPS with the installation's certificate, as `RP_TLS=on`
 * does in production (P0-15).
 */
export async function createTestApp(options: {
  databaseUrl: string;
  config?: Partial<AppConfig>;
  controllers?: Type[];
  /** Receives every log line (default: none are written). */
  logDestination?: LogDestination;
  /** Replaces provider values, e.g. shorter real-time intervals. */
  overrides?: readonly {
    readonly provide: string | symbol | Type;
    readonly useValue: unknown;
  }[];
  /** Runs before start-up hooks, e.g. to subscribe test consumers to the event bus. */
  beforeInit?: (app: INestApplication) => void;
  /** Listens on a random localhost port (Socket.io clients need a real port). */
  listen?: boolean;
}): Promise<INestApplication> {
  const config = testConfig({ databaseUrl: options.databaseUrl, ...options.config });
  let builder = Test.createTestingModule({
    imports: [AppModule.forRoot(config)],
    controllers: options.controllers ?? [],
  })
    .overrideProvider(LOG_DESTINATION)
    .useValue(options.logDestination ?? null);
  for (const { provide, useValue } of options.overrides ?? []) {
    builder = builder.overrideProvider(provide).useValue(useValue);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({
    ...NEST_APP_OPTIONS,
    ...(config.tls && { httpsOptions: await httpsOptionsFor(config) }),
  });
  configureApp(app);
  options.beforeInit?.(app);
  await app.init();
  if (options.listen === true) await app.listen(0, '127.0.0.1');
  return app;
}

/** The underlying HTTP server, typed for supertest (Nest returns `any`). */
export function httpServer(app: INestApplication): Server {
  return app.getHttpServer() as Server;
}

/** The base URL of an app created with `listen: true` (`https:` when it serves TLS). */
export function appUrl(app: INestApplication): string {
  const server: unknown = app.getHttpServer();
  const address = httpServer(app).address();
  if (address === null || typeof address === 'string') throw new Error('The app is not listening');
  const scheme = server instanceof HttpsServer ? 'https' : 'http';
  return `${scheme}://127.0.0.1:${String(address.port)}`;
}

/**
 * A supertest client of the app. Over HTTPS it trusts only the installation's CA, as a paired
 * device that pinned it does (P0-15).
 */
export function api(app: INestApplication): ReturnType<typeof request> {
  const ca = app.get(TlsService).ca()?.certificate;
  return ca === undefined ? request(httpServer(app)) : request.agent(httpServer(app), { ca });
}
