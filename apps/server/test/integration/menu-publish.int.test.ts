import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  ComboView,
  ItemAvailabilityView,
  type LoginResponse,
  MenuPublishResponse,
  MenuSnapshot,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { MenuPublishService } from '../../src/menu/menu-publish.service.js';
import { SettingsService } from '../../src/settings/settings.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let manager: LoginResponse;
let kitchen: LoginResponse;
let waiter: LoginResponse;
const items: Record<string, string> = {};

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  kitchen = await signIn(app, kit, 'KITCHEN');
  waiter = await signIn(app, kit, 'WAITER');
  const base = { restaurantId: kit.restaurantId };
  const category = await prisma.category.create({ data: { ...base, name: 'Meals' } });
  const station = await prisma.station.create({ data: { ...base, name: 'Kitchen' } });
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
  for (const [name, price] of [
    ['Veg Thali', 34_900],
    ['Dal', 18_000],
    ['Roti', 3_000],
    ['Lassi', 9_000],
    ['Chaas', 6_000],
  ] as const) {
    items[name] = (
      await prisma.item.create({
        data: {
          ...base,
          categoryId: category.id,
          name,
          basePrice: price,
          taxGroupId: taxGroup.id,
          foodType: 'VEG',
          stationId: station.id,
        },
      })
    ).id;
  }
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;
const server = () => request(httpServer(app));
const id = (name: string) => items[name] ?? '';

const thali = () => ({
  components: [
    { kind: 'FIXED', itemId: id('Dal'), quantity: 1 },
    { kind: 'FIXED', itemId: id('Roti'), quantity: 3 },
    { kind: 'CHOICE', label: 'Any 1 drink', itemIds: [id('Lassi'), id('Chaas')], quantity: 1 },
  ],
  activeFrom: '2026-10-01',
  activeUntil: '2026-10-31',
  timeWindow: { start: '11:00', end: '16:00' },
});

describe('[MENU-005] combos', () => {
  it('makes an item a bundle of fixed items and choice slots, audited', async () => {
    const byWaiter = await server()
      .put(`/api/v1/menu/items/${id('Veg Thali')}/combo`)
      .set(as(waiter))
      .send(thali());
    expect(byWaiter.status).toBe(403);
    const response = await server()
      .put(`/api/v1/menu/items/${id('Veg Thali')}/combo`)
      .set(as(manager))
      .send(thali());
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(ComboView.parse(response.body)).toMatchObject({
      components: [
        { kind: 'FIXED', itemId: id('Dal'), quantity: 1 },
        { kind: 'FIXED', itemId: id('Roti'), quantity: 3 },
        { kind: 'CHOICE', label: 'Any 1 drink', itemIds: [id('Lassi'), id('Chaas')] },
      ],
      activeFrom: '2026-10-01',
      timeWindow: { start: '11:00', end: '16:00' },
    });
    expect(await prisma.auditLog.count({ where: { action: 'COMBO_CHANGED' } })).toBe(1);
  });

  it('refuses combos inside combos, itself, and a combo part becoming a combo', async () => {
    const nested = await server()
      .put(`/api/v1/menu/items/${id('Lassi')}/combo`)
      .set(as(manager))
      .send({ ...thali(), components: [{ kind: 'FIXED', itemId: id('Veg Thali'), quantity: 1 }] });
    expect([nested.status, codeOf(nested)]).toEqual([422, 'COMBO_COMPONENT_INVALID']);
    const part = await server()
      .put(`/api/v1/menu/items/${id('Dal')}/combo`)
      .set(as(manager))
      .send({ ...thali(), components: [{ kind: 'FIXED', itemId: id('Lassi'), quantity: 1 }] });
    expect([part.status, codeOf(part)]).toEqual([422, 'COMBO_COMPONENT_INVALID']);
    const backwards = await server()
      .put(`/api/v1/menu/items/${id('Veg Thali')}/combo`)
      .set(as(manager))
      .send({ ...thali(), activeFrom: '2026-11-01' });
    expect(backwards.status).toBe(400);
  });
});

