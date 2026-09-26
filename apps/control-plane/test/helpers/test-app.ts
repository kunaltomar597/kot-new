import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { cloneTemplateDatabase, type TestDatabase } from '@rp/test-postgres';
import { inject } from 'vitest';
import { configureControlPlaneApp, NEST_APP_OPTIONS } from '../../src/app.factory.js';
import { ControlPlaneModule } from '../../src/app.module.js';
import { type CpConfig, CpConfigSchema } from '../../src/config/cp-config.js';
import { Test } from '@nestjs/testing';

/** A fresh, fully migrated Control Plane database for the calling test file. */
export function createTestDatabase(): Promise<TestDatabase> {
  return cloneTemplateDatabase({
    adminUrl: inject('pgAdminUrl'),
    templateDatabase: inject('pgTemplateDatabase'),
    runId: inject('pgRunId'),
    prefix: 'cp',
  });
}

export function testConfig(databaseUrl: string, overrides: Partial<CpConfig> = {}): CpConfig {
  return Object.freeze({
    ...CpConfigSchema.parse({ databaseUrl, logLevel: 'silent' }),
    ...overrides,
  });
}

/** Boots the real Control Plane module against a test database. */
export async function createTestApp(
  databaseUrl: string,
  overrides: Partial<CpConfig> = {},
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [ControlPlaneModule.forRoot(testConfig(databaseUrl, overrides))],
  }).compile();
  const app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
  configureControlPlaneApp(app);
  await app.init();
  return app;
}

export function httpServer(app: INestApplication): Server {
  return app.getHttpServer() as Server;
}
