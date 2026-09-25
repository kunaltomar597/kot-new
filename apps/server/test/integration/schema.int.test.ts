import { CAPABILITIES, ORDER_ITEM_STATES, ORDER_SOURCES, ROLES, TABLE_STATES } from '@rp/domain';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/common/ids.js';
import { seedDevelopmentData, type SeedSummary } from '../../src/database/dev-seed.js';
import { allocateDailyNumber, allocateInvoiceSequence } from '../../src/database/numbering.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import {
  OrderItemState,
  OrderSource,
  StaffRole,
  TableState,
} from '../../src/generated/prisma/enums.js';
import { testConfig } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

const PROTECTED = [
  'orders',
  'order_items',
  'order_item_modifiers',
  'order_events',
  'kots',
  'kot_lines',
  'approvals',
  'invoices',
  'invoice_lines',
  'tax_lines',
  'discounts',
  'payments',
  'cash_movements',
  'shifts',
  'day_ends',
  'business_days',
  'audit_log',
];

let database: TestDatabase;
let prisma: PrismaService;
let seed: SeedSummary;

/** Runs `work` on a connection whose current role is `role` (the superuser is dropped). */
async function asRole<T>(role: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: database.url });
  await client.connect();
  try {
    await client.query(`SET ROLE ${role}`);
    return await work(client);
  } finally {
    await client.end();
  }
}

async function query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: database.url });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  database = await createTestDatabase();
  prisma = new PrismaService(testConfig({ databaseUrl: database.url }));
  seed = await seedDevelopmentData(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  await database.drop();
});

describe('development seed', () => {
  it('creates one restaurant with tax groups, stations, tables, staff and a full menu', async () => {
    expect(seed).toMatchObject({ items: 30, tables: 10, staff: 6 });
    expect(await prisma.restaurant.count()).toBe(1);
    const taxGroups = await prisma.taxGroup.findMany({ include: { components: true } });
    expect(taxGroups.map((group) => group.name).sort()).toEqual(['GST 18 %', 'GST 5 %']);
    expect(await prisma.station.count()).toBe(2);
    expect(await prisma.diningTable.count()).toBe(10);
    expect(await prisma.item.count()).toBe(30);
    expect(await prisma.variant.count()).toBeGreaterThan(0);
    expect(await prisma.itemModifierGroup.count()).toBeGreaterThan(0);
    const combo = await prisma.combo.findFirstOrThrow({
      include: { components: { include: { choices: true } } },
    });
    expect(combo.components.find((c) => c.kind === 'CHOICE')?.choices).toHaveLength(2);
    const roles = await prisma.role.findMany({ include: { staff: true } });
    expect(roles.map((role) => role.baseRole).sort()).toEqual([...ROLES].sort());
    expect(roles.every((role) => role.staff.length > 0)).toBe(true);
  });

  it('refuses to run on a database that already has a restaurant', async () => {
    await expect(seedDevelopmentData(prisma)).rejects.toThrow(/empty database/);
  });
});

