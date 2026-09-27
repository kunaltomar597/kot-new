import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  type DomainEvent,
  type LoginResponse,
  RecommendationRuleListResponse,
  RecommendationRuleView,
  RecommendationsResponse,
  SubmitOrderResponse,
  TableSessionView,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import type { OrderItemState } from '../../src/generated/prisma/enums.js';
import { RECOMMENDATION_CLOCK } from '../../src/recommendations/clock.js';
import { RecommendationOrders } from '../../src/recommendations/recommendation-orders.js';
import {
  addDevice,
  authHeaders,
  type AuthKit,
  createAuthKit,
  signIn,
} from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';
import { until } from '../helpers/wait.js';

/**
 * The recommendation engine v1 (P3-04) end to end: best sellers of the time of day from real order
 * lines, the rules an order triggers with their reasons, the filters (REC-005), the table tablet's
 * own table (AUTH-009), the rules API with its audit, and tracking through to ORDERED (REC-008).
 * The clock is years ahead, so orders this test sends through the API never count as best sellers.
 */

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let waiter: LoginResponse;
let manager: LoginResponse;
const ids: Record<string, string> = {};
const id = (name: string) => ids[name] ?? '';

/** 13:00 in Mumbai on 15 January 2030: lunch. */
const LUNCH = new Date('2030-01-15T07:30:00.000Z');
let now = LUNCH;
const clock = { now: () => now };
/** An instant in India Standard Time. */
const ist = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);

let orderNumber = 0;

