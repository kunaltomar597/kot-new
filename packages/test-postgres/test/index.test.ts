import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationFiles, withDatabase } from '../src/index.js';

describe('test database helpers', () => {
  it('points a connection string at another database', () => {
    expect(withDatabase('postgresql://postgres@127.0.0.1:5432/postgres', 'rp_test_1')).toBe(
      'postgresql://postgres@127.0.0.1:5432/rp_test_1',
    );
  });

  it('lists migrations in the order Prisma applies them, skipping folders without SQL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rp-migrations-'));
    for (const name of ['20260926000000_second', '20260925000000_first', 'empty']) {
      mkdirSync(join(dir, name));
    }
    writeFileSync(join(dir, '20260925000000_first', 'migration.sql'), 'SELECT 1;');
    writeFileSync(join(dir, '20260926000000_second', 'migration.sql'), 'SELECT 2;');
    writeFileSync(join(dir, 'migration_lock.toml'), 'provider = "postgresql"');
    expect(migrationFiles(dir)).toEqual([
      join(dir, '20260925000000_first', 'migration.sql'),
      join(dir, '20260926000000_second', 'migration.sql'),
    ]);
  });
});
