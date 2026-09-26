import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { type AddressInfo, createServer, type Server } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  type LoginResponse,
  PrinterView,
  PrintQueueResponse,
  StationView,
  SubmitOrderResponse,
  TableSessionView,
  TestPrintResponse,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import {
  PRINT_QUEUE_OPTIONS,
  PrintQueueService,
  TEST_PRINT_QUEUE_OPTIONS,
} from '../../src/printing/print-queue.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

/** A network printer on localhost that can be switched off and on again at the same port. */
class FakePrinter {
  readonly jobs: string[] = [];
  port = 0;
  private server: Server | undefined;

  async start(): Promise<void> {
    const server = createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('end', () => {
        this.jobs.push(Buffer.concat(chunks).toString('latin1'));
        socket.end();
      });
    });
    server.listen(this.port, '127.0.0.1');
    await once(server, 'listening');
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    server.close();
    await once(server, 'close');
  }
}

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let queue: PrintQueueService;
let kit: AuthKit;
let manager: LoginResponse;
let cashier: LoginResponse;
let waiter: LoginResponse;
const kitchenPaper = new FakePrinter();
const sparePaper = new FakePrinter();
const ids: Record<string, string> = {};
const id = (name: string) => ids[name] ?? '';

beforeAll(async () => {
  await kitchenPaper.start();
  await sparePaper.start();
  database = await createTestDatabase();
  app = await createTestApp({
    databaseUrl: database.url,
    // No waiting between retries, so each drain() tries again.
    overrides: [
      {
        provide: PRINT_QUEUE_OPTIONS,
        useValue: { ...TEST_PRINT_QUEUE_OPTIONS, retryBaseMs: 0, retryMaxMs: 0 },
      },
    ],
  });
  prisma = app.get(PrismaService);
  queue = app.get(PrintQueueService);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  cashier = await signIn(app, kit, 'CASHIER');
  waiter = await signIn(app, kit, 'WAITER');
  const base = { restaurantId: kit.restaurantId };

  const printer = async (name: string, port: number) =>
    PrinterView.parse(
      (
        await server()
          .post('/api/v1/printers')
          .set(as(manager))
          .send({ name, connection: 'NETWORK', host: '127.0.0.1', port, paperWidthMm: 80 })
      ).body,
    ).id;
  ids.kitchenPrinter = await printer('Kitchen printer', kitchenPaper.port);
  ids.sparePrinter = await printer('Spare printer', sparePaper.port);
  const station = async (name: string, mode: string, printerId: string | null) =>
    StationView.parse(
      (await server().post('/api/v1/stations').set(as(manager)).send({ name, mode, printerId }))
        .body,
    ).id;
  ids.kitchen = await station('Kitchen', 'BOTH', id('kitchenPrinter'));
  ids.bar = await station('Bar', 'SCREEN', null);

  const category = await prisma.category.create({ data: { ...base, name: 'Menu' } });
  const taxGroup = await prisma.taxGroup.create({
    data: {
      ...base,
      name: 'GST 5 %',
      components: {
        create: [
          { ...base, code: 'CGST', rateBp: 250 },
          { ...base, code: 'SGST', rateBp: 250 },
        ],
      },
    },
  });
  for (const [name, stationId] of [
    ['Paneer Tikka', id('kitchen')],
    ['Lassi', id('bar')],
  ] as const) {
    ids[name] = (
      await prisma.item.create({
        data: {
          ...base,
          categoryId: category.id,
          name,
          basePrice: 20_000,
          taxGroupId: taxGroup.id,
          foodType: 'VEG',
          stationId,
        },
      })
    ).id;
  }
  const published = await server().post('/api/v1/menu/publish').set(as(manager));
  expect(published.status, JSON.stringify(published.body)).toBe(200);

  const hall = await prisma.section.create({ data: { ...base, name: 'Hall' } });
  for (const label of ['T1', 'T2', 'T3']) {
    ids[label] = (
      await prisma.diningTable.create({ data: { ...base, sectionId: hall.id, label } })
    ).id;
  }
});

