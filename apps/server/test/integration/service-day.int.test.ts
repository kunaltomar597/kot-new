import { createServer, type Server } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { ApiClient } from '@rp/api-client';
import { afterAll, beforeAll } from 'vitest';
import { CredentialHasher } from '../../src/auth/credential-hasher.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { DEV_PINS, seedDevelopmentData } from '../../src/database/dev-seed.js';
import type { ServiceDayOptions } from '../scenario/service-day.js';
import { serviceDaySuite } from '../scenario/service-day-suite.js';
import { appUrl, createTestApp } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

/**
 * Phase 1 exit test (P1-14): a simulated service day of about 100 orders against the seeded demo
 * restaurant on a throwaway server, then the day's books are checked against each other. The
 * same scenario runs against a real install with `test/scenario/real-install.scenario.test.ts`.
 */

let database: TestDatabase;
let app: INestApplication;
/** A printer on the loopback that takes every job (ESC/POS over TCP 9100 style). */
let printer: Server | undefined;
let options: ServiceDayOptions;

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url, listen: true });
  const hasher = app.get(CredentialHasher);
  await seedDevelopmentData(app.get(PrismaService), { hashPin: (pin) => hasher.hash(pin) });
  printer = createServer((socket) => {
    socket.resume();
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => printer?.listen(0, '127.0.0.1', resolve));
  const address = printer.address();
  if (address === null || typeof address === 'string') throw new Error('No printer port');
  await app
    .get(PrismaService)
    .printer.updateMany({ data: { host: '127.0.0.1', port: address.port } });
  const baseUrl = appUrl(app);
  options = {
    baseUrl,
    // The first terminal takes the bootstrap code; the manager pairs the second.
    pairingCodes: async (manager) => {
      if (manager === null) {
        return (await new ApiClient({ baseUrl }).api.createBootstrapPairingCode()).code;
      }
      return (await manager.api.createPairingCode({ body: { type: 'POS', name: 'Counter 2' } }))
        .code;
    },
    manager: { name: 'Vikram (Manager)', pin: DEV_PINS['Vikram (Manager)'] },
    cashier: { name: 'Neha (Cashier)', pin: DEV_PINS['Neha (Cashier)'] },
    log: (line) => {
      process.stdout.write(`${line}\n`);
    },
  };
}, 120_000);

afterAll(async () => {
  await app.close();
  await new Promise((resolve) => {
    if (printer === undefined) resolve(undefined);
    else printer.close(resolve);
  });
  await database.drop();
});

serviceDaySuite(() => options);
