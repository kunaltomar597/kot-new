import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestDatabase } from '@rp/test-postgres';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgTemplateDatabase: string;
    pgRunId: string;
  }
}

export const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'prisma',
  'migrations',
);

/** Starts PostgreSQL once for the integration project and shares its location with test files. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const cluster = await startTestDatabase({ migrationsDir: MIGRATIONS_DIR, prefix: 'cp' });
  project.provide('pgAdminUrl', cluster.adminUrl);
  project.provide('pgTemplateDatabase', cluster.templateDatabase);
  project.provide('pgRunId', cluster.runId);
  return () => cluster.stop();
}
