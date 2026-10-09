import { createConnection, createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import type { QrMenuDocument } from '@rp/contracts/relay';
import { describe, expect, it } from 'vitest';
import {
  DESIGN_CAPACITY,
  ORDER_MIX,
  pagerCount,
  schedule,
  seeded,
  SMOKE_SHAPE,
  spareScreenCount,
  within,
} from '../load/plan.js';
import { readJob } from '../load/printer.js';
import { type AvailabilityChange, inStepWith } from '../load/qr.js';
import { startSlowLine } from '../load/slow-line.js';
import { ms } from '../load/report.js';
import { percentile, SampleSets, Samples } from '../load/stats.js';

/** The load run's own logic (P8-01a): its figures, its schedule and what it reads off a page. */

describe('[NFR-P01] latency figures', () => {
  it('takes nearest-rank percentiles: values that were really measured', () => {
    const sorted = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile(sorted, 100)).toBe(100);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNull();
    expect(percentile([3, 9], 0)).toBe(3);
  });

  it('summarises samples, and refuses what is not a latency', () => {
    const samples = new Samples();
    for (const value of [30, 10, 20, -1]) samples.add(value);
    expect(samples.summary()).toEqual({ count: 4, p50: 10, p95: 30, p99: 30, max: 30 });
    expect(() => {
      samples.add(Number.NaN);
    }).toThrow('Not a latency');
    const sets = new SampleSets();
    sets.of('b').add(1);
    sets.of('a').add(2);
    expect(Object.keys(sets.summaries())).toEqual(['a', 'b']);
    sets.clear();
    expect(sets.summaries()).toEqual({});
  });

  it('writes milliseconds as the report shows them', () => {
    expect(ms(null)).toBe('–');
    expect(ms(12.4)).toBe('12 ms');
    expect(ms(9_999)).toBe('9999 ms');
    expect(ms(30_000)).toBe('30.0 s');
  });
});

describe('§7.2 the restaurant the run simulates', () => {
  it('has the design capacity: 200 connections, 30 pagers, 8 printers, 6 kitchen screens', () => {
    const shape = DESIGN_CAPACITY;
    expect(shape.tables).toBe(100);
    expect(shape.dishes).toBe(1_000);
    expect(shape.tablets).toBe(60);
    expect(shape.waiters).toBe(20);
    expect(shape.stations).toBe(6);
    expect(shape.stations + shape.billPrinters).toBe(8);
    expect(pagerCount(shape)).toBe(30);
    const devices =
      shape.tablets + shape.waiters + shape.stations + shape.posTerminals + shape.dashboards;
    expect(devices + spareScreenCount(shape)).toBe(200);
    expect(shape.ordersPerHour).toBe(300);
    expect(shape.historyDays * shape.historyOrdersPerDay).toBe(730_000);
  });

  it('keeps the short run consistent', () => {
    const shape = SMOKE_SHAPE;
    const devices =
      shape.tablets + shape.waiters + shape.stations + shape.posTerminals + shape.dashboards;
    expect(devices + spareScreenCount(shape)).toBe(shape.connections);
    expect(shape.tablets).toBeLessThanOrEqual(shape.tables);
  });
});

