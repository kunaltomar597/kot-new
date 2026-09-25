import { inject } from 'vitest';
import { cloneTemplateDatabase } from '../setup/postgres.js';

export interface TestDatabase {
  readonly url: string;
  readonly name: string;
  drop(): Promise<void>;
}

/** A fresh, fully migrated database for the calling test file. */
export function createTestDatabase(): Promise<TestDatabase> {
  return cloneTemplateDatabase(
    inject('pgAdminUrl'),
    inject('pgTemplateDatabase'),
    inject('pgRunId'),
  );
}

/** The admin connection of the test cluster (for tests that inspect roles or catalogs). */
export function testAdminUrl(): string {
  return inject('pgAdminUrl');
}