afterAll(async () => {
  await app.close();
  await database.drop();
  await kitchenPaper.stop();
  await sparePaper.stop();
});

const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;
const server = () => request(httpServer(app));

const sessions: Record<string, TableSessionView> = {};

/** Sends one Paneer Tikka (and a Lassi for the screen-only bar) from a table; returns the kitchen KOT. */
async function order(table: string, instructions = 'Order') {
  sessions[table] ??= TableSessionView.parse(
    (
      await server()
        .post(`/api/v1/tables/${id(table)}/open`)
        .set(as(waiter))
        .send({ covers: 2 })
    ).body,
  );
  const response = await server()
    .post('/api/v1/orders')
    .set(as(waiter))
    .send({
      idempotencyKey: randomUUID(),
      source: 'WAITER_APP',
      orderType: 'DINE_IN',
      tableSessionId: sessions[table].id,
      lines: [
        { clientLineId: randomUUID(), itemId: id('Paneer Tikka'), quantity: 1, instructions },
        { clientLineId: randomUUID(), itemId: id('Lassi'), quantity: 1 },
      ],
    });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const accepted = SubmitOrderResponse.parse(response.body);
  if (accepted.status !== 'ACCEPTED') throw new Error(JSON.stringify(response.body));
  return prisma.kot.findFirstOrThrow({
    where: { orderId: accepted.orderId, stationId: id('kitchen') },
  });
}

