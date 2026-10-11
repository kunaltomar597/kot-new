import { once } from 'node:events';
import { type AddressInfo, createServer, type Server } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { type LoginResponse, PrinterDiscoveryResponse } from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { PRINTER_NETWORKS } from '../../src/printing/printer-discovery.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let manager: LoginResponse;
let waiter: LoginResponse;
/** Two stand-in receipt printers on this machine. */
const printers: Server[] = [];
const ports: number[] = [];

beforeAll(async () => {
  for (let index = 0; index < 2; index += 1) {
    const printer = createServer((socket) => {
      socket.end();
    });
    printer.listen(0, '127.0.0.1');
    await once(printer, 'listening');
    printers.push(printer);
    ports.push((printer.address() as AddressInfo).port);
  }
  database = await createTestDatabase();
  app = await createTestApp({
    databaseUrl: database.url,
    // The restaurant's network, as far as this test goes: this machine and an address that is
    // not there.
    overrides: [
      {
        provide: PRINTER_NETWORKS,
        useValue: {
          networks: () => [{ label: '127.0.0.0/24', hosts: ['127.0.0.1', '127.0.0.2'] }],
        },
      },
    ],
  });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  waiter = await signIn(app, kit, 'WAITER');
});

afterAll(async () => {
  for (const printer of printers) printer.close();
  await app.close();
  await database.drop();
});

const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const server = () => request(httpServer(app));

describe('[ONB-004] finding printers on the network', () => {
  it('lists what answers on the printer ports, saying which printers are already added', async () => {
    const [first = 0, second = 0] = ports;
    const changed = await server()
      .put('/api/v1/settings/printers.discoveryPorts')
      .set(as(manager))
      .send({ value: [first, second], reason: 'Our printers use other ports' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const added = await prisma.printer.create({
      data: {
        restaurantId: kit.restaurantId,
        name: 'Kitchen printer',
        connection: 'NETWORK',
        host: '127.0.0.1',
        port: first,
      },
    });

    expect((await server().post('/api/v1/printers/discover').set(as(waiter))).status).toBe(403);
    const response = await server().post('/api/v1/printers/discover').set(as(manager));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(PrinterDiscoveryResponse.parse(response.body)).toEqual({
      networks: ['127.0.0.0/24'],
      printers: [
        { host: '127.0.0.1', port: first, printerId: added.id, printerName: 'Kitchen printer' },
        { host: '127.0.0.1', port: second, printerId: null, printerName: null },
      ],
    });
    // Looking adds nothing.
    expect(await prisma.printer.count()).toBe(1);
  });
});
