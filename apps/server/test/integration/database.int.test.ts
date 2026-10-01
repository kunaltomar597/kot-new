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

describe('[NFR-O04] instants stay right whatever the database time zone', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
    // A cluster set up on a PC in India defaults to India time, as the installer's would.
    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    try {
      const name = new URL(database.url).pathname.slice(1);
      await client.query(`ALTER DATABASE "${name}" SET timezone TO 'Asia/Kolkata'`);
    } finally {
      await client.end();
    }
  });

  afterAll(async () => {
    await database.drop();
  });

  it('reads a time PostgreSQL wrote with now() as the same instant the server sees', async () => {
    const prisma = new PrismaService(testConfig({ databaseUrl: database.url }));
    try {
      const restaurant = await prisma.restaurant.create({ data: { displayName: 'Test Dhaba' } });
      // Written by the database itself, like a report filter or a test backdating a dish.
      await prisma.$executeRaw`UPDATE restaurants SET updated_at = now() - interval '30 minutes' WHERE id = ${restaurant.id}::uuid`;
      const read = await prisma.restaurant.findUniqueOrThrow({ where: { id: restaurant.id } });
      const minutesAgo = (Date.now() - read.updatedAt.getTime()) / 60_000;
      expect(minutesAgo).toBeGreaterThan(29);
      expect(minutesAgo).toBeLessThan(31);

      // And a time the server writes is the instant PostgreSQL holds.
      const at = new Date('2026-10-01T10:00:00.000Z');
      await prisma.restaurant.update({ where: { id: restaurant.id }, data: { updatedAt: at } });
      const [row] = await prisma.$queryRaw<
        { epoch: number }[]
      >`SELECT extract(epoch FROM updated_at)::float8 AS epoch FROM restaurants WHERE id = ${restaurant.id}::uuid`;
      expect(row?.epoch).toBe(at.getTime() / 1000);
    } finally {
      await prisma.$disconnect();
    }
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