/** Order lines sold at `at` (business date `date`), as the order engine would have written them. */
async function sold(
  name: string,
  quantity: number,
  date: string,
  time: string,
  options: { state?: OrderItemState; comboPartOf?: string } = {},
): Promise<void> {
  const base = { restaurantId: kit.restaurantId, businessDate: new Date(date) };
  const at = ist(date, time);
  orderNumber += 1;
  const order = await prisma.order.create({
    data: { ...base, orderNumber, orderType: 'TAKEAWAY', source: 'POS', createdAt: at },
  });
  const line = (itemName: string, count: number, parentOrderItemId: string | null = null) => ({
    ...base,
    orderId: order.id,
    itemId: id(itemName),
    name: itemName,
    quantity: count,
    unitPrice: 10_000,
    lineTotal: 10_000 * count,
    taxGroupId: id('gst'),
    taxRates: [],
    stationId: id('kitchen'),
    state: options.state ?? 'SERVED',
    parentOrderItemId,
    createdAt: at,
  });
  if (options.comboPartOf === undefined) {
    await prisma.orderItem.create({ data: line(name, quantity) });
    return;
  }
  const combo = await prisma.orderItem.create({ data: line(options.comboPartOf, 1) });
  await prisma.orderItem.create({ data: line(name, quantity, combo.id) });
}

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({
    databaseUrl: database.url,
    overrides: [{ provide: RECOMMENDATION_CLOCK, useValue: clock }],
  });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  waiter = await signIn(app, kit, 'WAITER');
  manager = await signIn(app, kit, 'MANAGER');
  const base = { restaurantId: kit.restaurantId };

  const category = async (name: string, parent?: string) => {
    ids[name] = (
      await prisma.category.create({
        data: { ...base, name, ...(parent !== undefined && { parentId: id(parent) }) },
      })
    ).id;
  };
  for (const name of ['Starters', 'Mains', 'Breads', 'Desserts', 'Beverages', 'Sides', 'Combos']) {
    await category(name);
  }
  await category('Biryani', 'Mains');
  await category('Old Specials');
  await prisma.category.update({
    where: { id: id('Old Specials') },
    data: { archivedAt: new Date() },
  });
  ids.kitchen = (
    await prisma.station.create({ data: { ...base, name: 'Kitchen', mode: 'BOTH' } })
  ).id;
  ids.gst = (await prisma.taxGroup.create({ data: { ...base, name: 'GST 5 %' } })).id;
  const item = async (name: string, categoryName: string, extra: object = {}) => {
    ids[name] = (
      await prisma.item.create({
        data: {
          ...base,
          categoryId: id(categoryName),
          name,
          basePrice: 20_000,
          taxGroupId: id('gst'),
          foodType: 'VEG',
          stationId: id('kitchen'),
          ...extra,
        },
      })
    ).id;
  };
  await item('Paneer Tikka', 'Starters');
  await item('Chicken 65', 'Starters', { foodType: 'NON_VEG' });
  await item('Veg Biryani', 'Biryani');
  await item('Chicken Biryani', 'Biryani', { foodType: 'NON_VEG' });
  await item('Dal Makhani', 'Mains');
  await item('Butter Naan', 'Breads', { repeatable: true });
  await item('Raita', 'Sides');
  await item('Gulab Jamun', 'Desserts');
  await item('Masala Chaas', 'Beverages', { repeatable: true });
  await item('POS Special', 'Mains', { channels: ['POS'] });
  await item('Breakfast Combo', 'Combos');
  await item('Retired Kebab', 'Starters', { archivedAt: new Date() });
  await prisma.combo.create({
    data: {
      ...base,
      itemId: id('Breakfast Combo'),
      windowStart: '07:00',
      windowEnd: '10:00',
      components: {
        create: [
          { ...base, kind: 'FIXED', itemId: id('Butter Naan'), quantity: 2, displayOrder: 1 },
          { ...base, kind: 'FIXED', itemId: id('Masala Chaas'), quantity: 1, displayOrder: 2 },
        ],
      },
    },
  });
  const published = await server().post('/api/v1/menu/publish').set(as(manager));
  expect(published.status, JSON.stringify(published.body)).toBe(200);

  // Lunch sales in the last 30 days.
  await sold('Chicken Biryani', 40, '2030-01-10', '13:00');
  await sold('Veg Biryani', 30, '2030-01-10', '13:15');
  await sold('Butter Naan', 25, '2030-01-10', '13:30');
  await sold('Paneer Tikka', 20, '2030-01-10', '12:30');
  await sold('Masala Chaas', 15, '2030-01-10', '14:00');
  await sold('Gulab Jamun', 10, '2030-01-10', '14:30');
  await sold('POS Special', 60, '2030-01-10', '12:00');
  // Not lunch best sellers: sold at dinner, at breakfast, too long ago, cancelled, or a combo's
  // part (the combo line itself counts once, at lunch; it is off then, 07:00 to 10:00 only).
  await sold('Dal Makhani', 100, '2030-01-10', '20:00');
  await sold('Breakfast Combo', 50, '2030-01-12', '08:00');
  await sold('Masala Chaas', 5, '2030-01-12', '08:15');
  await sold('Paneer Tikka', 500, '2029-12-01', '13:00');
  await sold('Gulab Jamun', 200, '2030-01-11', '13:00', { state: 'CANCELLED' });
  await sold('Butter Naan', 300, '2030-01-11', '13:00', { comboPartOf: 'Breakfast Combo' });

  const hall = await prisma.section.create({ data: { ...base, name: 'Hall' } });
  for (const label of ['T1', 'T2', 'T3', 'T4']) {
    ids[label] = (
      await prisma.diningTable.create({ data: { ...base, sectionId: hall.id, label } })
    ).id;
    ids[`tablet ${label}`] = await addDevice(app, kit, 'TABLE_TABLET', { tableId: id(label) });
  }
  ids.kds = await addDevice(app, kit, 'KDS', { stationId: id('kitchen') });
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

afterEach(() => {
  now = LUNCH;
});

const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const server = () => request(httpServer(app));
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;
const tablet = (label: string) => authHeaders(id(`tablet ${label}`));

/** The query string the api-client sends: repeated `cart`, flags as words. */
function query(values: Record<string, string | number | boolean | readonly string[]>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    for (const entry of Array.isArray(value) ? value : [value]) search.append(name, String(entry));
  }
  return search.toString();
}

