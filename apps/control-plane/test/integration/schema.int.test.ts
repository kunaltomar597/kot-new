import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from '@rp/test-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('Control Plane migrations match the Prisma schema', () => {
  const shadowName = `cp_test_${inject('pgRunId')}_shadow_${randomBytes(3).toString('hex')}`;
  let shadowUrl: string;

  async function admin(sql: string): Promise<void> {
    const client = new pg.Client({ connectionString: inject('pgAdminUrl') });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    await admin(`CREATE DATABASE "${shadowName}"`);
    shadowUrl = withDatabase(inject('pgAdminUrl'), shadowName);
  });

  afterAll(async () => {
    await admin(`DROP DATABASE IF EXISTS "${shadowName}" WITH (FORCE)`);
  });

  it('has no schema changes missing a migration', () => {
    const result = spawnSync(
      join(ROOT, 'node_modules', '.bin', 'prisma'),
      [
        'migrate',
        'diff',
        '--from-migrations',
        'prisma/migrations',
        '--to-schema',
        'prisma/schema.prisma',
        '--exit-code',
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: shadowUrl, SHADOW_DATABASE_URL: shadowUrl },
      },
    );
    // Exit code 0: no difference. 2: schema.prisma has changes without a migration.
    expect(result.stdout + result.stderr).not.toMatch(/Error/);
    expect(result.status).toBe(0);
  });
});