async function statusEvents() {
  const rows = await prisma.outboxEvent.findMany({
    where: { eventType: 'PrinterStatusChanged' },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((row) => (row.payload as { payload: Record<string, unknown> }).payload);
}

async function printerRow(name: string) {
  return prisma.printer.findUniqueOrThrow({ where: { id: id(name) } });
}

describe('[KDS-008] [NFR-P02] the print queue', () => {
  it('prints new tickets on their station printer; screen-only stations print nothing', async () => {
    const kot = await order('T1', 'First order');
    expect(kot.printStatus).toBe('PENDING');
    expect(await queue.drain()).toEqual({ printed: 1, failed: 0 });

    expect(kitchenPaper.jobs).toHaveLength(1);
    expect(kitchenPaper.jobs[0]).toContain('TABLE T1');
    expect(kitchenPaper.jobs[0]).toContain('! First order');
    expect(kitchenPaper.jobs[0]).not.toContain('Lassi');
    const printed = await prisma.kot.findUniqueOrThrow({ where: { id: kot.id } });
    expect(printed).toMatchObject({ printStatus: 'PRINTED', printAttempts: 1 });
    expect(printed.printedAt).not.toBeNull();
    const bar = await prisma.kot.findFirstOrThrow({
      where: { orderId: kot.orderId, stationId: id('bar') },
    });
    expect(bar.printStatus).toBe('NOT_REQUIRED');
    expect((await printerRow('kitchenPrinter')).lastSeenAt).not.toBeNull();

    // Nothing left: another pass prints nothing again.
    expect(await queue.drain()).toEqual({ printed: 0, failed: 0 });
    expect(kitchenPaper.jobs).toHaveLength(1);
  });

  it('[NTF-003] keeps tickets when the printer is offline and alerts the POS once', async () => {
    await kitchenPaper.stop();
    const second = await order('T1', 'Second order');
    expect(await queue.drain()).toEqual({ printed: 0, failed: 1 });
    const third = await order('T1', 'Third order');
    expect(await queue.drain()).toEqual({ printed: 0, failed: 1 });

    // The oldest waiting ticket is tried first, and the printer is not tried past a failure.
    expect(await prisma.kot.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({
      printStatus: 'FAILED',
      printAttempts: 2,
    });
    expect(await prisma.kot.findUniqueOrThrow({ where: { id: third.id } })).toMatchObject({
      printStatus: 'PENDING',
      printAttempts: 0,
    });
    const offline = await printerRow('kitchenPrinter');
    expect(offline.offlineSince).not.toBeNull();
    expect(offline.lastError).toContain('refused the connection');

    expect(await statusEvents()).toEqual([
      {
        printerId: id('kitchenPrinter'),
        printerName: 'Kitchen printer',
        online: false,
        error: offline.lastError,
        // Counted when it failed, before the third order was sent.
        queued: 1,
      },
    ]);

    const byWaiter = await server().get('/api/v1/print-queue').set(as(waiter));
    expect(byWaiter.status).toBe(403);
    const view = PrintQueueResponse.parse(
      (await server().get('/api/v1/print-queue').set(as(cashier))).body,
    );
    expect(
      view.printers.find((printer) => printer.printerId === id('kitchenPrinter')),
    ).toMatchObject({ online: false, queued: 2, redirectToId: null });
    expect(view.printers.find((printer) => printer.printerId === id('sparePrinter'))).toMatchObject(
      { online: true, queued: 0 },
    );
  });

  it('[KDS-008] prints the queue in order when the printer is back, and says so', async () => {
    await kitchenPaper.start();
    expect(await queue.drain()).toEqual({ printed: 2, failed: 0 });
    expect(kitchenPaper.jobs.slice(1).map((job) => /! (\w+) order/.exec(job)?.[1])).toEqual([
      'Second',
      'Third',
    ]);
    expect((await printerRow('kitchenPrinter')).offlineSince).toBeNull();
    // Back online as soon as it took the first; the second was still waiting then.
    expect((await statusEvents()).at(-1)).toMatchObject({ online: true, error: null, queued: 1 });
  });

  it('[KDS-008] redirects a broken printer to another one chosen by a manager', async () => {
    await kitchenPaper.stop();
    const kot = await order('T1', 'Redirected order');
    expect(await queue.drain()).toEqual({ printed: 0, failed: 1 });

    const redirect = (from: string, to: string | null, login = manager) =>
      server()
        .post(`/api/v1/printers/${id(from)}/redirect`)
        .set(as(login))
        .send({ toPrinterId: to === null ? null : id(to), reason: 'Kitchen printer jammed' });

    expect((await redirect('kitchenPrinter', 'sparePrinter', cashier)).status).toBe(403);
    const self = await redirect('kitchenPrinter', 'kitchenPrinter');
    expect(self.status).toBe(422);
    expect(codeOf(self)).toBe('REDIRECT_TARGET_INVALID');

    const done = await redirect('kitchenPrinter', 'sparePrinter');
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(PrinterView.parse(done.body).redirectToId).toBe(id('sparePrinter'));
    // No chains: the spare cannot be sent back to a printer that is itself redirected.
    expect(codeOf(await redirect('sparePrinter', 'kitchenPrinter'))).toBe(
      'REDIRECT_TARGET_INVALID',
    );
    // Nor archived while tickets are sent to it.
    const archive = await server()
      .post(`/api/v1/printers/${id('sparePrinter')}/archive`)
      .set(as(manager))
      .send({ reason: 'Not needed' });
    expect(codeOf(archive)).toBe('PRINTER_IN_USE');

    expect(await queue.drain()).toEqual({ printed: 1, failed: 0 });
    expect(sparePaper.jobs).toHaveLength(1);
    expect(sparePaper.jobs[0]).toContain('! Redirected order');
    expect(await prisma.kot.findUniqueOrThrow({ where: { id: kot.id } })).toMatchObject({
      printStatus: 'PRINTED',
    });

    await kitchenPaper.start();
    expect((await redirect('kitchenPrinter', null)).status).toBe(200);
    const audits = await prisma.auditLog.findMany({
      where: { action: 'PRINTER_REDIRECTED' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((entry) => entry.after)).toEqual([
      { redirectToId: id('sparePrinter') },
      { redirectToId: null },
    ]);
    expect(audits[0]?.reason).toBe('Kitchen printer jammed');
  });

  it('[KDS-008] reprints a ticket on request, marked REPRINT and audited', async () => {
    const kot = await prisma.kot.findFirstOrThrow({
      where: { stationId: id('kitchen'), printStatus: 'PRINTED' },
      orderBy: { kotNumber: 'asc' },
    });
    const kitchen = await signIn(app, kit, 'KITCHEN');
    const byKitchen = await server()
      .post(`/api/v1/kots/${kot.id}/reprint`)
      .set(as(kitchen))
      .send({ reason: 'Ticket lost' });
    expect(byKitchen.status).toBe(403);

    const reprinted = await server()
      .post(`/api/v1/kots/${kot.id}/reprint`)
      .set(as(waiter))
      .send({ reason: 'Ticket lost' });
    expect(reprinted.status, JSON.stringify(reprinted.body)).toBe(200);
    expect(TestPrintResponse.parse(reprinted.body)).toEqual({ printed: true, error: null });
    expect(kitchenPaper.jobs.at(-1)).toContain('REPRINT');
    expect(kitchenPaper.jobs.at(-1)).toContain(`KOT ${String(kot.kotNumber)}`);

    const onSpare = await server()
      .post(`/api/v1/kots/${kot.id}/reprint`)
      .set(as(waiter))
      .send({ printerId: id('sparePrinter'), reason: 'Show the pass' });
    expect(TestPrintResponse.parse(onSpare.body).printed).toBe(true);
    expect(sparePaper.jobs.at(-1)).toContain('REPRINT');
    expect(
      await prisma.auditLog.count({ where: { action: 'KOT_REPRINTED', entityId: kot.id } }),
    ).toBe(2);

    // A screen-only station has no printer of its own: the person must choose one.
    const bar = await prisma.kot.findFirstOrThrow({ where: { stationId: id('bar') } });
    const noPrinter = await server()
      .post(`/api/v1/kots/${bar.id}/reprint`)
      .set(as(waiter))
      .send({ reason: 'Print the bar ticket' });
    expect(noPrinter.status).toBe(422);
    expect(codeOf(noPrinter)).toBe('NO_PRINTER');
  });

  it('[TBL-005] prints a "moved" note, not the tickets again, when the table moves', async () => {
    const before = kitchenPaper.jobs.length;
    const moved = await server()
      .post(`/api/v1/table-sessions/${sessions.T1?.id ?? ''}/move`)
      .set(as(waiter))
      .send({ toTableId: id('T3') });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);

    // The bar shows tickets on screen only, so only the kitchen gets a note.
    const notices = await prisma.printNotice.findMany();
    expect(notices.map((notice) => notice.stationId)).toEqual([id('kitchen')]);
    expect(await queue.drain()).toEqual({ printed: 1, failed: 0 });
    expect(kitchenPaper.jobs).toHaveLength(before + 1);
    const note = kitchenPaper.jobs.at(-1) ?? '';
    expect(note).toContain('MOVED');
    expect(note).toContain('From T1 to T3');
    expect(note).not.toContain('Paneer Tikka');
    expect(await prisma.printNotice.findFirstOrThrow()).toMatchObject({ printStatus: 'PRINTED' });
  });

  it('[ONB-004] a working test page brings an offline printer back online', async () => {
    await kitchenPaper.stop();
    await order('T2', 'Waiting order');
    expect(await queue.drain()).toEqual({ printed: 0, failed: 1 });
    expect((await printerRow('kitchenPrinter')).offlineSince).not.toBeNull();

    await kitchenPaper.start();
    const test = await server()
      .post(`/api/v1/printers/${id('kitchenPrinter')}/test`)
      .set(as(manager));
    expect(TestPrintResponse.parse(test.body).printed).toBe(true);
    expect((await printerRow('kitchenPrinter')).offlineSince).toBeNull();
    expect(await queue.drain()).toEqual({ printed: 1, failed: 0 });
    expect(kitchenPaper.jobs.at(-1)).toContain('! Waiting order');
  });
});
