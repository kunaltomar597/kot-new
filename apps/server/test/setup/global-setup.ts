import type { TestProject } from 'vitest/node';
import { startTestDatabase } from './postgres.js';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgTemplateDatabase: string;
    pgRunId: string;
  }
}

/** Starts PostgreSQL once for the integration project and shares its location with test files. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const cluster = await startTestDatabase();
  project.provide('pgAdminUrl', cluster.adminUrl);
  project.provide('pgTemplateDatabase', cluster.templateDatabase);
  project.provide('pgRunId', cluster.runId);
  return () => cluster.stop();
}
