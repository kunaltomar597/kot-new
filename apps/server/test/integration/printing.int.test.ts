import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type AddressInfo, type Server } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  type LoginResponse,
  PrinterListResponse,
  PrinterView,
  StationListResponse,
  StationView,
  SubmitOrderResponse,
  TableSessionView,
  TestPrintResponse,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { KotTicketsService } from '../../src/printing/kot-tickets.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let manager: LoginResponse;
let waiter: LoginResponse;

/** A stand-in network printer: a TCP server that keeps every job it receives. */
let fakePrinter: Server;
let fakePrinterPort: number;
const jobs: Buffer[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  waiter = await signIn(app, kit, 'WAITER');
  await prisma.restaurant.update({
    where: { id: kit.restaurantId },
    data: { displayName: 'Spice Route' },
  });

  fakePrinter = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => {
      jobs.push(Buffer.concat(chunks));
      socket.end();
    });
  });
  fakePrinter.listen(0, '127.0.0.1');
  await once(fakePrinter, 'listening');
  fakePrinterPort = (fakePrinter.address() as AddressInfo).port;
});

afterAll(async () => {
  fakePrinter.close();
  await app.close();
  await database.drop();
});

const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;
const server = () => request(httpServer(app));

async function changesAnnounced(part: string): Promise<number> {
  return prisma.outboxEvent.count({
    where: { eventType: 'RestaurantChanged', payload: { path: ['payload', 'part'], equals: part } },
  });
}

/** A port nothing listens on: bound once to learn a free number, then closed. */
async function closedPort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  probe.close();
  await once(probe, 'close');
  return port;
}

let kitchenPrinter: PrinterView;
let barPrinter: PrinterView;
let kitchen: StationView;

describe('[KDS-008] [ONB-004] printers', () => {
  it('lets managers add network and USB printers, audited and announced', async () => {
    const byWaiter = await server().post('/api/v1/printers').set(as(waiter)).send({
      name: 'Kitchen',
      connection: 'NETWORK',
      host: '127.0.0.1',
      port: 9100,
      paperWidthMm: 80,
    });
    expect(byWaiter.status).toBe(403);

    const created = await server().post('/api/v1/printers').set(as(manager)).send({
      name: 'Kitchen printer',
      connection: 'NETWORK',
      host: '127.0.0.1',
      port: fakePrinterPort,
      paperWidthMm: 80,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    kitchenPrinter = PrinterView.parse(created.body);
    expect(kitchenPrinter).toMatchObject({ connection: 'NETWORK', lastSeenAt: null });

    const usb = await server().post('/api/v1/printers').set(as(manager)).send({
      name: 'Bar printer',
      connection: 'USB',
      host: 'BarPrinter',
      port: 9100,
      paperWidthMm: 58,
    });
    expect(usb.status, JSON.stringify(usb.body)).toBe(201);
    barPrinter = PrinterView.parse(usb.body);
    // A USB printer has no port; one sent anyway is not kept.
    expect(barPrinter).toMatchObject({ connection: 'USB', host: 'BarPrinter', port: null });

    expect(
      await prisma.auditLog.count({
        where: { action: 'PRINTER_CREATED', restaurantId: kit.restaurantId },
      }),
    ).toBe(2);
    expect(await changesAnnounced('PRINTERS')).toBe(2);

    const list = PrinterListResponse.parse(
      (await server().get('/api/v1/printers').set(as(manager))).body,
    );
    expect(list.printers.map((printer) => printer.name)).toEqual([
      'Bar printer',
      'Kitchen printer',
    ]);
  });

  it('rejects addresses that are not a printer', async () => {
    const cases = [
      { connection: 'NETWORK', host: '127.0.0.1', port: null },
      { connection: 'NETWORK', host: 'http://printer/', port: 9100 },
      { connection: 'USB', host: '../../etc/passwd', port: null },
      { connection: 'USB', host: '\\\\otherpc\\share', port: null },
    ];
    for (const fields of cases) {
      const response = await server()
        .post('/api/v1/printers')
        .set(as(manager))
        .send({ name: 'Odd', paperWidthMm: 80, ...fields });
      expect(response.status, JSON.stringify(fields)).toBe(400);
    }
  });

  it('keeps printer names unique and records only real changes', async () => {
    const clash = await server().post('/api/v1/printers').set(as(manager)).send({
      name: 'KITCHEN PRINTER',
      connection: 'NETWORK',
      host: '10.0.0.9',
      port: 9100,
      paperWidthMm: 80,
    });
    expect(clash.status).toBe(409);
    expect(codeOf(clash)).toBe('PRINTER_NAME_TAKEN');

    const same = await server().put(`/api/v1/printers/${barPrinter.id}`).set(as(manager)).send({
      name: 'Bar printer',
      connection: 'USB',
      host: 'BarPrinter',
      port: null,
      paperWidthMm: 58,
    });
    expect(same.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'PRINTER_CHANGED' } })).toBe(0);

    const wider = await server().put(`/api/v1/printers/${barPrinter.id}`).set(as(manager)).send({
      name: 'Bar printer',
      connection: 'USB',
      host: 'BarPrinter',
      port: null,
      paperWidthMm: 80,
    });
    expect(PrinterView.parse(wider.body).paperWidthMm).toBe(80);
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'PRINTER_CHANGED' },
    });
    expect(entry.before).toMatchObject({ paperWidthMm: 58 });
    expect(entry.after).toMatchObject({ paperWidthMm: 80 });
  });

  it('prints a test page and records when the printer was last seen', async () => {
    const response = await server()
      .post(`/api/v1/printers/${kitchenPrinter.id}/test`)
      .set(as(manager));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(TestPrintResponse.parse(response.body)).toEqual({ printed: true, error: null });

    await expect.poll(() => jobs.length).toBe(1);
    const page = jobs[0] ?? Buffer.alloc(0);
    expect(Array.from(page.subarray(0, 2))).toEqual([0x1b, 0x40]);
    expect(page.toString('latin1')).toContain('TEST PAGE');
    expect(page.toString('latin1')).toContain('Spice Route');
    expect(page.toString('latin1')).toContain('Printer: Kitchen printer');

    const seen = await prisma.printer.findUniqueOrThrow({ where: { id: kitchenPrinter.id } });
    expect(seen.lastSeenAt).not.toBeNull();
  });

  it('answers in plain words when the printer does not take the page', async () => {
    const port = await closedPort();
    const offline = PrinterView.parse(
      (
        await server().post('/api/v1/printers').set(as(manager)).send({
          name: 'Offline printer',
          connection: 'NETWORK',
          host: '127.0.0.1',
          port,
          paperWidthMm: 80,
        })
      ).body,
    );
    const response = await server().post(`/api/v1/printers/${offline.id}/test`).set(as(manager));
    expect(response.status).toBe(200);
    const result = TestPrintResponse.parse(response.body);
    expect(result.printed).toBe(false);
    expect(result.error).toContain('refused the connection');
    const row = await prisma.printer.findUniqueOrThrow({ where: { id: offline.id } });
    expect(row.lastSeenAt).toBeNull();

    // This container has no USB printer: the answer says what to check.
    const usb = TestPrintResponse.parse(
      (await server().post(`/api/v1/printers/${barPrinter.id}/test`).set(as(manager))).body,
    );
    expect(usb.printed).toBe(false);
    expect(usb.error).toMatch(/USB printer/);
  });
});

