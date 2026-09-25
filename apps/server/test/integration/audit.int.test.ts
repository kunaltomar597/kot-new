import { Controller, type INestApplication, Param, Post } from '@nestjs/common';
import { AuditVerifyResponse, ApiError } from '@rp/contracts';
import { ROLES, type Role } from '@rp/domain';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../src/audit/audit.service.js';
import { Audited } from '../../src/audit/audited.decorator.js';
import { computeAuditHash, GENESIS_HASH, hashFieldsOfRow } from '../../src/audit/audit-hash.js';
import { RequireCapability } from '../../src/auth/decorators.js';
import type { Principal } from '../../src/auth/principal.js';
import { newId } from '../../src/common/ids.js';
import { runWithRequestContext } from '../../src/common/request-context.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { createTestApp, httpServer, testConfig } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

interface Fixture {
  readonly database: TestDatabase;
  readonly prisma: PrismaService;
  readonly audit: AuditService;
  readonly restaurantId: string;
}

const fixtures: Fixture[] = [];

/** A fresh database with one restaurant; each describe block gets its own chain. */
async function fixture(options: { restaurant?: boolean } = {}): Promise<Fixture> {
  const database = await createTestDatabase();
  const prisma = new PrismaService(testConfig({ databaseUrl: database.url }));
  const restaurantId =
    options.restaurant === false
      ? ''
      : (await prisma.restaurant.create({ data: { displayName: 'Audit Dhaba' } })).id;
  const created = { database, prisma, audit: new AuditService(prisma), restaurantId };
  fixtures.push(created);
  return created;
}

afterAll(async () => {
  for (const { prisma, database } of fixtures) {
    await prisma.$disconnect();
    await database.drop();
  }
});

function record(f: Fixture, action = 'ORDER_CREATED', extra: Record<string, unknown> = {}) {
  return f.prisma.transaction((tx) =>
    f.audit.record(tx, { action, entityType: 'order', entityId: newId(), ...extra }),
  );
}

describe('[AUD-002] [AUD-003] recording entries', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('chains entries: each stores the previous hash and its own position', async () => {
    const first = await record(f);
    const second = await record(f, 'ORDER_APPROVED');
    const third = await record(f, 'DISCOUNT_APPLIED', {
      before: { total: 10_000 },
      after: { total: 9_000 },
      reason: 'Regular guest',
    });
    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
    const rows = await f.prisma.auditLog.findMany({ orderBy: { chainSeq: 'asc' } });
    expect(rows[0]!.prevHash).toBe(GENESIS_HASH);
    expect(rows[1]!.prevHash).toBe(first.hash);
    expect(rows[2]!.prevHash).toBe(second.hash);
    expect(rows[2]!.after).toEqual({ total: 9_000 });
    expect(await f.audit.chainHead()).toEqual({ seq: 3, hash: third.hash });
    const result = await f.audit.verify();
    expect(result).toMatchObject({ valid: true, checkedEntries: 3, head: { seq: 3 } });
    expect(result.firstBreak).toBeUndefined();
  });

  it('records the server time, actor, approver, device, reason and correlation ID', async () => {
    const actorId = newId();
    const approverId = newId();
    const deviceId = newId();
    const entry = await runWithRequestContext({ correlationId: 'req-42' }, () =>
      record(f, 'ITEM_VOIDED', { actorId, approverId, deviceId, reason: 'Dropped plate' }),
    );
    const row = await f.prisma.auditLog.findUniqueOrThrow({ where: { id: entry.id } });
    expect(row).toMatchObject({ actorId, approverId, deviceId, reason: 'Dropped plate' });
    expect(row.correlationId).toBe('req-42');
    expect(Math.abs(row.occurredAt.getTime() - Date.now())).toBeLessThan(10_000);
  });

  it('uses the business date with the 04:00 IST cut-off', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 02:30 IST on 27 September belongs to the business day of 26 September.
    vi.setSystemTime(new Date('2026-09-26T21:00:00.000Z'));
    const early = await record(f, 'SHIFT_CLOSED');
    // 04:30 IST starts the next business day.
    vi.setSystemTime(new Date('2026-09-26T23:00:00.000Z'));
    const later = await record(f, 'SHIFT_OPENED');
    vi.useRealTimers();
    const rows = await f.prisma.auditLog.findMany({ where: { id: { in: [early.id, later.id] } } });
    const dates = Object.fromEntries(
      rows.map((row) => [row.id, row.businessDate.toISOString().slice(0, 10)]),
    );
    expect(dates[early.id]).toBe('2026-09-26');
    expect(dates[later.id]).toBe('2026-09-27');
  });

  it('keeps before/after values verifiable after the JSONB round trip', async () => {
    await record(f, 'MENU_PRICE_CHANGED', {
      before: { z: 1, a: { y: [3, 2, 1], x: 0.1 + 0.2 }, at: new Date('2026-01-02T03:04:05.006Z') },
      after: { price: 25_000, tags: ['veg', 'spicy'], nested: { b: null, a: true } },
    });
    expect((await f.audit.verify()).valid).toBe(true);
  });

  it('rolls back with the business transaction and reuses the position', async () => {
    const before = await f.audit.chainHead();
    await expect(
      f.prisma.transaction(async (tx) => {
        await f.audit.record(tx, { action: 'PAYMENT_RECORDED', entityType: 'payment' });
        throw new Error('payment failed');
      }),
    ).rejects.toThrow('payment failed');
    expect(await f.audit.chainHead()).toEqual(before);
    const next = await record(f, 'PAYMENT_RECORDED');
    expect(next.seq).toBe(before!.seq + 1);
    expect((await f.audit.verify()).valid).toBe(true);
  });

  it('rejects malformed actions, entity types and business dates', async () => {
    await expect(record(f, 'order created')).rejects.toThrow(/UPPER_SNAKE_CASE/);
    await expect(
      f.prisma.transaction((tx) => f.audit.record(tx, { action: 'X_Y', entityType: 'Order' })),
    ).rejects.toThrow(/lower_snake_case/);
    await expect(record(f, 'ORDER_CREATED', { businessDate: '25-09-2026' })).rejects.toThrow(
      /YYYY-MM-DD/,
    );
  });
});