async function suggest(
  values: Record<string, string | number | boolean | readonly string[]>,
): Promise<RecommendationsResponse> {
  const response = await server()
    .get(`/api/v1/recommendations?${query(values)}`)
    .set(as(waiter));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return RecommendationsResponse.parse(response.body);
}

async function suggestAt(
  label: string,
  values: Record<string, string | number | boolean | readonly string[]> = {},
): Promise<RecommendationsResponse> {
  const response = await server()
    .get(`/api/v1/devices/current/recommendations?${query(values)}`)
    .set(tablet(label));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return RecommendationsResponse.parse(response.body);
}

/** The suggested dishes by name, best first. */
const names = (response: RecommendationsResponse) =>
  response.recommendations.map(
    (suggestion) => Object.entries(ids).find(([, value]) => value === suggestion.itemId)?.[0],
  );

async function openTable(label: string): Promise<TableSessionView> {
  const response = await server()
    .post(`/api/v1/tables/${id(label)}/open`)
    .set(as(waiter))
    .send({ covers: 2, waiterId: kit.staff.WAITER });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return TableSessionView.parse(response.body);
}

async function order(tableSessionId: string, lines: object[], idempotencyKey = randomUUID()) {
  const response = await server()
    .post('/api/v1/orders')
    .set(as(waiter))
    .send({
      idempotencyKey,
      source: 'WAITER_APP',
      orderType: 'DINE_IN',
      tableSessionId,
      lines: lines.map((line) => ({ clientLineId: randomUUID(), quantity: 1, ...line })),
    });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return SubmitOrderResponse.parse(response.body);
}

const rule = (changes: object = {}) => ({
  when: { kind: 'ITEM', itemId: id('Chicken Biryani') },
  suggest: { kind: 'ITEM', itemId: id('Raita') },
  priority: 50,
  channels: ['WAITER_APP', 'TABLE_TABLET'],
  timeWindow: null,
  activeFrom: null,
  activeUntil: null,
  label: 'Cools the spice',
  active: true,
  ...changes,
});

async function createRule(body: object): Promise<RecommendationRuleView> {
  const response = await server().post('/api/v1/recommendation-rules').set(as(manager)).send(body);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return RecommendationRuleView.parse(response.body);
}

const auditOf = (ruleId: string) =>
  prisma.auditLog.findMany({ where: { entityId: ruleId }, orderBy: { chainSeq: 'asc' } });

