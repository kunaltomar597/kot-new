import type { Server } from 'node:http';
import type { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { configureApp, NEST_APP_OPTIONS } from '../../src/app.factory.js';
import type { Principal, RequestWithPrincipal } from '../../src/auth/principal.js';
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
  /**
   * Stands in for the authentication middleware of P0-10: returns the principal for a request
   * (for example from a test header), or undefined for an anonymous request.
   */
  authenticate?: (request: Request) => Principal | undefined;
}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(testConfig({ databaseUrl: options.databaseUrl, ...options.config })),
    ],
    controllers: options.controllers ?? [],
  }).compile();
  const app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
  configureApp(app);
  const { authenticate } = options;
  if (authenticate !== undefined) {
    app.use((request: Request, _response: unknown, next: () => void) => {
      const principal = authenticate(request);
      if (principal !== undefined) (request as RequestWithPrincipal).principal = principal;
      next();
    });
  }
  await app.init();
  return app;
}

/** The underlying HTTP server, typed for supertest (Nest returns `any`). */
export function httpServer(app: INestApplication): Server {
  return app.getHttpServer() as Server;
}