describe('[MENU-013] [MENU-012] publishing', () => {
  let first: MenuPublishResponse;

  it('has no menu for devices until one is published', async () => {
    const response = await server().get('/api/v1/menu').set(authHeaders(kit.deviceId));
    expect([response.status, codeOf(response)]).toEqual([404, 'MENU_NOT_PUBLISHED']);
  });

  it('publishes the draft as a version every device reads, and announces it', async () => {
    const response = await server().post('/api/v1/menu/publish').set(as(manager));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    first = MenuPublishResponse.parse(response.body);
    expect(first).toMatchObject({ version: 1, published: true });

    const menu = MenuSnapshot.parse(
      (await server().get('/api/v1/menu').set(authHeaders(kit.deviceId))).body,
    );
    expect(menu.version).toBe(1);
    expect(menu.items).toHaveLength(5);
    expect(menu.combos[0]).toMatchObject({
      itemId: id('Veg Thali'),
      timeWindow: { start: '11:00' },
    });
    expect(menu.taxGroups[0]?.components).toHaveLength(2);
    expect(await prisma.outboxEvent.count({ where: { eventType: 'MenuPublished' } })).toBe(1);
  });

  it('does not publish an unchanged draft again, and leaves archived items out of the next', async () => {
    const again = MenuPublishResponse.parse(
      (await server().post('/api/v1/menu/publish').set(as(manager))).body,
    );
    expect(again).toMatchObject({ version: 1, published: false, checksum: first.checksum });

    await prisma.item.update({ where: { id: id('Chaas') }, data: { archivedAt: new Date() } });
    const second = MenuPublishResponse.parse(
      (await server().post('/api/v1/menu/publish').set(as(manager))).body,
    );
    expect(second).toMatchObject({ version: 2, published: true });
    const menu = MenuSnapshot.parse(
      (await server().get('/api/v1/menu').set(authHeaders(kit.deviceId))).body,
    );
    expect(menu.items.map((item) => item.name)).not.toContain('Chaas');
    await prisma.item.update({ where: { id: id('Chaas') }, data: { archivedAt: null } });
  });
});

describe('[MENU-006] availability and stock', () => {
  const setAvailability = (login: LoginResponse, name: string, body: object) =>
    server()
      .put(`/api/v1/menu/items/${id(name)}/availability`)
      .set(as(login))
      .send(body);

  it('lets the kitchen mark an item out of stock at once, announced to every device', async () => {
    const response = await setAvailability(kitchen, 'Lassi', {
      available: false,
      stockCount: null,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(ItemAvailabilityView.parse(response.body)).toEqual({
      itemId: id('Lassi'),
      available: false,
      stockCount: null,
    });
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: 'ItemAvailabilityChanged' },
    });
    expect(event.payload).toMatchObject({ payload: { itemId: id('Lassi'), available: false } });
    // Live: the published menu shows it without publishing again.
    const menu = MenuSnapshot.parse(
      (await server().get('/api/v1/menu').set(authHeaders(kit.deviceId))).body,
    );
    expect(menu.items.find((item) => item.id === id('Lassi'))?.available).toBe(false);
    expect(
      (await setAvailability(waiter, 'Lassi', { available: true, stockCount: null })).status,
    ).toBe(403);
  });

  it('[OI-11] refuses the kitchen when the restaurant turns that off', async () => {
    await prisma.setting.create({
      data: { restaurantId: kit.restaurantId, key: 'stock.kitchenMayManage', value: false },
    });
    app.get(SettingsService).invalidate();
    const refused = await setAvailability(kitchen, 'Lassi', { available: true, stockCount: null });
    expect([refused.status, codeOf(refused)]).toEqual([403, 'FORBIDDEN']);
    expect(
      (await setAvailability(manager, 'Lassi', { available: true, stockCount: null })).status,
    ).toBe(200);
  });

  it('counts stock down with orders and switches the item off at zero', async () => {
    const counted = await setAvailability(manager, 'Dal', { available: true, stockCount: 3 });
    expect(ItemAvailabilityView.parse(counted.body)).toMatchObject({
      available: true,
      stockCount: 3,
    });

    const service = app.get(MenuPublishService);
    const afterTwo = await prisma.$transaction((tx) =>
      service.decrementStock(tx, kit.restaurantId, id('Dal'), 2),
    );
    expect(afterTwo).toMatchObject({ available: true, stockCount: 1 });
    const empty = await prisma.$transaction((tx) =>
      service.decrementStock(tx, kit.restaurantId, id('Dal'), 1),
    );
    expect(empty).toMatchObject({ available: false, stockCount: 0 });
    expect(
      await prisma.$transaction((tx) =>
        service.decrementStock(tx, kit.restaurantId, id('Roti'), 1),
      ),
    ).toBeNull();

    const menu = MenuSnapshot.parse(
      (await server().get('/api/v1/menu').set(authHeaders(kit.deviceId))).body,
    );
    expect(menu.items.find((item) => item.id === id('Dal'))).toMatchObject({
      available: false,
      stockCount: 0,
    });
    // Setting a count of 0 by hand also makes it unavailable; null stops counting.
    const zero = await setAvailability(manager, 'Roti', { available: true, stockCount: 0 });
    expect(ItemAvailabilityView.parse(zero.body).available).toBe(false);
    const stop = await setAvailability(manager, 'Dal', { available: true, stockCount: null });
    expect(ItemAvailabilityView.parse(stop.body)).toMatchObject({
      available: true,
      stockCount: null,
    });
    expect(
      await prisma.auditLog.count({ where: { action: 'ITEM_AVAILABILITY_CHANGED' } }),
    ).toBeGreaterThanOrEqual(4);
  });
});