describe('[REC-002] [AUD-001] recommendation rules', () => {
  it('lets a manager add rules, audited, listed highest priority first', async () => {
    const raita = await createRule(rule());
    ids['rule raita'] = raita.id;
    expect(raita).toMatchObject({
      when: { kind: 'ITEM', itemId: id('Chicken Biryani') },
      suggest: { kind: 'ITEM', itemId: id('Raita') },
      label: 'Cools the spice',
      active: true,
      archivedAt: null,
    });
    const breads = await createRule(
      rule({
        when: { kind: 'CATEGORY', categoryId: id('Mains') },
        suggest: { kind: 'CATEGORY', categoryId: id('Breads') },
        priority: 10,
        channels: ['POS', 'WAITER_APP', 'TABLE_TABLET', 'QR'],
        label: null,
      }),
    );
    ids['rule breads'] = breads.id;

    const listed = await server().get('/api/v1/recommendation-rules').set(as(manager));
    expect(listed.status).toBe(200);
    expect(
      RecommendationRuleListResponse.parse(listed.body).rules.map((entry) => entry.id),
    ).toEqual([raita.id, breads.id]);
    expect(await auditOf(raita.id)).toEqual([
      expect.objectContaining({
        action: 'RECOMMENDATION_RULE_CREATED',
        actorId: kit.staff.MANAGER,
        before: null,
        after: expect.objectContaining({ priority: 50, label: 'Cools the spice' }) as unknown,
      }),
    ]);
  });

  it('refuses items and categories that are not on the menu or archived', async () => {
    const unknown = randomUUID();
    const response = await server()
      .post('/api/v1/recommendation-rules')
      .set(as(manager))
      .send(
        rule({
          when: { kind: 'ITEM', itemId: id('Retired Kebab') },
          suggest: { kind: 'CATEGORY', categoryId: unknown },
        }),
      );
    expect(response.status).toBe(422);
    expect(ApiError.parse(response.body)).toMatchObject({
      code: 'RECOMMENDATION_TARGET_INVALID',
      details: { itemIds: [id('Retired Kebab')], categoryIds: [unknown] },
    });
    const archived = await server()
      .post('/api/v1/recommendation-rules')
      .set(as(manager))
      .send(rule({ suggest: { kind: 'CATEGORY', categoryId: id('Old Specials') } }));
    expect(codeOf(archived)).toBe('RECOMMENDATION_TARGET_INVALID');
    const invalid = await server()
      .post('/api/v1/recommendation-rules')
      .set(as(manager))
      .send(rule({ timeWindow: { start: '18:00', end: '18:00' } }));
    expect(invalid.status).toBe(400);
  });

  it('audits a change with before and after, and nothing when nothing changes', async () => {
    const put = (body: object) =>
      server()
        .put(`/api/v1/recommendation-rules/${id('rule breads')}`)
        .set(as(manager))
        .send(body);
    const breads = {
      ...rule({
        when: { kind: 'CATEGORY', categoryId: id('Mains') },
        suggest: { kind: 'CATEGORY', categoryId: id('Breads') },
        channels: ['POS', 'WAITER_APP', 'TABLE_TABLET', 'QR'],
        label: null,
      }),
    };
    expect((await put({ ...breads, priority: 10 })).status).toBe(200);
    expect(await auditOf(id('rule breads'))).toHaveLength(1);

    const changed = await put({ ...breads, priority: 20 });
    expect(changed.status).toBe(200);
    expect(RecommendationRuleView.parse(changed.body).priority).toBe(20);
    const [, change] = await auditOf(id('rule breads'));
    expect(change).toMatchObject({
      action: 'RECOMMENDATION_RULE_CHANGED',
      before: expect.objectContaining({ priority: 10 }) as unknown,
      after: expect.objectContaining({ priority: 20 }) as unknown,
    });
    expect(
      (
        await server()
          .put(`/api/v1/recommendation-rules/${randomUUID()}`)
          .set(as(manager))
          .send(breads)
      ).status,
    ).toBe(404);
  });

  it('archives a rule with the reason, never deleting it', async () => {
    const dessert = await createRule(
      rule({
        when: { kind: 'ITEM', itemId: id('Paneer Tikka') },
        suggest: { kind: 'ITEM', itemId: id('Gulab Jamun') },
        priority: 90,
        label: null,
      }),
    );
    const archive = () =>
      server()
        .post(`/api/v1/recommendation-rules/${dessert.id}/archive`)
        .set(as(manager))
        .send({ reason: 'Season over' });
    const first = await archive();
    expect(first.status).toBe(200);
    const archived = RecommendationRuleView.parse(first.body);
    expect(archived.archivedAt).not.toBeNull();
    // Again: nothing changes.
    expect(RecommendationRuleView.parse((await archive()).body).archivedAt).toBe(
      archived.archivedAt,
    );
    expect((await auditOf(dessert.id)).map((entry) => [entry.action, entry.reason])).toEqual([
      ['RECOMMENDATION_RULE_CREATED', null],
      ['RECOMMENDATION_RULE_ARCHIVED', 'Season over'],
    ]);
    const listed = RecommendationRuleListResponse.parse(
      (await server().get('/api/v1/recommendation-rules').set(as(manager))).body,
    );
    expect(listed.rules.map((entry) => entry.id)).not.toContain(dessert.id);
    expect(await prisma.recommendationRule.count({ where: { id: dessert.id } })).toBe(1);
    const changed = await server()
      .put(`/api/v1/recommendation-rules/${dessert.id}`)
      .set(as(manager))
      .send(rule());
    expect(codeOf(changed)).toBe('RECOMMENDATION_RULE_NOT_FOUND');
    // An archived rule suggests nothing: Paneer Tikka in the cart brings no Gulab Jamun rule.
    const suggestions = await suggest({ channel: 'WAITER_APP', cart: [id('Paneer Tikka')] });
    expect(suggestions.recommendations.some((entry) => entry.layer === 'RULE')).toBe(false);
  });

  it('lets only people who configure operations manage the rules', async () => {
    expect((await server().get('/api/v1/recommendation-rules').set(as(waiter))).status).toBe(403);
    expect(
      (await server().post('/api/v1/recommendation-rules').set(as(waiter)).send(rule())).status,
    ).toBe(403);
  });
});

