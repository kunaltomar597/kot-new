import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  type LoginResponse,
  MenuSnapshot,
  type OrderLineRequest,
  SubmitOrderResponse,
  TableSessionView,
} from '@rp/contracts';
import { QrSubmitOrderResponse } from '@rp/contracts/relay';
import { unitPriceOf, type ItemSelection } from '@rp/domain';
import {
  addLine,
  type CartLine,
  comboOf,
  comboSlots,
  requestLines,
  selectable,
  summaryOf,
  unavailableReason,
} from '@rp/ordering';
import { startRelay, type TestRelay } from '@rp/relay/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SECRET_STORE, type SecretStore } from '../../src/auth/secret-store.js';
import { currentBusinessDate, dbDate } from '../../src/common/business-dates.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { KotTicketsService } from '../../src/printing/kot-tickets.service.js';
import { saveRelayCredential } from '../../src/relay/relay-credential.js';
import {
  DEFAULT_RELAY_ORDERS_OPTIONS,
  RELAY_ORDERS_OPTIONS,
  RelayOrdersService,
} from '../../src/relay/relay-orders.service.js';
import {
  DEFAULT_RELAY_SYNC_OPTIONS,
  RELAY_SYNC_OPTIONS,
  RelaySyncService,
} from '../../src/relay/relay-sync.service.js';
import {
  addDevice,
  authHeaders,
  type AuthKit,
  createAuthKit,
  signIn,
} from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

/**
 * Phase 6 exit (P6-01, MENU-004, MENU-005, MENU-012, ORD-007): the same combo and modifier order,
 * chosen with the shared ordering logic every surface uses (`@rp/ordering` cart lines, then
 * `requestLines`), placed at the POS, in the waiter app, on a table tablet and on the QR page (through
 * the relay). The server makes identical lines, prices and kitchen tickets from all four, and
 * refuses a combo outside its hours the same way everywhere, as the surfaces themselves show it.
 */

let database: TestDatabase;
let relay: TestRelay;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let waiter: LoginResponse;
let manager: LoginResponse;
let phoneWaiter: LoginResponse;
let menu: MenuSnapshot;
const ids: Record<string, string> = {};
const id = (name: string) => ids[name] ?? '';
const server = () => request(httpServer(app));
const as = (login: LoginResponse, deviceId = kit.deviceId) =>
  authHeaders(deviceId, login.accessToken);

type Surface = 'POS' | 'WAITER_APP' | 'TABLE_TABLET' | 'QR';
const SURFACES: readonly Surface[] = ['POS', 'WAITER_APP', 'TABLE_TABLET', 'QR'];
const TABLE_OF: Record<Surface, string> = {
  POS: 'T1',
  WAITER_APP: 'T2',
  TABLE_TABLET: 'T3',
  QR: 'T4',
};
const orderOf: Partial<Record<Surface, string>> = {};

/** An hour's window six hours from now, by the restaurant's clock: never open during the test. */
function closedWindow(): { start: string; end: string } {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date()),
  );
  const at = (offset: number) => `${String((hour + offset) % 24).padStart(2, '0')}:00`;
  return { start: at(6), end: at(7) };
}

/**
 * The cart a person builds on any surface: Paneer Tikka, Full, with extra cheese and butter, two
 * of them, less spicy; and a Thali with Chaas as its drink. Exactly as the item dialogs and sheets
 * do it: the shared selection, combo slots and price estimate.
 */
