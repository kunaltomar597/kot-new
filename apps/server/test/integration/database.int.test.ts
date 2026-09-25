import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { testConfig } from '../helpers/test-app.js';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '../helpers/test-database.js';
import { withDatabase } from '../setup/postgres.js';

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('database access', () => {
  let database: TestDatabase;
  let prisma: PrismaService;

  beforeAll(async () => {
    database = await createTestDatabase();
    prisma = new PrismaService(testConfig({ databaseUrl: database.url }));
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await database.drop();
  });

  it('applies migrations and generates UUIDv7 ids', async () => {
    const restaurant = await prisma.restaurant.create({ data: { displayName: 'Test Dhaba' } });
    expect(restaurant.id[14]).toBe('7');
    expect(await prisma.restaurant.count()).toBe(1);
  });

  it('[NFR-A03] commits and rolls back transactions as a unit', async () => {
    await prisma.transaction(async (tx) => {
      await tx.systemMeta.create({ data: { key: 'committed', value: '1' } });
    });
    await expect(
      prisma.transaction(async (tx) => {
        await tx.systemMeta.create({ data: { key: 'rolled-back', value: '1' } });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    const keys = (await prisma.systemMeta.findMany()).map((row) => row.key);
    expect(keys).toContain('committed');
    expect(keys).not.toContain('rolled-back');
  });

  it('supports serializable transactions', async () => {
    const result = await prisma.transaction(async (tx) => tx.systemMeta.count(), {
      isolationLevel: 'Serializable',
    });
    expect(result).toBeGreaterThanOrEqual(1);
  });

  it('answers the health ping', async () => {
    const ping = await prisma.ping();
    expect(ping.up).toBe(true);
    expect(ping.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('migrations match the Prisma schema', () => {
  let shadowUrl: string;
  const shadowName = `rp_shadow_${String(process.pid)}_${Date.now().toString(36)}`;

  beforeAll(async () => {
    const client = new pg.Client({ connectionString: testAdminUrl() });
    await client.connect();
    await client.query(`CREATE DATABASE "${shadowName}"`);
    await client.end();
    shadowUrl = withDatabase(testAdminUrl(), shadowName);
  });

  afterAll(async () => {
    const client = new pg.Client({ connectionString: testAdminUrl() });
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS "${shadowName}" WITH (FORCE)`);
    await client.end();
  });

  it('has no schema changes missing a migration', () => {
    const result = spawnSync(
      join(SERVER_ROOT, 'node_modules', '.bin', 'prisma'),
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
        cwd: SERVER_ROOT,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: shadowUrl, SHADOW_DATABASE_URL: shadowUrl },
      },
    );
    // Exit code 0: no difference. 2: schema.prisma has changes without a migration.
    expect(result.stdout + result.stderr).not.toMatch(/Error/);
    expect(result.status).toBe(0);
  });
});