describe('[REC-004] best sellers of the time of day', () => {
  it('suggests the lunch best sellers when nothing is ordered, the first course first', async () => {
    const suggestions = await suggest({ channel: 'WAITER_APP' });
    expect(suggestions.daypart).toBe('LUNCH');
    // Paneer Tikka is a starter, the course a table begins with; then by quantity sold.
    expect(names(suggestions)).toEqual([
      'Paneer Tikka',
      'Chicken Biryani',
      'Veg Biryani',
      'Butter Naan',
      'Masala Chaas',
      'Gulab Jamun',
    ]);
    expect(suggestions.recommendations[0]).toEqual({
      itemId: id('Paneer Tikka'),
      layer: 'BEST_SELLER',
      reason: { kind: 'BEST_SELLER', daypart: 'LUNCH' },
    });
  });

  it('[REC-005] suggests on each channel only what it offers, and only veg for a veg-only table', async () => {
    expect(names(await suggest({ channel: 'POS', limit: 3 }))).toEqual([
      'Paneer Tikka',
      'POS Special',
      'Chicken Biryani',
    ]);
    expect(names(await suggest({ channel: 'WAITER_APP', vegOnly: true }))).toEqual([
      'Paneer Tikka',
      'Veg Biryani',
      'Butter Naan',
      'Masala Chaas',
      'Gulab Jamun',
    ]);
  });

  it('counts breakfast at breakfast, and never suggests a combo outside its hours', async () => {
    now = ist('2030-01-15', '08:30');
    const breakfast = await suggest({ channel: 'WAITER_APP' });
    expect(breakfast.daypart).toBe('BREAKFAST');
    expect(names(breakfast)).toEqual(['Breakfast Combo', 'Masala Chaas']);
    // Still breakfast, but the combo is served 07:00 to 10:00 only.
    now = ist('2030-01-15', '10:30');
    expect(names(await suggest({ channel: 'WAITER_APP' }))).toEqual(['Masala Chaas']);
  });
});