describe('[SEC-005] [INT-005] schema conventions', () => {
  it('gives every table an id, restaurant_id, created_at and updated_at', async () => {
    const rows = await query<{ table_name: string; columns: string[] }>(`
      SELECT table_name, array_agg(column_name::text) AS columns
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name NOT IN ('_prisma_migrations', 'system_meta', 'restaurants')
      GROUP BY table_name`);
    expect(rows.length).toBeGreaterThanOrEqual(50);
    for (const row of rows) {
      expect(row.columns, row.table_name).toEqual(
        expect.arrayContaining(['id', 'restaurant_id', 'created_at', 'updated_at']),
      );
    }
  });

  it('puts a business date on every business record', async () => {
    const rows = await query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'business_date' AND data_type = 'date'`);
    expect(rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        'orders',
        'order_items',
        'kots',
        'invoices',
        'payments',
        'shifts',
        'cash_movements',
        'day_ends',
        'audit_log',
        'table_sessions',
        'discounts',
      ]),
    );
  });

  it('stores money as integers, never floats or decimals', async () => {
    const rows = await query<{ table_name: string; column_name: string }>(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type IN ('numeric', 'real', 'double precision', 'money')`);
    expect(rows).toEqual([]);
  });

  it('keeps external ids on items, tables and staff, and external refs on orders', async () => {
    const rows = await query<{ table_name: string; column_name: string }>(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('external_id', 'external_ref', 'source')`);
    const has = (table: string, column: string) =>
      rows.some((row) => row.table_name === table && row.column_name === column);
    expect(has('items', 'external_id')).toBe(true);
    expect(has('tables', 'external_id')).toBe(true);
    expect(has('staff', 'external_id')).toBe(true);
    expect(has('orders', 'external_ref')).toBe(true);
    expect(has('orders', 'source')).toBe(true);
  });

  it('mirrors the @rp/domain enums', () => {
    expect(Object.values(OrderItemState)).toEqual([...ORDER_ITEM_STATES]);
    expect(Object.values(OrderSource)).toEqual([...ORDER_SOURCES]);
    expect(Object.values(TableState)).toEqual([...TABLE_STATES]);
    expect(Object.values(StaffRole)).toEqual([...ROLES]);
    expect(CAPABILITIES.length).toBeGreaterThan(0);
  });
});

describe('[AUD-004] [SEC-007] least-privilege database roles', () => {
  it('gives rp_app SELECT, INSERT and UPDATE on every table', async () => {
    const rows = await query<{ tablename: string; ok: boolean }>(`
      SELECT tablename,
        has_table_privilege('rp_app', format('%I.%I', schemaname, tablename), 'SELECT, INSERT') AS ok
      FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`);
    expect(rows.filter((row) => !row.ok)).toEqual([]);
  });

  it('never lets rp_app DELETE financial or audit records', async () => {
    const rows = await query<{ tablename: string }>(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND has_table_privilege('rp_app', format('%I.%I', schemaname, tablename), 'DELETE')`);
    const deletable = rows.map((row) => row.tablename);
    for (const table of PROTECTED) expect(deletable, table).not.toContain(table);
    // Operational tables stay deletable (e.g. expired sessions, published outbox rows).
    expect(deletable).toEqual(
      expect.arrayContaining(['sessions', 'idempotency_records', 'outbox']),
    );
  });

  it.each(PROTECTED)('rejects DELETE FROM %s by rp_app', async (table) => {
    await asRole('rp_app', async (client) => {
      await expect(client.query(`DELETE FROM ${table}`)).rejects.toThrow(/permission denied/);
    });
  });

  it('lets rp_app delete operational rows', async () => {
    await asRole('rp_app', async (client) => {
      await expect(client.query('DELETE FROM idempotency_records')).resolves.toBeDefined();
    });
  });
});