describe('[NFR-P01] [S1] the schedule of the rush', () => {
  it('is the same for the same seed, in time order, inside the run', () => {
    const first = schedule(DESIGN_CAPACITY, seeded(1));
    expect(schedule(DESIGN_CAPACITY, seeded(1))).toEqual(first);
    expect(schedule(DESIGN_CAPACITY, seeded(2))).not.toEqual(first);
    const times = first.map((arrival) => arrival.atMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(Math.max(...times)).toBeLessThan(DESIGN_CAPACITY.minutes * 60_000);
  });

  it('brings orders at the peak rate, made up as the mix says, and a bill for each new party', () => {
    // An hour, many times over, so the counts settle near their means.
    const shape = { ...DESIGN_CAPACITY, minutes: 600 };
    const arrivals = schedule(shape, seeded(42));
    const count = (kind: string) => arrivals.filter((arrival) => arrival.kind === kind).length;
    const hours = shape.minutes / 60;
    const orders = Object.keys(ORDER_MIX).reduce((sum, kind) => sum + count(kind), 0);
    expect(orders / hours).toBeGreaterThan(285);
    expect(orders / hours).toBeLessThan(315);
    for (const [kind, share] of Object.entries(ORDER_MIX)) {
      expect(count(kind) / orders).toBeCloseTo(share, 1);
    }
    expect(count('BILL') / count('NEW_PARTY')).toBeGreaterThan(0.9);
    expect(count('BILL') / count('NEW_PARTY')).toBeLessThan(1.1);
    expect(count('AVAILABILITY')).toBe(shape.minutes);
    expect(count('REPORT')).toBe(shape.minutes / 2);
  });

  it('draws reaction times inside their range', () => {
    const random = seeded(3);
    for (let index = 0; index < 1_000; index += 1) {
      const value = within(random, [5, 20]);
      expect(value).toBeGreaterThanOrEqual(5_000);
      expect(value).toBeLessThanOrEqual(20_000);
    }
  });
});

describe('[NFR-P02] [NFR-P08] what a printed page says it is', () => {
  it('reads a kitchen ticket and a bill', () => {
    expect(readJob('\u001b@\u001bE\u0001KOT 12            Order 34\n')).toEqual({
      kotNumber: 12,
      orderNumber: 34,
      invoiceNumber: null,
    });
    expect(readJob('TAX INVOICE\nNo: INV/26-27/000123    09/10/2026\n')).toEqual({
      kotNumber: null,
      orderNumber: null,
      invoiceNumber: 'INV/26-27/000123',
    });
  });
});

describe('[NFR-P05] [NFR-P06] the QR side of the run', () => {
  it('delays every chunk on the internet line each way, in order', async () => {
    // An echo server behind a line of 60 ms each way.
    const echo = createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    const address = echo.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const line = await startSlowLine({ host: '127.0.0.1', port }, 60);
    try {
      const socket = createConnection({ host: '127.0.0.1', port: line.port });
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      let received = '';
      const started = performance.now();
      const done = new Promise<number>((resolve) => {
        socket.on('data', (chunk) => {
          received += chunk.toString();
          if (received.length >= 6) resolve(performance.now() - started);
        });
      });
      socket.write('abc');
      socket.write('def');
      const roundTrip = await done;
      expect(received).toBe('abcdef');
      expect(roundTrip).toBeGreaterThanOrEqual(115);
      socket.destroy();
    } finally {
      await line.stop();
      await new Promise<void>((resolve) => {
        echo.close(() => {
          resolve();
        });
      });
    }
  });

  it('counts a page in step when it shows a change, or once a later one has begun', () => {
    const menu = (available: boolean) =>
      ({ menu: { items: [{ id: 'dal', available }] } }) as unknown as QrMenuDocument;
    const out: AvailabilityChange = { itemId: 'dal', available: false, startedAt: 1_000 };
    const back: AvailabilityChange = { itemId: 'dal', available: true, startedAt: 31_000 };
    const changes = [out, back];
    // Before the relay has it, the page still shows the dish.
    expect(inStepWith(menu(true), out, changes, 2_000)).toBe(false);
    expect(inStepWith(menu(false), out, changes, 12_000)).toBe(true);
    // A page that never looked while it was out: in step only once the dish was back in stock.
    expect(inStepWith(menu(true), out, changes, 30_000)).toBe(false);
    expect(inStepWith(menu(true), out, changes, 35_000)).toBe(true);
    expect(inStepWith(menu(false), back, changes, 35_000)).toBe(false);
    expect(inStepWith(menu(true), back, changes, 45_000)).toBe(true);
  });
});