describe('[REC-002] [REC-006] the rules a table’s order triggers', () => {
  let t1: TableSessionView;

  beforeAll(async () => {
    t1 = await openTable('T1');
    await order(t1.id, [{ itemId: id('Chicken Biryani') }]);
  });

  it('puts the rules first, by priority, each with its reason, then the next course', async () => {
    const suggestions = await suggest({ channel: 'WAITER_APP', tableSessionId: t1.id });
    expect(suggestions.recommendations.slice(0, 2)).toEqual([
      {
        itemId: id('Raita'),
        layer: 'RULE',
        reason: {
          kind: 'RULE',
          ruleId: id('rule raita'),
          label: 'Cools the spice',
          becauseOf: 'Chicken Biryani',
        },
      },
      {
        itemId: id('Butter Naan'),
        layer: 'RULE',
        // Biryani is a kind of main course.
        reason: { kind: 'RULE', ruleId: id('rule breads'), label: null, becauseOf: 'Mains' },
      },
    ]);
    // Mains were ordered: dessert and drinks come before another main or a starter; the biryani
    // ordered is not suggested again.
    expect(names(suggestions)).toEqual([
      'Raita',
      'Butter Naan',
      'Masala Chaas',
      'Gulab Jamun',
      'Veg Biryani',
      'Paneer Tikka',
    ]);
  });

  it('applies a rule only on its channels', async () => {
    expect(names(await suggest({ channel: 'POS', tableSessionId: t1.id }))).toEqual([
      'Butter Naan',
      'Masala Chaas',
      'Gulab Jamun',
      'POS Special',
      'Veg Biryani',
      'Paneer Tikka',
    ]);
  });

  it('applies a rule only in its hours and dates, and a paused rule not at all', async () => {
    const put = (changes: object) =>
      server()
        .put(`/api/v1/recommendation-rules/${id('rule raita')}`)
        .set(as(manager))
        .send(rule(changes));
    const first = async () =>
      names(await suggest({ channel: 'WAITER_APP', tableSessionId: t1.id }))[0];
    expect((await put({ timeWindow: { start: '18:00', end: '23:30' } })).status).toBe(200);
    expect(await first()).toBe('Butter Naan');
    now = ist('2030-01-15', '19:00');
    expect(await first()).toBe('Raita');
    now = LUNCH;
    expect((await put({ activeFrom: '2030-02-01' })).status).toBe(200);
    expect(await first()).toBe('Butter Naan');
    expect((await put({ active: false })).status).toBe(200);
    expect(await first()).toBe('Butter Naan');
    expect((await put({})).status).toBe(200);
    expect(await first()).toBe('Raita');
  });
});

describe('[REC-005] what is never suggested', () => {
  let t1: string;

  beforeAll(async () => {
    const sessions = await prisma.tableSession.findMany({ where: { tableId: id('T1') } });
    t1 = sessions[0]?.id ?? '';
  });

  it('leaves out what is in the cart already unless repeatable, and follows its course', async () => {
    // Dessert in the cart: drinks come next; more naan is fine (repeatable), more dessert not.
    expect(
      names(
        await suggest({
          channel: 'WAITER_APP',
          tableSessionId: t1,
          cart: [id('Gulab Jamun'), id('Butter Naan')],
        }),
      ),
    ).toEqual(['Raita', 'Butter Naan', 'Masala Chaas', 'Veg Biryani', 'Paneer Tikka']);
  });

  it('leaves out what is sold out, until it is back', async () => {
    const setRaita = (available: boolean) =>
      server()
        .put(`/api/v1/menu/items/${id('Raita')}/availability`)
        .set(as(manager))
        .send({ available, stockCount: null });
    expect((await setRaita(false)).status).toBe(200);
    expect(names(await suggest({ channel: 'WAITER_APP', tableSessionId: t1 }))[0]).toBe(
      'Butter Naan',
    );
    expect((await setRaita(true)).status).toBe(200);
    expect(names(await suggest({ channel: 'WAITER_APP', tableSessionId: t1 }))[0]).toBe('Raita');
  });

  it('[REC-007] takes only the table and its cart, nothing about a person', async () => {
    const response = await server()
      .get(`/api/v1/recommendations?${query({ channel: 'WAITER_APP', customerPhone: '98765' })}`)
      .set(as(waiter));
    expect(response.status).toBe(400);
  });
});