describe('[KDS-002] [KDS-008] stations', () => {
  it('lets managers add stations that show, print or both', async () => {
    const noPrinter = await server()
      .post('/api/v1/stations')
      .set(as(manager))
      .send({ name: 'Kitchen', mode: 'BOTH', printerId: null });
    expect(noPrinter.status).toBe(400);

    const unknownPrinter = await server()
      .post('/api/v1/stations')
      .set(as(manager))
      .send({ name: 'Kitchen', mode: 'BOTH', printerId: randomUUID() });
    expect(unknownPrinter.status).toBe(422);
    expect(codeOf(unknownPrinter)).toBe('PRINTER_NOT_FOUND');

    const created = await server()
      .post('/api/v1/stations')
      .set(as(manager))
      .send({ name: 'Kitchen', mode: 'BOTH', printerId: kitchenPrinter.id });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    kitchen = StationView.parse(created.body);

    // A screen-only station keeps no printer, even when one is sent.
    const bar = StationView.parse(
      (
        await server()
          .post('/api/v1/stations')
          .set(as(manager))
          .send({ name: 'Bar', mode: 'SCREEN', printerId: barPrinter.id })
      ).body,
    );
    expect(bar.printerId).toBeNull();

    const clash = await server()
      .post('/api/v1/stations')
      .set(as(manager))
      .send({ name: 'bar', mode: 'SCREEN', printerId: null });
    expect(clash.status).toBe(409);
    expect(codeOf(clash)).toBe('STATION_NAME_TAKEN');

    // Every signed-in person can read the stations (kitchen screens pick theirs).
    const list = StationListResponse.parse(
      (await server().get('/api/v1/stations').set(as(waiter))).body,
    );
    expect(list.stations.map((station) => station.name)).toEqual(['Bar', 'Kitchen']);
    expect(await changesAnnounced('STATIONS')).toBe(2);
    expect(await prisma.auditLog.count({ where: { action: 'STATION_CREATED' } })).toBe(2);
  });

  it('refuses to archive a printer a station prints on, or a station an item uses', async () => {
    const printerInUse = await server()
      .post(`/api/v1/printers/${kitchenPrinter.id}/archive`)
      .set(as(manager))
      .send({ reason: 'Replaced' });
    expect(printerInUse.status).toBe(409);
    expect(codeOf(printerInUse)).toBe('PRINTER_IN_USE');

    const category = await prisma.category.create({
      data: { restaurantId: kit.restaurantId, name: 'Menu' },
    });
    const taxGroup = await prisma.taxGroup.create({
      data: { restaurantId: kit.restaurantId, name: 'GST 5 %' },
    });
    await prisma.item.create({
      data: {
        restaurantId: kit.restaurantId,
        categoryId: category.id,
        name: 'Paneer Tikka',
        basePrice: 28_000,
        taxGroupId: taxGroup.id,
        foodType: 'VEG',
        stationId: kitchen.id,
      },
    });
    const stationInUse = await server()
      .post(`/api/v1/stations/${kitchen.id}/archive`)
      .set(as(manager))
      .send({ reason: 'Closing it' });
    expect(stationInUse.status).toBe(409);
    expect(codeOf(stationInUse)).toBe('STATION_IN_USE');
    expect(ApiError.parse(stationInUse.body).details).toMatchObject({ itemCount: 1 });

    // A spare station nothing uses is archived with a reason, and its name can be used again.
    const spare = StationView.parse(
      (
        await server()
          .post('/api/v1/stations')
          .set(as(manager))
          .send({ name: 'Tandoor', mode: 'PRINT', printerId: kitchenPrinter.id })
      ).body,
    );
    const archived = await server()
      .post(`/api/v1/stations/${spare.id}/archive`)
      .set(as(manager))
      .send({ reason: 'Tandoor moved into the kitchen' });
    expect(archived.status).toBe(200);
    expect(StationView.parse(archived.body).archivedAt).not.toBeNull();
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'STATION_ARCHIVED', entityId: spare.id },
    });
    expect(audit.reason).toBe('Tandoor moved into the kitchen');
    const edit = await server()
      .put(`/api/v1/stations/${spare.id}`)
      .set(as(manager))
      .send({ name: 'Tandoor', mode: 'SCREEN', printerId: null });
    expect(codeOf(edit)).toBe('STATION_ARCHIVED');
  });
});