function theCart(): CartLine[] {
  const tikka = menu.items.find((item) => item.id === id('Paneer Tikka'));
  const thali = menu.items.find((item) => item.id === id('Thali'));
  if (tikka === undefined || thali === undefined) throw new Error('Menu not published');
  const def = selectable(menu, tikka);
  const selection: ItemSelection = {
    variantId: def.variants.find((variant) => variant.name === 'Full')?.id,
    modifiers: [{ groupId: id('extras'), optionIds: [id('cheese'), id('butter')] }],
  };
  const combo = comboOf(menu, thali);
  const slots = combo === undefined ? [] : comboSlots(menu, combo);
  const drinks = slots.map((slot) => slot.options.find((option) => option.name === 'Chaas')?.id);
  const comboChoices = drinks.flatMap((choice) => (choice === undefined ? [] : [choice]));
  let lines: CartLine[] = [];
  lines = addLine(
    lines,
    {
      itemId: tikka.id,
      name: tikka.name,
      summary: summaryOf(menu, tikka, selection, undefined),
      quantity: 2,
      selection,
      instructions: 'Less spicy',
      unitPrice: unitPriceOf(def, selection),
    },
    randomUUID,
  );
  lines = addLine(
    lines,
    {
      itemId: thali.id,
      name: thali.name,
      summary: summaryOf(menu, thali, {}, comboChoices),
      quantity: 1,
      selection: {},
      comboChoices,
      instructions: '',
      unitPrice: unitPriceOf(selectable(menu, thali), {}),
    },
    randomUUID,
  );
  return lines;
}

/** Places `lines` from `surface` at its table; resolves with what the server answered. */
async function place(surface: Surface, lines: OrderLineRequest[]): Promise<unknown> {
  const idempotencyKey = randomUUID();
  if (surface === 'POS' || surface === 'WAITER_APP') {
    const login = surface === 'POS' ? waiter : phoneWaiter;
    const device = surface === 'POS' ? kit.deviceId : id('phone');
    const response = await server()
      .post('/api/v1/orders')
      .set(as(login, device))
      .send({
        idempotencyKey,
        source: surface,
        orderType: 'DINE_IN',
        tableSessionId: id(`session-${TABLE_OF[surface]}`),
        lines,
      });
    return response.body;
  }
  if (surface === 'TABLE_TABLET') {
    const response = await server()
      .post('/api/v1/devices/current/orders')
      .set(authHeaders(id('tablet')))
      .send({ idempotencyKey, lines });
    return response.body;
  }
  const response = await fetch(`${relay.baseUrl}/submit-order`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-rp-table-token': id('qrToken'),
      'x-rp-browser': 'browser-T4-0000000000',
    },
    body: JSON.stringify({ idempotencyKey, lines }),
  });
  return response.json();
}

/** What the server made of an order: every line with its parts, money and words. */
async function linesOf(orderId: string) {
  const items = await prisma.orderItem.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
    include: { modifiers: { orderBy: { createdAt: 'asc' } } },
  });
  const shape = (item: (typeof items)[number]) => ({
    name: item.name,
    variantName: item.variantName,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    lineTotal: item.lineTotal,
    instructions: item.instructions,
    state: item.state,
    modifiers: item.modifiers.map((modifier) => ({
      name: modifier.name,
      priceDelta: modifier.priceDelta,
      quantity: modifier.quantity,
    })),
  });
  return items
    .filter((item) => item.parentOrderItemId === null)
    .map((item) => ({
      ...shape(item),
      parts: items.filter((part) => part.parentOrderItemId === item.id).map(shape),
    }));
}

/** The kitchen tickets as printed, without what differs by table, device and time. */
async function ticketsOf(orderId: string) {
  const kots = await prisma.kot.findMany({
    where: { orderId },
    include: { station: { select: { name: true } } },
  });
  const tickets = app.get(KotTicketsService);
  const rendered = await Promise.all(
    kots.map(async (kot) => (await tickets.render(kit.restaurantId, kot.id)).ticket),
  );
  return rendered
    .map((ticket) => ({ station: ticket.stationName, kind: ticket.kind, lines: ticket.lines }))
    .sort((a, b) => a.station.localeCompare(b.station));
}

