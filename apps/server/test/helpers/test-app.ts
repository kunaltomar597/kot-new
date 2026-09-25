import type { Server } from 'node:http';
import type { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureApp, NEST_APP_OPTIONS } from '../../src/app.factory.js';
import { DEVICE_AUTHENTICATOR } from '../../src/auth/device.js';
import { LOG_DESTINATION, type LogDestination } from '../../src/config/config.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { TestDeviceAuthenticator } from './test-devices.js';
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
}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(testConfig({ databaseUrl: options.databaseUrl, ...options.config })),
    ],
    controllers: options.controllers ?? [],
  })
    // Devices prove themselves with a test header until device pairing exists (P0-11).
    .overrideProvider(DEVICE_AUTHENTICATOR)
    .useFactory({
      factory: (prisma: PrismaService) => new TestDeviceAuthenticator(prisma),
      inject: [PrismaService],
    })
    .overrideProvider(LOG_DESTINATION)
    .useValue(options.logDestination ?? null)
    .compile();
  const app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
  configureApp(app);
  await app.init();
  return app;
}

/** The underlying HTTP server, typed for supertest (Nest returns `any`). */
export function httpServer(app: INestApplication): Server {
  return app.getHttpServer() as Server;
}