describe('[ORD-007] [KDS-008] kitchen tickets on paper', () => {
  it('renders a KOT from what was ordered, for the station printer paper', async () => {
    const tikka = await prisma.item.findFirstOrThrow({ where: { name: 'Paneer Tikka' } });
    const taxGroup = await prisma.taxGroup.findFirstOrThrow({ where: { id: tikka.taxGroupId } });
    await prisma.taxComponent.create({
      data: { restaurantId: kit.restaurantId, taxGroupId: taxGroup.id, code: 'CGST', rateBp: 250 },
    });
    const published = await server().post('/api/v1/menu/publish').set(as(manager));
    expect(published.status, JSON.stringify(published.body)).toBe(200);

    const hall = await prisma.section.create({
      data: { restaurantId: kit.restaurantId, name: 'Hall' },
    });
    const table = await prisma.diningTable.create({
      data: { restaurantId: kit.restaurantId, sectionId: hall.id, label: 'T4' },
    });
    const session = TableSessionView.parse(
      (await server().post(`/api/v1/tables/${table.id}/open`).set(as(waiter)).send({ covers: 2 }))
        .body,
    );
    const submitted = await server()
      .post('/api/v1/orders')
      .set(as(waiter))
      .send({
        idempotencyKey: randomUUID(),
        source: 'WAITER_APP',
        orderType: 'DINE_IN',
        tableSessionId: session.id,
        lines: [
          {
            clientLineId: randomUUID(),
            itemId: tikka.id,
            quantity: 2,
            instructions: 'Less spicy',
          },
        ],
      });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const accepted = SubmitOrderResponse.parse(submitted.body);
    if (accepted.status !== 'ACCEPTED') throw new Error('not accepted');
    const kot = await prisma.kot.findFirstOrThrow({ where: { orderId: accepted.orderId } });
    expect(kot.printStatus).toBe('PENDING');

    const tickets = app.get(KotTicketsService);
    const rendered = await tickets.render(kit.restaurantId, kot.id);
    expect(rendered.printer?.id).toBe(kitchenPrinter.id);
    expect(rendered.ticket).toMatchObject({
      kind: 'NEW',
      kotNumber: kot.kotNumber,
      stationName: 'Kitchen',
      destination: { type: 'TABLE', label: 'T4' },
      source: 'WAITER_APP',
      reprint: false,
      lines: [{ quantity: 2, name: 'Paneer Tikka', instructions: 'Less spicy' }],
    });
    expect(rendered.ticket.waiterName).not.toBeNull();
    const text = Buffer.from(rendered.bytes).toString('latin1');
    expect(text).toContain('TABLE T4');
    expect(text).toContain('2 x Paneer Tikka');
    expect(text).toContain('! Less spicy');

    // A reprint on 58 mm paper says so and fits the narrower paper.
    const reprint = await tickets.render(kit.restaurantId, kot.id, {
      reprint: true,
      paperWidthMm: 58,
    });
    expect(Buffer.from(reprint.bytes).toString('latin1')).toContain('REPRINT');
    expect(Buffer.from(reprint.bytes).toString('latin1')).toContain('-'.repeat(32) + '\n');

    await expect(tickets.render(kit.restaurantId, randomUUID())).rejects.toMatchObject({
      code: 'KOT_NOT_FOUND',
    });
  });
});