describe('[TAB-011] [AUTH-009] suggestions on the table tablet', () => {
  it('shows them once the table is open, for its own table only', async () => {
    const closed = await server().get('/api/v1/devices/current/recommendations').set(tablet('T2'));
    expect(codeOf(closed)).toBe('TABLE_NOT_OPEN');
    await openTable('T2');
    // The tablet's channel: nothing the POS only sells.
    expect(names(await suggestAt('T2'))).toEqual([
      'Paneer Tikka',
      'Chicken Biryani',
      'Veg Biryani',
      'Butter Naan',
      'Masala Chaas',
      'Gulab Jamun',
    ]);
    expect(names(await suggestAt('T2', { vegOnly: true, limit: 2 }))).toEqual([
      'Paneer Tikka',
      'Veg Biryani',
    ]);
    // The diner's cart triggers the tablet's rules; T1's order does not reach T2.
    expect(names(await suggestAt('T2', { cart: [id('Chicken Biryani')] })).slice(0, 2)).toEqual([
      'Raita',
      'Butter Naan',
    ]);
    const kds = await server()
      .get('/api/v1/devices/current/recommendations')
      .set(authHeaders(id('kds')));
    expect(codeOf(kds)).toBe('NOT_A_TABLE_TABLET');
  });

  it('tells staff when the table session is unknown or closed', async () => {
    const unknown = await server()
      .get(
        `/api/v1/recommendations?${query({ channel: 'WAITER_APP', tableSessionId: randomUUID() })}`,
      )
      .set(as(waiter));
    expect(codeOf(unknown)).toBe('TABLE_SESSION_NOT_FOUND');
    const t4 = await openTable('T4');
    const close = await server()
      .post(`/api/v1/table-sessions/${t4.id}/close-without-bill`)
      .set(as(manager))
      .send({ reason: 'Guests left' });
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    const closed = await server()
      .get(`/api/v1/recommendations?${query({ channel: 'WAITER_APP', tableSessionId: t4.id })}`)
      .set(as(waiter));
    expect(codeOf(closed)).toBe('TABLE_SESSION_CLOSED');
  });
});

