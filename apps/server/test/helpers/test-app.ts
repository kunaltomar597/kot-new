import type { Server } from 'node:http';
import type { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { configureApp, NEST_APP_OPTIONS } from '../../src/app.factory.js';
import { AppModule } from '../../src/app.module.js';
import { type AppConfig, AppConfigSchema } from '../../src/config/app-config.js';

export function testConfig(overrides: Partial<AppConfig> & { databaseUrl: string }): AppConfig {
  return Object.freeze(
    AppConfigSchema.parse({ nodeEnv: 'test', logLevel: 'silent', ...overrides }),
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
}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(testConfig({ databaseUrl: options.databaseUrl, ...options.config })),
    ],
    controllers: options.controllers ?? [],
  }).compile();
  const app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
  configureApp(app);
  await app.init();
  return app;
}

/** The underlying HTTP server, typed for supertest (Nest returns `any`). */
export function httpServer(app: INestApplication): Server {
  return app.getHttpServer() as Server;
}
