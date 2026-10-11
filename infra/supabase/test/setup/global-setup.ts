import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestDatabase } from '@rp/test-postgres';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** A running Supabase database (RELAY_DATABASE_URL), or '' for a throwaway cluster. */
    relayDirectUrl: string;
    pgAdminUrl: string;
    pgTemplateDatabase: string;
    pgRunId: string;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
export const RELAY_DIR = join(here, '..', '..');
export const MIGRATIONS_DIR = join(RELAY_DIR, 'migrations');
export const SUPABASE_PRELUDE = join(here, 'supabase-prelude.sql');

/**
 * Starts PostgreSQL once and applies the Supabase prelude and the relay migrations to a template.
 * With RELAY_DATABASE_URL (a superuser connection to a local Supabase stack that already applied
 * the migrations, as in the relay-supabase CI job), the tests run there instead.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const direct = process.env.RELAY_DATABASE_URL ?? '';
  if (direct !== '') {
    project.provide('relayDirectUrl', direct);
    project.provide('pgAdminUrl', '');
    project.provide('pgTemplateDatabase', '');
    project.provide('pgRunId', '');
    return () => Promise.resolve();
  }
  const cluster = await startTestDatabase({
    migrationsDir: MIGRATIONS_DIR,
    prefix: 'relay',
    preludeFiles: [SUPABASE_PRELUDE],
  });
  project.provide('relayDirectUrl', '');
  project.provide('pgAdminUrl', cluster.adminUrl);
  project.provide('pgTemplateDatabase', cluster.templateDatabase);
  project.provide('pgRunId', cluster.runId);
  return () => cluster.stop();
}
