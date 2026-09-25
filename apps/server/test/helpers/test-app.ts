import type { Server } from 'node:http';
import type { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureApp, NEST_APP_OPTIONS } from '../../src/app.factory.js';
import { LOG_DESTINATION, type LogDestination } from '../../src/config/config.module.js';
import { AppModule } from '../../src/app.module.js';
import { type AppConfig, AppConfigSchema } from '../../src/config/app-config.js';

export function testConfig(overrides: Partial<AppConfig> & { databaseUrl: string }): AppConfig {
  return Object.freeze(
    AppConfigSchema.parse({
      nodeEnv: 'test',
      logLevel: 'silent',
      // Each test app gets its own data folder, so its secrets (pepper, token key) are its own.
      dataDir: mkdtempSync(join(tmpdir(), 'rp-server-data-')),
      ...overrides,
    }),
  );
}

/**
 * Boots the real application module against a test database. Extra controllers can be mounted
 * to exercise cross-cutting behaviour (error mapping, validation) end to end.
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
  let builder = Test.createTestingModule({
    imports: [
      AppModule.forRoot(testConfig({ databaseUrl: options.databaseUrl, ...options.config })),
    ],
    controllers: options.controllers ?? [],
  })
    .overrideProvider(LOG_DESTINATION)
    .useValue(options.logDestination ?? null);
  for (const { provide, useValue } of options.overrides ?? []) {
    builder = builder.overrideProvider(provide).useValue(useValue);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
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

/** The base URL of an app created with `listen: true`. */
export function appUrl(app: INestApplication): string {
  const address = httpServer(app).address();
  if (address === null || typeof address === 'string') throw new Error('The app is not listening');
  return `http://127.0.0.1:${String(address.port)}`;
}