describe('[AUD-003] concurrent writers', () => {
  it('still produce one linear, valid chain', async () => {
    const f = await fixture();
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        record(f, index % 2 === 0 ? 'ORDER_CREATED' : 'KOT_PRINTED'),
      ),
    );
    expect(results.map((entry) => entry.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
    const verification = await f.audit.verify();
    expect(verification).toMatchObject({ valid: true, checkedEntries: 25, head: { seq: 25 } });
  });
});

describe('[AUD-003] [AUD-004] tamper detection', () => {
  /**
   * Changes rows the way an attacker with the database owner's password would: with the guard
   * trigger switched off for the duration.
   */
  async function tamper(f: Fixture, statement: string, params: unknown[]): Promise<void> {
    const client = new pg.Client({ connectionString: f.database.url });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_guard');
      await client.query(statement, params);
      await client.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_guard');
      await client.query('COMMIT');
    } finally {
      await client.end();
    }
  }

  async function purge(f: Fixture, statement: string, params: unknown[] = []): Promise<void> {
    const client = new pg.Client({ connectionString: f.database.url });
    await client.connect();
    try {
      await client.query('SET ROLE rp_purge');
      await client.query(statement, params);
    } finally {
      await client.end();
    }
  }

  async function chainOf(f: Fixture, length: number) {
    const entries: { id: string; seq: number; hash: string }[] = [];
    for (let index = 0; index < length; index += 1) entries.push(await record(f));
    return entries;
  }

  it('detects an edited row', async () => {
    const f = await fixture();
    const entries = await chainOf(f, 5);
    await tamper(f, `UPDATE audit_log SET reason = 'nothing to see' WHERE id = $1`, [
      entries[2]!.id,
    ]);
    const result = await f.audit.verify();
    expect(result.valid).toBe(false);
    expect(result.firstBreak).toEqual({ seq: 3, entryId: entries[2]!.id, reason: 'HASH_MISMATCH' });
    expect(result.checkedEntries).toBe(2);
  });

  it('detects an edit whose hash was recomputed, at the next link', async () => {
    const f = await fixture();
    const entries = await chainOf(f, 5);
    // The forger edits entry 3 and recomputes its hash so the row looks consistent on its own.
    await tamper(f, `UPDATE audit_log SET reason = 'forged' WHERE id = $1`, [entries[2]!.id]);
    const edited = await f.prisma.auditLog.findUniqueOrThrow({ where: { id: entries[2]!.id } });
    const forgedHash = computeAuditHash(hashFieldsOfRow(edited));
    await tamper(f, 'UPDATE audit_log SET hash = $2 WHERE id = $1', [entries[2]!.id, forgedHash]);
    const result = await f.audit.verify();
    expect(result.firstBreak).toEqual({
      seq: 4,
      entryId: entries[3]!.id,
      reason: 'PREV_HASH_MISMATCH',
    });
  });

  it('detects a row removed from the middle', async () => {
    const f = await fixture();
    const entries = await chainOf(f, 5);
    await purge(f, 'DELETE FROM audit_log WHERE id = $1', [entries[2]!.id]);
    const result = await f.audit.verify();
    expect(result.firstBreak).toEqual({ seq: 4, entryId: entries[3]!.id, reason: 'SEQUENCE_GAP' });
  });

  it('detects a first entry that does not start from the genesis hash', async () => {
    const f = await fixture();
    const entries = await chainOf(f, 2);
    await tamper(f, `UPDATE audit_log SET prev_hash = repeat('b', 64) WHERE id = $1`, [
      entries[0]!.id,
    ]);
    const result = await f.audit.verify();
    expect(result.firstBreak).toEqual({
      seq: 1,
      entryId: entries[0]!.id,
      reason: 'PREV_HASH_MISMATCH',
    });
  });

  it('accepts a chain whose oldest entries were archived and purged', async () => {
    const f = await fixture();
    await chainOf(f, 4);
    await purge(f, 'DELETE FROM audit_log WHERE chain_seq <= 2');
    expect(await f.audit.verify()).toMatchObject({
      valid: true,
      checkedEntries: 2,
      head: { seq: 4 },
    });
  });

  it('verifies chains longer than one read batch', async () => {
    const f = await fixture();
    await f.prisma.transaction(
      async (tx) => {
        for (let index = 0; index < 1_050; index += 1) {
          await f.audit.record(tx, { action: 'ORDER_CREATED', entityType: 'order' });
        }
      },
      { timeout: 120_000 },
    );
    expect(await f.audit.verify()).toMatchObject({ valid: true, checkedEntries: 1_050 });
  });

  it('reports an empty log as valid with no head', async () => {
    const f = await fixture();
    expect(await f.audit.verify()).toMatchObject({ valid: true, checkedEntries: 0, head: null });
  });

  it('refuses to record before the restaurant is set up', async () => {
    const f = await fixture({ restaurant: false });
    await expect(record(f)).rejects.toMatchObject({ code: 'RESTAURANT_NOT_SET_UP' });
  });
});