beforeAll(async () => {
  database = await createTestDatabase();
  relay = await startRelay({ adminUrl: inject('pgAdminUrl'), runId: inject('pgRunId') });
  const tenant = await relay.provision('Spice Route');
  const later = { firstDelayMs: 3_600_000, retryBaseMs: 3_600_000, retryMaxMs: 3_600_000 };
  app = await createTestApp({
    databaseUrl: database.url,
    config: { relayUrl: relay.baseUrl },
    overrides: [
      {
        provide: RELAY_SYNC_OPTIONS,
        useValue: { ...DEFAULT_RELAY_SYNC_OPTIONS, ...later, debounceMs: 3_600_000 },
      },
      {
        provide: RELAY_ORDERS_OPTIONS,
        useValue: {
          ...DEFAULT_RELAY_ORDERS_OPTIONS,
          ...later,
          pollMs: 3_600_000,
          pushDebounceMs: 3_600_000,
          realtimeDelayMs: 3_600_000,
        },
      },
    ],
  });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  waiter = await signIn(app, kit, 'WAITER');
  manager = await signIn(app, kit, 'MANAGER');
  ids.phone = await addDevice(app, kit, 'WAITER_PHONE');
  phoneWaiter = await signIn(app, kit, 'WAITER', id('phone'));
  await saveRelayCredential(prisma, app.get<SecretStore>(SECRET_STORE), tenant.credential);

  const base = { restaurantId: kit.restaurantId };
  const kitchen = await prisma.station.create({ data: { ...base, name: 'Kitchen' } });
  const bar = await prisma.station.create({ data: { ...base, name: 'Bar' } });
  const gst = await prisma.taxGroup.create({
    data: {
      ...base,
      name: 'GST 5 %',
      sacCode: '996331',
      components: {
        create: [
          { ...base, code: 'CGST', rateBp: 250 },
          { ...base, code: 'SGST', rateBp: 250 },
        ],
      },
    },
  });
  const category = await prisma.category.create({ data: { ...base, name: 'Mains' } });
  for (const [name, price, station] of [
    ['Paneer Tikka', 28_000, kitchen.id],
    ['Dal Makhani', 24_000, kitchen.id],
    ['Roti', 3_000, kitchen.id],
    ['Lassi', 9_000, bar.id],
    ['Chaas', 6_000, bar.id],
    ['Thali', 34_900, kitchen.id],
    ['Lunch Thali', 29_900, kitchen.id],
  ] as const) {
    ids[name] = (
      await prisma.item.create({
        data: {
          ...base,
          categoryId: category.id,
          name,
          basePrice: price,
          taxGroupId: gst.id,
          foodType: 'VEG',
          stationId: station,
        },
      })
    ).id;
  }
  for (const [name, price, order] of [
    ['Half', 16_000, 1],
    ['Full', 28_000, 2],
  ] as const) {
    await prisma.variant.create({
      data: { ...base, itemId: id('Paneer Tikka'), name, price, displayOrder: order },
    });
  }
  const extras = await prisma.modifierGroup.create({
    data: {
      ...base,
      name: 'Extras',
      minSelections: 0,
      maxSelections: 2,
      options: {
        create: [
          { ...base, name: 'Extra cheese', priceDelta: 4_000, displayOrder: 1 },
          { ...base, name: 'Butter', priceDelta: 2_000, displayOrder: 2 },
        ],
      },
    },
    include: { options: true },
  });
  ids.extras = extras.id;
  ids.cheese = extras.options.find((option) => option.name === 'Extra cheese')?.id ?? '';
  ids.butter = extras.options.find((option) => option.name === 'Butter')?.id ?? '';
  await prisma.itemModifierGroup.create({
    data: { ...base, itemId: id('Paneer Tikka'), groupId: extras.id },
  });
  const window = closedWindow();
  for (const [name, hours] of [
    ['Thali', null],
    ['Lunch Thali', window],
  ] as const) {
    await prisma.combo.create({
      data: {
        ...base,
        itemId: id(name),
        ...(hours !== null && { windowStart: hours.start, windowEnd: hours.end }),
        components: {
          create: [
            { ...base, kind: 'FIXED', itemId: id('Dal Makhani'), quantity: 1, displayOrder: 1 },
            { ...base, kind: 'FIXED', itemId: id('Roti'), quantity: 2, displayOrder: 2 },
            {
              ...base,
              kind: 'CHOICE',
              label: 'Drink',
              quantity: 1,
              displayOrder: 3,
              choices: {
                create: [
                  { ...base, itemId: id('Lassi') },
                  { ...base, itemId: id('Chaas') },
                ],
              },
            },
          ],
        },
      },
    });
  }
  expect((await server().post('/api/v1/menu/publish').set(as(manager))).status).toBe(200);

  const hall = await prisma.section.create({ data: { ...base, name: 'Hall' } });
  const today = await currentBusinessDate(prisma, kit.restaurantId);
  await prisma.shiftAssignment.create({
    data: { ...base, staffId: kit.staff.WAITER, sectionId: hall.id, businessDate: dbDate(today) },
  });
  for (const label of ['T1', 'T2', 'T3', 'T4']) {
    ids[label] = (
      await prisma.diningTable.create({ data: { ...base, sectionId: hall.id, label } })
    ).id;
    const opened = await server()
      .post(`/api/v1/tables/${id(label)}/open`)
      .set(as(waiter))
      .send({ covers: 2 });
    ids[`session-${label}`] = TableSessionView.parse(opened.body).id;
  }
  ids.tablet = await addDevice(app, kit, 'TABLE_TABLET', { tableId: id('T3') });
  expect((await server().post('/api/v1/tables/qr-codes').set(as(manager))).status).toBe(200);
  ids.qrToken =
    (await prisma.diningTable.findUniqueOrThrow({ where: { id: id('T4') } })).qrToken ?? '';
  expect((await app.get(RelaySyncService).sync()).lastError).toBeNull();

  // The menu every device reads (GET /menu), with the restaurant's clock.
  menu = MenuSnapshot.parse(
    (
      await server()
        .get('/api/v1/menu')
        .set(authHeaders(id('tablet')))
    ).body,
  );
});

