import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';
import { SMOKE_SHAPE } from '../load/plan.js';
import { SimulatedPrinter } from '../load/printer.js';
import { connectQr, type QrRelay, startQrRelay } from '../load/qr.js';
import { readyForToday, setUpLoadRestaurant } from '../load/restaurant.js';
import { runRush } from '../load/rush.js';
import { type LoadTarget, startInProcessServer } from '../load/server.js';

/**
 * The load run of P8-01a, small and short, so the harness keeps working as the server changes:
 * every device, pager and printer of the full run, in fewer numbers, with the server in this
 * process, and diners' QR pages through the relay (P8-01b). Latencies are measured at design
 * capacity by `test/performance/load.perf.test.ts`; here the run must serve every order, ticket,
 * print and alert exactly once, every QR page must follow the menu, and every client must come
 * back after the server restarts.
 */

/** Pages ask for the menu every 2 s here: the short run's dishes are out for 5 s at a time. */
const SHORT_REFRESH_MS = 2_000;

let database: TestDatabase | undefined;
let target: LoadTarget | undefined;
let relay: QrRelay | undefined;
const printers: SimulatedPrinter[] = [];

afterAll(async () => {
  await target?.stop();
  await relay?.stop();
  await Promise.all(printers.map((printer) => printer.stop()));
  await database?.drop();
});

describe('[NFR-P01] [NFR-P02] [NFR-P03] [NFR-P04] [NFR-P05] [NFR-P06] [NFR-P08] [NFR-P09] [NFR-P11] a short rush', () => {
  it('serves every order, KOT, print and alert once, and every client comes back after a restart', async () => {
    const shape = SMOKE_SHAPE;
    database = await createTestDatabase();
    relay = await startQrRelay({ adminUrl: inject('pgAdminUrl'), runId: inject('pgRunId') });
    const stations = await Promise.all(
      Array.from({ length: shape.stations }, (_, index) =>
        SimulatedPrinter.start(`station ${String(index + 1)}`),
      ),
    );
    const bills = await Promise.all(
      Array.from({ length: shape.billPrinters }, (_, index) =>
        SimulatedPrinter.start(`bills ${String(index + 1)}`),
      ),
    );
    printers.push(...stations, ...bills);
    const server = await startInProcessServer({
      databaseUrl: database.url,
      dataDir: mkdtempSync(join(tmpdir(), 'rp-load-')),
      relayUrl: relay.serverUrl,
    });
    target = server;
    const ports = {
      stations: stations.map((printer) => printer.port),
      bills: bills.map((printer) => printer.port),
    };
    const restaurant = await readyForToday(
      server.app(),
      await setUpLoadRestaurant(server.app(), shape, ports, database.url),
      ports,
    );
    const tokens = await connectQr(server.app(), restaurant, relay.credential);
    const result = await runRush({
      shape,
      target: server,
      restaurant,
      databaseUrl: database.url,
      printers: { stations, bills },
      restart: true,
      qr: { relay, tokens, refreshMs: SHORT_REFRESH_MS },
    });

    expect(server.errors).toEqual([]);
    expect(result.checks.filter((check) => !check.ok)).toEqual([]);
    expect(result.devices).toBe(shape.connections);
    expect(result.pagers).toBe(shape.waiters + shape.runners + shape.managers);
    // Each target was measured (NFR-P10's reports cover a year without history here).
    for (const entry of result.targets) {
      expect(entry.summary.count, entry.id).toBeGreaterThan(0);
    }
    const restarted = result.targets.find((entry) => entry.id === 'NFR-P11');
    expect(restarted?.summary.count).toBe(shape.connections);
    expect(restarted?.met).toBe(true);
    expect(result.restart?.pagers.count).toBe(result.pagers);
    expect(result.counts['orders from QR pages']).toBeGreaterThan(0);
  }, 240_000);
});
