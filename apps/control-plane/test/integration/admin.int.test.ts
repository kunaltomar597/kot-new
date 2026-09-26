import type { INestApplication } from '@nestjs/common';
import { ApiError, HealthResponse } from '@rp/contracts/control-plane';
import type { TestDatabase } from '@rp/test-postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../../src/admin/admin.service.js';
import { actorFrom, runCli, USAGE } from '../../src/cli.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { createTestApp, createTestDatabase, httpServer } from '../helpers/test-app.js';

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp(database.url);
  prisma = app.get(PrismaService);
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

async function cli(...argv: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runCli(argv, {
    admin: app.get(AdminService),
    actor: 'ci:release-pipeline',
    out: (line) => lines.push(line),
  });
  return { code, lines };
}

function captured(lines: readonly string[], pattern: RegExp): string {
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  throw new Error(`No line matches ${String(pattern)} in ${lines.join(' | ')}`);
}

describe('[VCP-001] [VCP-002] [UPD-002] admin CLI (until the web app, P7-02)', () => {
  it('creates a tenant and installation, publishes a release and revokes, all audited', async () => {
    const tenant = await cli('tenant:create', '--name', 'Spice Route');
    expect(tenant.code).toBe(0);
    const tenantId = captured(tenant.lines, /^Tenant (\S+) created/);

    const created = await cli('installation:create', '--tenant', tenantId, '--name', 'Main PC');
    const installationId = captured(created.lines, /^Installation (\S+) created/);
    expect(captured(created.lines, /code \(shown once\): (\S+)/)).toMatch(
      /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/,
    );
    const fresh = await cli('installation:code', '--installation', installationId);
    expect(fresh.code).toBe(0);

    const published = await cli(
      'release:publish',
      '--channel',
      'PILOT',
      '--version',
      '2.0.0-rc.1',
      '--url',
      'https://downloads.example.com/rp/2.0.0-rc.1/setup.exe',
      '--sha256',
      'd'.repeat(64),
      '--size',
      '160000000',
      '--notes',
      'Release candidate',
    );
    expect(published.lines).toEqual(['Published RESTAURANT_PC 2.0.0-rc.1 on PILOT.']);

    const list = await cli('installations:list');
    expect(list.lines).toEqual([
      [installationId, 'Spice Route', 'Main PC', 'PENDING', 'STABLE', '-', 'never'].join('\t'),
    ]);

    expect(
      (await cli('installation:revoke', '--installation', installationId, '--reason', 'Test')).code,
    ).toBe(0);
    const audit = await prisma.auditEntry.findMany({ orderBy: { id: 'asc' } });
    expect(audit.map((entry) => entry.action)).toEqual([
      'tenant.created',
      'installation.created',
      'installation.code_issued',
      'release.published',
      'installation.revoked',
    ]);
    expect(new Set(audit.map((entry) => entry.actor))).toEqual(new Set(['ci:release-pipeline']));
  });

  it('explains usage and refuses incomplete commands', async () => {
    expect(await cli()).toEqual({ code: 1, lines: [USAGE] });
    expect((await cli('--help')).code).toBe(0);
    expect((await cli('tenant:delete')).code).toBe(1);
    await expect(cli('tenant:create')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      cli('installation:create', '--tenant', 'x', '--name', 'y', '--channel', 'BETA'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(() => actorFrom({ CP_ACTOR: 'root; drop table' })).toThrow(/CP_ACTOR/);
    expect(actorFrom({ CP_ACTOR: 'ci:release' })).toBe('ci:release');
    expect(actorFrom({})).toMatch(/^cli:/);
  });

  it('keeps the audit log append-only', async () => {
    const [entry] = await prisma.auditEntry.findMany({ take: 1 });
    expect(entry).toBeDefined();
    await expect(
      prisma.$executeRaw`UPDATE audit_log SET actor = 'cli:someone-else' WHERE id = ${entry?.id}`,
    ).rejects.toThrow(/cannot be changed/);
    await expect(prisma.$executeRaw`DELETE FROM audit_log WHERE id = ${entry?.id}`).rejects.toThrow(
      /cannot be changed/,
    );
  });
});

describe('[VCP-009] [SEC-001] service basics', () => {
  it('reports health publicly and answers unknown paths in the error contract', async () => {
    const health = await request(httpServer(app)).get('/v1/health');
    expect(health.status).toBe(200);
    expect(HealthResponse.parse(health.body).checks.database.status).toBe('up');
    expect(health.headers['strict-transport-security']).toBeUndefined();
    expect(health.headers['x-correlation-id']).toBeDefined();

    const missing = await request(httpServer(app)).get('/v1/nothing-here');
    expect(missing.status).toBe(404);
    expect(ApiError.parse(missing.body).code).toBe('NOT_FOUND');
  });

  it('sends HSTS outside development', async () => {
    const own = await createTestDatabase();
    const production = await createTestApp(own.url, { env: 'production' });
    try {
      const health = await request(httpServer(production)).get('/v1/health');
      expect(health.headers['strict-transport-security']).toBe(
        'max-age=31536000; includeSubDomains',
      );
    } finally {
      await production.close();
      await own.drop();
    }
  });
});