describe('[AUD-004] append-only audit log', () => {
  let auditId: string;

  beforeAll(async () => {
    const entry = await prisma.auditLog.create({
      data: {
        restaurantId: seed.restaurantId,
        businessDate: new Date('2026-09-25'),
        action: 'TEST_ENTRY',
        entityType: 'restaurant',
        entityId: seed.restaurantId,
        after: { ok: true },
      },
    });
    auditId = entry.id;
  });

  it('lets rp_app insert and read audit rows but not update them', async () => {
    await asRole('rp_app', async (client) => {
      await client.query(
        `INSERT INTO audit_log (id, restaurant_id, business_date, action, entity_type)
         VALUES ($1, $2, '2026-09-25', 'APP_ENTRY', 'restaurant')`,
        [newId(), seed.restaurantId],
      );
      await expect(
        client.query(`UPDATE audit_log SET reason = 'x' WHERE id = $1`, [auditId]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it('blocks UPDATE and DELETE even for the owner, through a trigger', async () => {
    await expect(
      query(`UPDATE audit_log SET reason = 'tamper' WHERE id = $1`, [auditId]),
    ).rejects.toThrow(/cannot be changed/);
    await asRole('rp_owner', async (client) => {
      await expect(client.query('DELETE FROM audit_log WHERE id = $1', [auditId])).rejects.toThrow(
        /archive-and-purge/,
      );
    });
  });

  it('lets only rp_purge remove audit rows', async () => {
    const removed = await asRole('rp_purge', (client) =>
      client.query(`DELETE FROM audit_log WHERE action = 'APP_ENTRY'`),
    );
    expect(removed.rowCount).toBe(1);
  });
});

describe('[BILL-003] [BILL-010] invoice protection', () => {
  async function createInvoice(status: 'ISSUED' | 'SETTLED') {
    const series = await prisma.invoiceSeries.findFirstOrThrow({ where: { isDefault: true } });
    const staff = await prisma.staff.findFirstOrThrow();
    const sequence = await prisma.transaction((tx) =>
      allocateInvoiceSequence(tx, {
        restaurantId: seed.restaurantId,
        seriesId: series.id,
        financialYear: '2099-00',
      }),
    );
    const invoice = await prisma.invoice.create({
      data: {
        restaurantId: seed.restaurantId,
        businessDate: new Date('2026-09-25'),
        invoiceDate: new Date('2026-09-25'),
        financialYear: '2099-00',
        seriesId: series.id,
        sequence,
        invoiceNumber: `T/${String(sequence)}`,
        status: 'ISSUED',
        priceMode: 'TAX_EXCLUSIVE',
        subtotal: 10_000,
        taxTotal: 500,
        grandTotal: 10_500,
        issuedById: staff.id,
        lines: {
          create: {
            restaurantId: seed.restaurantId,
            description: 'Paneer Tikka',
            quantity: 1,
            unitPrice: 10_000,
            lineTotal: 10_000,
            taxableValue: 10_000,
          },
        },
      },
    });
    // Lines are written while the bill is open; settling comes after (BILL-010).
    if (status === 'ISSUED') return invoice;
    return prisma.invoice.update({
      where: { id: invoice.id },
      data: { status, settledAt: new Date() },
    });
  }

  it('lets a printed (issued) invoice be edited', async () => {
    const invoice = await createInvoice('ISSUED');
    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: { subtotal: 9_000, taxTotal: 450, grandTotal: 9_450, version: 2 },
    });
    expect(updated.grandTotal).toBe(9_450);
  });

  it('freezes the number and amounts of a settled invoice but allows voiding it', async () => {
    const invoice = await createInvoice('SETTLED');
    await expect(
      prisma.invoice.update({ where: { id: invoice.id }, data: { grandTotal: 1 } }),
    ).rejects.toThrow(/cannot change/);
    await expect(
      prisma.invoice.update({ where: { id: invoice.id }, data: { status: 'ISSUED' } }),
    ).rejects.toThrow(/cannot be reopened/);
    await expect(
      prisma.invoiceLine.updateMany({ where: { invoiceId: invoice.id }, data: { quantity: 2 } }),
    ).rejects.toThrow(/cannot change/);
    const voided = await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: 'VOIDED', voidedAt: new Date(), voidReason: 'Wrong table' },
    });
    expect(voided.status).toBe('VOIDED');
    await expect(
      prisma.invoice.update({ where: { id: invoice.id }, data: { status: 'SETTLED' } }),
    ).rejects.toThrow(/cannot be reopened/);
  });
});

describe('[BILL-003] [ORD-008] gap-free numbering', () => {
  it('allocates consecutive invoice numbers under concurrency, per series and year', async () => {
    const series = await prisma.invoiceSeries.findFirstOrThrow({ where: { prefix: 'TA' } });
    const allocate = () =>
      prisma.transaction((tx) =>
        allocateInvoiceSequence(tx, {
          restaurantId: seed.restaurantId,
          seriesId: series.id,
          financialYear: '2026-27',
        }),
      );
    const numbers = await Promise.all(Array.from({ length: 20 }, allocate));
    expect([...numbers].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const nextYear = await prisma.transaction((tx) =>
      allocateInvoiceSequence(tx, {
        restaurantId: seed.restaurantId,
        seriesId: series.id,
        financialYear: '2027-28',
      }),
    );
    expect(nextYear).toBe(1);
  });

  it('gives the number back when the transaction rolls back', async () => {
    const input = {
      restaurantId: seed.restaurantId,
      businessDate: '2026-09-26',
      kind: 'ORDER' as const,
    };
    expect(await prisma.transaction((tx) => allocateDailyNumber(tx, input))).toBe(1);
    await expect(
      prisma.transaction(async (tx) => {
        await allocateDailyNumber(tx, input);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await prisma.transaction((tx) => allocateDailyNumber(tx, input))).toBe(2);
  });

  it('restarts order, KOT and token numbers every business day, independently', async () => {
    const next = (businessDate: string, kind: 'ORDER' | 'KOT' | 'TAKEAWAY_TOKEN') =>
      prisma.transaction((tx) =>
        allocateDailyNumber(tx, { restaurantId: seed.restaurantId, businessDate, kind }),
      );
    expect(await next('2026-10-01', 'KOT')).toBe(1);
    expect(await next('2026-10-01', 'KOT')).toBe(2);
    expect(await next('2026-10-01', 'TAKEAWAY_TOKEN')).toBe(1);
    expect(await next('2026-10-02', 'KOT')).toBe(1);
  });

  it('rejects malformed dates and financial years', async () => {
    await expect(
      prisma.transaction((tx) =>
        allocateDailyNumber(tx, {
          restaurantId: seed.restaurantId,
          businessDate: '26-9-2026',
          kind: 'KOT',
        }),
      ),
    ).rejects.toThrow(RangeError);
    await expect(
      prisma.transaction((tx) =>
        allocateInvoiceSequence(tx, {
          restaurantId: seed.restaurantId,
          seriesId: newId(),
          financialYear: '2026',
        }),
      ),
    ).rejects.toThrow(RangeError);
  });
});
