import { describe, expect, it } from 'vitest';
import { MEASURABLE_ROWS, projectVolume } from '../performance/volume-model.js';

/** The five-year projection behind the data-volume test (P7-06d, DATA-012). */

const base = {
  ordersPerDay: 2_000,
  years: 5,
  retained: new Set(['alerts']),
  retentionDays: 90,
  fixedBytes: 1_000,
  allowance: 1.5,
};

describe('[DATA-012] projecting five years of data', () => {
  it('scales each table by its rows per order and its measured cost per row', () => {
    const projection = projectVolume({
      ...base,
      flow: { orders: 100, tables: [{ table: 'orders', rows: 100, averageRowBytes: 200 }] },
      bulk: {
        orders: 10_000,
        tables: [{ table: 'orders', rows: 10_000, totalBytes: 5_000_000, heapBytes: 2_500_000 }],
      },
    });
    expect(projection.days).toBe(1_826);
    expect(projection.orders).toBe(3_652_000);
    expect(projection.tables).toEqual([
      {
        table: 'orders',
        rowsPerOrder: 1,
        bytesPerRow: 500,
        bytes: 3_652_000 * 500,
        basis: 'MEASURED',
      },
    ]);
    expect(projection.indexFactor).toBe(2);
    expect(projection.totalBytes).toBe(3_652_000 * 500 * 1.5 + 1_000);
  });

  it('takes the larger count per order, and estimates tables the bulk run is too small to measure', () => {
    const projection = projectVolume({
      ...base,
      flow: {
        orders: 100,
        tables: [
          { table: 'audit_log', rows: 900, averageRowBytes: 300 },
          { table: 'order_events', rows: 500, averageRowBytes: 72 },
        ],
      },
      bulk: {
        orders: 10_000,
        tables: [
          { table: 'audit_log', rows: 20_000, totalBytes: 8_000_000, heapBytes: 6_000_000 },
          { table: 'orders', rows: 10_000, totalBytes: 3_000_000, heapBytes: 1_500_000 },
          { table: 'shifts', rows: MEASURABLE_ROWS - 1, totalBytes: 99_000, heapBytes: 9_000 },
        ],
      },
    });
    const byTable = new Map(projection.tables.map((entry) => [entry.table, entry]));
    // The real flow audits more per order than the generator writes.
    expect(byTable.get('audit_log')).toMatchObject({ rowsPerOrder: 9, bytesPerRow: 400 });
    // The median of the measurable tables' index factors (1.33 and 2).
    expect(projection.indexFactor).toBeCloseTo((8 / 6 + 2) / 2);
    expect(byTable.get('order_events')).toMatchObject({
      rowsPerOrder: 5,
      basis: 'ESTIMATED',
    });
    expect(byTable.get('order_events')?.bytesPerRow).toBeCloseTo(100 * projection.indexFactor);
    // Too few rows to measure and none in the flow: the bulk run's size per row, mostly pages.
    expect(byTable.get('shifts')).toMatchObject({ basis: 'ESTIMATED', bytesPerRow: 99_000 / 999 });
  });

  it('adds what is assumed only for tables neither run wrote', () => {
    const projection = projectVolume({
      ...base,
      flow: { orders: 100, tables: [{ table: 'feedback', rows: 10, averageRowBytes: 100 }] },
      bulk: { orders: 1, tables: [] },
      assumed: [
        { table: 'feedback', rowsPerOrder: 1, bytesPerRow: 1_000 },
        { table: 'relay_orders', rowsPerOrder: 0.25, bytesPerRow: 2_000 },
      ],
    });
    const byTable = new Map(projection.tables.map((entry) => [entry.table, entry]));
    expect(byTable.get('feedback')).toMatchObject({ basis: 'ESTIMATED', rowsPerOrder: 0.1 });
    expect(byTable.get('relay_orders')).toEqual({
      table: 'relay_orders',
      rowsPerOrder: 0.25,
      bytesPerRow: 2_000,
      bytes: 0.25 * 3_652_000 * 2_000,
      basis: 'ASSUMED',
    });
  });

  it('keeps tables under the daily retention to their days', () => {
    const projection = projectVolume({
      ...base,
      flow: { orders: 1, tables: [] },
      bulk: {
        orders: 10_000,
        tables: [{ table: 'alerts', rows: 20_000, totalBytes: 4_000_000, heapBytes: 2_000_000 }],
      },
    });
    expect(projection.tables[0]?.bytes).toBe(2 * 90 * 2_000 * 200);
  });
});