describe('[REC-008] tracking per layer and item', () => {
  const event = (kind: string, itemName: string, layer: string, ruleId: string | null = null) => ({
    kind,
    itemId: id(itemName),
    layer,
    ruleId,
  });

  it('records what the tablet showed, what was opened and what went in the cart', async () => {
    const response = await server()
      .post('/api/v1/devices/current/recommendations/events')
      .set(tablet('T2'))
      .send({
        events: [
          event('IMPRESSION', 'Raita', 'RULE', id('rule raita')),
          event('IMPRESSION', 'Paneer Tikka', 'BEST_SELLER'),
          event('TAP', 'Raita', 'RULE', id('rule raita')),
          event('ADD_TO_CART', 'Raita', 'RULE', id('rule raita')),
        ],
      });
    expect(response.status, JSON.stringify(response.body)).toBe(204);
    const session = await prisma.tableSession.findFirstOrThrow({
      where: { tableId: id('T2'), status: 'OPEN' },
    });
    const rows = await prisma.recommendationEvent.findMany({
      where: { tableSessionId: session.id },
      orderBy: { id: 'asc' },
    });
    expect(rows.map((row) => [row.kind, row.layer, row.itemId, row.ruleId])).toEqual([
      ['IMPRESSION', 'RULE', id('Raita'), id('rule raita')],
      ['IMPRESSION', 'BEST_SELLER', id('Paneer Tikka'), null],
      ['TAP', 'RULE', id('Raita'), id('rule raita')],
      ['ADD_TO_CART', 'RULE', id('Raita'), id('rule raita')],
    ]);
    expect(rows[0]).toMatchObject({
      channel: 'TABLE_TABLET',
      deviceId: id('tablet T2'),
      staffId: null,
      businessDate: new Date('2030-01-15'),
    });
    // A tablet whose table is not open records nothing.
    const idle = await server()
      .post('/api/v1/devices/current/recommendations/events')
      .set(tablet('T3'))
      .send({ events: [event('IMPRESSION', 'Raita', 'BEST_SELLER')] });
    expect(codeOf(idle)).toBe('TABLE_NOT_OPEN');
  });

  it('records a waiter’s, and refuses items and rules this restaurant does not have', async () => {
    const t1 = await prisma.tableSession.findFirstOrThrow({
      where: { tableId: id('T1'), status: 'OPEN' },
    });
    const post = (body: object) =>
      server().post('/api/v1/recommendations/events').set(as(waiter)).send(body);
    const shown = await post({
      tableSessionId: t1.id,
      channel: 'WAITER_APP',
      events: [event('IMPRESSION', 'Masala Chaas', 'BEST_SELLER')],
    });
    expect(shown.status).toBe(204);
    expect(
      await prisma.recommendationEvent.findFirst({
        where: { tableSessionId: t1.id, itemId: id('Masala Chaas') },
      }),
    ).toMatchObject({ channel: 'WAITER_APP', staffId: kit.staff.WAITER, kind: 'IMPRESSION' });

    const stray = randomUUID();
    const unknown = await post({
      tableSessionId: t1.id,
      channel: 'WAITER_APP',
      events: [{ kind: 'TAP', itemId: stray, layer: 'RULE', ruleId: stray }],
    });
    expect(unknown.status).toBe(422);
    expect(ApiError.parse(unknown.body)).toMatchObject({
      code: 'RECOMMENDATION_UNKNOWN',
      details: { itemIds: [stray], ruleIds: [stray] },
    });
    const ordered = await post({
      tableSessionId: t1.id,
      channel: 'WAITER_APP',
      events: [event('ORDERED', 'Raita', 'BEST_SELLER')],
    });
    expect(ordered.status).toBe(400);
    const nowhere = await post({
      tableSessionId: randomUUID(),
      channel: 'WAITER_APP',
      events: [event('TAP', 'Raita', 'BEST_SELLER')],
    });
    expect(codeOf(nowhere)).toBe('TABLE_SESSION_NOT_FOUND');
  });

  it('counts a line ordered from a suggestion as ORDERED, once', async () => {
    const t1 = await prisma.tableSession.findFirstOrThrow({
      where: { tableId: id('T1'), status: 'OPEN' },
    });
    const key = randomUUID();
    const lines = [
      {
        clientLineId: randomUUID(),
        itemId: id('Raita'),
        recommendation: { layer: 'RULE', ruleId: id('rule raita') },
      },
      { clientLineId: randomUUID(), itemId: id('Masala Chaas') },
    ];
    const submitted = await order(t1.id, lines, key);
    if (submitted.status !== 'ACCEPTED') throw new Error('The order was not accepted');
    const raita = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: submitted.orderId, itemId: id('Raita') },
    });
    expect(raita).toMatchObject({
      recommendationLayer: 'RULE',
      recommendationRuleId: id('rule raita'),
    });
    const counted = await until(
      async () => {
        const rows = await prisma.recommendationEvent.findMany({ where: { kind: 'ORDERED' } });
        return rows.length > 0 && rows;
      },
      5_000,
      'the ORDERED event',
    );
    expect(counted).toEqual([
      expect.objectContaining({
        layer: 'RULE',
        itemId: id('Raita'),
        ruleId: id('rule raita'),
        orderItemId: raita.id,
        channel: 'WAITER_APP',
        tableSessionId: t1.id,
        staffId: kit.staff.WAITER,
      }),
    ]);

    // The same submission again is a replay, and the same event again counts nothing more.
    expect(await order(t1.id, lines, key)).toMatchObject({ status: 'ACCEPTED', replayed: true });
    const submittedEvent = {
      eventId: randomUUID(),
      version: 1,
      type: 'OrderSubmitted',
      occurredAt: new Date().toISOString(),
      restaurantId: kit.restaurantId,
      businessDate: '2030-01-15',
      payload: {
        orderId: submitted.orderId,
        orderNumber: submitted.orderNumber,
        source: 'WAITER_APP',
        tableSessionId: t1.id,
        needsApproval: false,
      },
    } as DomainEvent;
    await prisma.transaction((tx) => app.get(RecommendationOrders).handle(submittedEvent, tx));
    expect(await prisma.recommendationEvent.count({ where: { kind: 'ORDERED' } })).toBe(1);
  });
});