afterAll(async () => {
  await app.close();
  await relay.stop();
  await database.drop();
});

describe('[MENU-004] [MENU-005] [MENU-012] the same order on every surface', () => {
  it('is accepted from the POS, the waiter app, the table tablet and the QR page', async () => {
    expect(menu.timeZone).toBe('Asia/Kolkata');
    for (const surface of SURFACES) {
      const answer = await place(surface, requestLines(theCart()));
      if (surface === 'QR') {
        const accepted = QrSubmitOrderResponse.parse(answer);
        if (accepted.status !== 'ACCEPTED') throw new Error(JSON.stringify(accepted));
        await app.get(RelayOrdersService).run();
        const local = await prisma.order.findFirstOrThrow({
          where: { source: 'QR', externalRef: accepted.order.id },
        });
        orderOf.QR = local.id;
      } else {
        const accepted = SubmitOrderResponse.parse(answer);
        if (accepted.status !== 'ACCEPTED') throw new Error(JSON.stringify(accepted));
        orderOf[surface] = accepted.orderId;
      }
    }
    // Diners' orders wait for the waiter (ORD-003); approving sends them to the kitchen.
    for (const surface of ['TABLE_TABLET', 'QR'] as const) {
      const approved = await server()
        .post(`/api/v1/orders/${orderOf[surface] ?? ''}/approve`)
        .set(as(waiter))
        .send({});
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    }
  });

  it('[ORD-014] makes identical lines and prices, matching what every surface estimated', async () => {
    const made = await Promise.all(SURFACES.map((surface) => linesOf(orderOf[surface] ?? '')));
    for (const lines of made.slice(1)) expect(lines).toEqual(made[0]);
    expect(made[0]).toEqual([
      {
        name: 'Paneer Tikka',
        variantName: 'Full',
        quantity: 2,
        unitPrice: 34_000,
        lineTotal: 68_000,
        instructions: 'Less spicy',
        state: 'SENT',
        modifiers: [
          { name: 'Extra cheese', priceDelta: 4_000, quantity: 1 },
          { name: 'Butter', priceDelta: 2_000, quantity: 1 },
        ],
        parts: [],
      },
      expect.objectContaining({
        name: 'Thali',
        quantity: 1,
        unitPrice: 34_900,
        lineTotal: 34_900,
        parts: [
          expect.objectContaining({ name: 'Dal Makhani', quantity: 1, state: 'SENT' }),
          expect.objectContaining({ name: 'Roti', quantity: 2, state: 'SENT' }),
          expect.objectContaining({ name: 'Chaas', quantity: 1, state: 'SENT' }),
        ],
      }),
    ]);
    // The estimate the surfaces showed is what the server charged.
    expect(theCart().map((line) => line.unitPrice)).toEqual([34_000, 34_900]);
  });

  it('[ORD-007] prints the same kitchen tickets, the combo’s parts at their own stations', async () => {
    const printed = await Promise.all(SURFACES.map((surface) => ticketsOf(orderOf[surface] ?? '')));
    for (const tickets of printed.slice(1)) expect(tickets).toEqual(printed[0]);
    expect(printed[0]).toEqual([
      {
        station: 'Bar',
        kind: 'NEW',
        lines: [
          {
            quantity: 1,
            name: 'Chaas',
            variantName: null,
            modifiers: [],
            instructions: null,
            comboName: 'Thali',
          },
        ],
      },
      {
        station: 'Kitchen',
        kind: 'NEW',
        lines: [
          {
            quantity: 2,
            name: 'Paneer Tikka',
            variantName: 'Full',
            modifiers: [
              { name: 'Extra cheese', quantity: 1 },
              { name: 'Butter', quantity: 1 },
            ],
            instructions: 'Less spicy',
            comboName: null,
          },
          expect.objectContaining({ quantity: 1, name: 'Dal Makhani', comboName: 'Thali' }),
          expect.objectContaining({ quantity: 2, name: 'Roti', comboName: 'Thali' }),
        ],
      },
    ]);
  });

  it('[MENU-005] shows a combo outside its hours as unavailable, and every surface is refused', async () => {
    const lunch = menu.items.find((item) => item.id === id('Lunch Thali'));
    if (lunch === undefined) throw new Error('No Lunch Thali');
    expect(unavailableReason(lunch, { menu, now: Date.now() })).toBe('NOT_NOW');
    const combo = comboOf(menu, lunch);
    const drink = combo === undefined ? undefined : comboSlots(menu, combo)[0]?.options[0]?.id;
    const line = (): OrderLineRequest[] => [
      {
        clientLineId: randomUUID(),
        itemId: lunch.id,
        quantity: 1,
        modifiers: [],
        comboChoices: drink === undefined ? [] : [drink],
      },
    ];
    const refusals = [];
    for (const surface of SURFACES) {
      const answer = await place(surface, line());
      const parsed =
        surface === 'QR' ? QrSubmitOrderResponse.parse(answer) : SubmitOrderResponse.parse(answer);
      // Nothing was made (the staff route says PARTIALLY_REJECTED with every line refused).
      if (!('rejectedLines' in parsed)) throw new Error(`${surface}: ${JSON.stringify(parsed)}`);
      refusals.push(parsed.rejectedLines.map(({ code, message }) => ({ code, message })));
    }
    for (const refusal of refusals.slice(1)) expect(refusal).toEqual(refusals[0]);
    expect(refusals[0]).toEqual([
      { code: 'NOT_AVAILABLE_NOW', message: 'Lunch Thali is not offered at this time.' },
    ]);
  });
});