@Controller('probe-audit')
class AuditProbeController {
  @Post('menu/:itemId/price')
  @RequireCapability('MENU_MANAGE')
  @Audited({ action: 'MENU_PRICE_CHANGED', entityType: 'item', entityIdParam: 'itemId' })
  changePrice(@Param('itemId') itemId: string) {
    return { itemId };
  }

  @Post('staff')
  @RequireCapability('STAFF_MANAGE')
  @Audited({ action: 'STAFF_CREATED', entityType: 'staff' })
  createStaff() {
    return { id: newId() };
  }

  @Post('fail')
  @RequireCapability('MENU_MANAGE')
  @Audited({ action: 'MENU_ITEM_ARCHIVED', entityType: 'item' })
  fail(): never {
    throw new Error('boom');
  }

  @Post('undeclared')
  undeclared() {
    return { ok: true };
  }

  @Post('void')
  @RequireCapability('ITEM_VOID_AFTER_PREP')
  voidItem() {
    return { ok: true };
  }

  @Post('approve')
  @RequireCapability('ORDER_APPROVE_CUSTOMER')
  approve() {
    return { ok: true };
  }
}

describe('[AUD-003] [AUTH-010] [SEC-003] audit HTTP API and permission guard', () => {
  let f: Fixture;
  let app: INestApplication;
  const deviceId = newId();
  const staffIds = Object.fromEntries(ROLES.map((role) => [role, newId()])) as Record<Role, string>;

  beforeAll(async () => {
    f = await fixture();
    app = await createTestApp({
      databaseUrl: f.database.url,
      controllers: [AuditProbeController],
      authenticate: (req): Principal | undefined => {
        const role = req.headers['x-test-role'];
        if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role))
          return undefined;
        return {
          staffId: staffIds[role as Role],
          role: role as Role,
          restaurantId: f.restaurantId,
          deviceId,
        };
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  const as = (role?: Role) => (req: request.Test) =>
    role === undefined ? req : req.set('x-test-role', role);

  it('answers 401 without a signed-in person', async () => {
    const response = await request(httpServer(app)).get('/api/v1/audit/verify');
    expect(response.status).toBe(401);
    expect(ApiError.parse(response.body).code).toBe('UNAUTHENTICATED');
  });

  it.each(['CASHIER', 'WAITER', 'KITCHEN'] as const)('refuses %s (403)', async (role) => {
    const response = await as(role)(request(httpServer(app)).get('/api/v1/audit/verify'));
    expect(response.status).toBe(403);
    expect(ApiError.parse(response.body).code).toBe('FORBIDDEN');
  });

  it.each(['OWNER', 'MANAGER'] as const)('lets %s verify the chain', async (role) => {
    await record(f);
    const response = await as(role)(request(httpServer(app)).get('/api/v1/audit/verify'));
    expect(response.status).toBe(200);
    const body = AuditVerifyResponse.parse(response.body);
    expect(body.valid).toBe(true);
    expect(body.head?.seq).toBe(body.checkedEntries);
  });

  it('keeps health public', async () => {
    expect((await request(httpServer(app)).get('/api/v1/health')).status).toBe(200);
  });

  it('denies a route that declares no capability, whoever asks', async () => {
    const response = await as('OWNER')(
      request(httpServer(app)).post('/api/v1/probe-audit/undeclared'),
    );
    expect(response.status).toBe(403);
  });

  it('asks for a manager override instead of allowing an OVERRIDE grant', async () => {
    const response = await as('CASHIER')(request(httpServer(app)).post('/api/v1/probe-audit/void'));
    expect(response.status).toBe(403);
    expect(ApiError.parse(response.body).code).toBe('OVERRIDE_REQUIRED');
    expect(
      (await as('MANAGER')(request(httpServer(app)).post('/api/v1/probe-audit/void'))).status,
    ).toBe(201);
  });

  it('passes an OWN grant on to the service to check ownership', async () => {
    const response = await as('WAITER')(
      request(httpServer(app)).post('/api/v1/probe-audit/approve'),
    );
    expect(response.status).toBe(201);
  });

  it('@Audited records who changed what, with the id from the route or the response', async () => {
    const itemId = newId();
    const response = await as('MANAGER')(
      request(httpServer(app))
        .post(`/api/v1/probe-audit/menu/${itemId}/price`)
        .set('x-correlation-id', 'price-change-1'),
    );
    expect(response.status).toBe(201);
    const entry = await f.prisma.auditLog.findFirstOrThrow({
      where: { action: 'MENU_PRICE_CHANGED' },
    });
    expect(entry).toMatchObject({
      entityType: 'item',
      entityId: itemId,
      actorId: staffIds.MANAGER,
      deviceId,
      restaurantId: f.restaurantId,
      correlationId: 'price-change-1',
    });

    const created = await as('OWNER')(request(httpServer(app)).post('/api/v1/probe-audit/staff'));
    const staffEntry = await f.prisma.auditLog.findFirstOrThrow({
      where: { action: 'STAFF_CREATED' },
    });
    expect(staffEntry.entityId).toBe((created.body as { id: string }).id);
    expect((await f.audit.verify()).valid).toBe(true);
  });

  it('@Audited writes nothing when the action fails', async () => {
    const response = await as('OWNER')(request(httpServer(app)).post('/api/v1/probe-audit/fail'));
    expect(response.status).toBe(500);
    expect(await f.prisma.auditLog.count({ where: { action: 'MENU_ITEM_ARCHIVED' } })).toBe(0);
  });
});
