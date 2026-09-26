import type { INestApplication } from '@nestjs/common';
import {
  ApiError,
  CategoryView,
  ItemView,
  type LoginResponse,
  MenuDraftResponse,
  ModifierGroupView,
} from '@rp/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-database.js';

let database: TestDatabase;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let manager: LoginResponse;
let cashier: LoginResponse;
let stationId: string;
let taxGroupId: string;

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  cashier = await signIn(app, kit, 'CASHIER');
  const base = { restaurantId: kit.restaurantId };
  stationId = (await prisma.station.create({ data: { ...base, name: 'Kitchen' } })).id;
  taxGroupId = (await prisma.taxGroup.create({ data: { ...base, name: 'GST 5 %' } })).id;
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const codeOf = (response: request.Response) => ApiError.parse(response.body).code;
const server = () => request(httpServer(app));
const post = (path: string, body: object) =>
  server().post(`/api/v1/menu/${path}`).set(as(manager)).send(body);
const put = (path: string, body: object) =>
  server().put(`/api/v1/menu/${path}`).set(as(manager)).send(body);

let mains: CategoryView;
let curries: CategoryView;
let roti: ModifierGroupView;

function itemBody(overrides: Record<string, unknown> = {}) {
  return {
    categoryId: curries.id,
    name: 'Paneer Butter Masala',
    shortCode: 'PBM',
    description: 'Cottage cheese in a tomato and butter gravy',
    photoId: null,
    basePrice: 26_000,
    taxGroupId,
    foodType: 'VEG',
    spiceLevel: 1,
    tags: ['Bestseller', 'Jain option'],
    stationId,
    prepTimeMinutes: 15,
    displayOrder: 1,
    channels: ['POS', 'WAITER_APP', 'TABLE_TABLET', 'QR'],
    variants: [
      { name: 'Half', price: 16_000 },
      { name: 'Full', price: 26_000 },
    ],
    modifierGroupIds: [roti.id],
    synonyms: ['panir', 'cottage cheese'],
    repeatable: false,
    externalId: null,
    ...overrides,
  };
}

describe('[MENU-001] categories', () => {
  it('builds categories with one level of sub-categories, for managers only', async () => {
    expect(
      (
        await server()
          .post('/api/v1/menu/categories')
          .set(as(cashier))
          .send({ name: 'Mains', parentId: null, displayOrder: 1 })
      ).status,
    ).toBe(403);
    const top = await post('categories', { name: 'Mains', parentId: null, displayOrder: 1 });
    expect(top.status, JSON.stringify(top.body)).toBe(201);
    mains = CategoryView.parse(top.body);
    curries = CategoryView.parse(
      (await post('categories', { name: 'Curries', parentId: mains.id, displayOrder: 1 })).body,
    );
    const deeper = await post('categories', {
      name: 'Paneer',
      parentId: curries.id,
      displayOrder: 1,
    });
    expect([deeper.status, codeOf(deeper)]).toEqual([422, 'CATEGORY_PARENT_INVALID']);
    const clash = await post('categories', {
      name: 'curries',
      parentId: mains.id,
      displayOrder: 2,
    });
    expect([clash.status, codeOf(clash)]).toEqual([409, 'CATEGORY_NAME_TAKEN']);
    // The same name under another parent is fine.
    expect(
      (await post('categories', { name: 'Curries', parentId: null, displayOrder: 3 })).status,
    ).toBe(201);
  });
});

describe('[MENU-004] modifier groups', () => {
  it('creates a reusable group and keeps option ids when it changes', async () => {
    const created = await post('modifier-groups', {
      name: 'Roti type',
      minSelections: 0,
      maxSelections: 2,
      options: [
        { name: 'Tandoori', priceDelta: 0, available: true },
        { name: 'Butter', priceDelta: 1_000, available: true },
      ],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    roti = ModifierGroupView.parse(created.body);
    const [tandoori, butter] = roti.options;

    const changed = await put(`modifier-groups/${roti.id}`, {
      name: 'Roti type',
      minSelections: 1,
      maxSelections: 2,
      options: [
        { id: butter?.id, name: 'Butter roti', priceDelta: 1_500, available: true },
        { name: 'Missi', priceDelta: 500, available: false },
      ],
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const view = ModifierGroupView.parse(changed.body);
    // The dropped option is archived, not deleted; the kept one keeps its id.
    expect(view.options.map((option) => [option.name, option.archivedAt === null])).toEqual([
      ['Tandoori', false],
      ['Butter roti', true],
      ['Missi', true],
    ]);
    expect(view.options.find((option) => option.name === 'Butter roti')?.id).toBe(butter?.id);
    expect(tandoori).toBeDefined();
    expect(await prisma.auditLog.count({ where: { action: 'MODIFIER_GROUP_CHANGED' } })).toBe(1);

    const bad = await post('modifier-groups', {
      name: 'Bad',
      minSelections: 3,
      maxSelections: 2,
      options: [{ name: 'One', priceDelta: 0, available: true }],
    });
    expect([bad.status, codeOf(bad)]).toEqual([400, 'VALIDATION_FAILED']);
  });
});

describe('[MENU-002] [MENU-003] [MENU-011] items', () => {
  let item: ItemView;

  it('creates an item with every attribute, variants, tags and synonyms', async () => {
    const created = await post('items', itemBody());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    item = ItemView.parse(created.body);
    expect(item).toMatchObject({
      name: 'Paneer Butter Masala',
      shortCode: 'PBM',
      tags: ['Bestseller', 'Jain option'],
      synonyms: ['panir', 'cottage cheese'],
      modifierGroupIds: [roti.id],
      available: true,
      trackStock: false,
      archivedAt: null,
    });
    expect(item.variants.map((variant) => [variant.name, variant.price])).toEqual([
      ['Half', 16_000],
      ['Full', 26_000],
    ]);
    expect(await prisma.auditLog.count({ where: { action: 'MENU_ITEM_CREATED' } })).toBe(1);
  });

  it('refuses a duplicate short code and missing references', async () => {
    const clash = await post('items', itemBody({ name: 'Other', shortCode: 'pbm' }));
    expect([clash.status, codeOf(clash)]).toEqual([409, 'ITEM_SHORT_CODE_TAKEN']);
    const missing = await post(
      'items',
      itemBody({ shortCode: null, stationId: '01926a3e-0000-7000-8000-00000000000c' }),
    );
    expect([missing.status, codeOf(missing)]).toEqual([422, 'MENU_REFERENCE_NOT_FOUND']);
    const repeated = await post('items', itemBody({ shortCode: null, tags: ['Veg', 'veg'] }));
    expect([repeated.status, codeOf(repeated)]).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('[MENU-009] audits price changes on their own, and a plain repeat records nothing', async () => {
    const [half, full] = item.variants;
    const repriced = await put(
      `items/${item.id}`,
      itemBody({
        basePrice: 28_000,
        variants: [
          { id: half?.id, name: 'Half', price: 17_000 },
          { id: full?.id, name: 'Full', price: 28_000 },
        ],
        reason: 'New rate card',
      }),
    );
    expect(repriced.status, JSON.stringify(repriced.body)).toBe(200);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'ITEM_PRICE_CHANGED' },
    });
    expect(audit).toMatchObject({
      reason: 'New rate card',
      before: { basePrice: 26_000 },
      after: { basePrice: 28_000 },
    });

    const renamed = await put(
      `items/${item.id}`,
      itemBody({
        name: 'Paneer Makhani',
        basePrice: 28_000,
        variants: [
          { id: half?.id, name: 'Half', price: 17_000 },
          { id: full?.id, name: 'Full', price: 28_000 },
        ],
      }),
    );
    expect(renamed.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'MENU_ITEM_CHANGED' } })).toBe(1);
    const same = await put(
      `items/${item.id}`,
      itemBody({
        name: 'Paneer Makhani',
        basePrice: 28_000,
        variants: [
          { id: half?.id, name: 'Half', price: 17_000 },
          { id: full?.id, name: 'Full', price: 28_000 },
        ],
      }),
    );
    expect(same.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'MENU_ITEM_CHANGED' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'ITEM_PRICE_CHANGED' } })).toBe(1);
  });

  it('archives a dropped variant instead of deleting it, and refuses foreign variant ids', async () => {
    const [half] = item.variants;
    const updated = await put(
      `items/${item.id}`,
      itemBody({ basePrice: 28_000, variants: [{ id: half?.id, name: 'Half', price: 17_000 }] }),
    );
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const view = ItemView.parse(updated.body);
    expect(view.variants.map((variant) => [variant.name, variant.archivedAt === null])).toEqual([
      ['Half', true],
      ['Full', false],
    ]);
    expect(await prisma.variant.count({ where: { itemId: item.id } })).toBe(2);
    const foreign = await put(
      `items/${item.id}`,
      itemBody({ variants: [{ id: '01926a3e-0000-7000-8000-00000000000d', name: 'X', price: 1 }] }),
    );
    expect([foreign.status, codeOf(foreign)]).toEqual([422, 'VARIANT_NOT_FOUND']);
  });

  it('[MENU-010] archives items, groups and categories in use order, never deleting', async () => {
    const groupInUse = await post(`modifier-groups/${roti.id}/archive`, { reason: 'Not needed' });
    expect([groupInUse.status, codeOf(groupInUse)]).toEqual([409, 'MODIFIER_GROUP_IN_USE']);
    const categoryInUse = await post(`categories/${curries.id}/archive`, { reason: 'Menu change' });
    expect([categoryInUse.status, codeOf(categoryInUse)]).toEqual([409, 'CATEGORY_NOT_EMPTY']);

    const archived = await post(`items/${item.id}/archive`, { reason: 'Off the menu' });
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    expect(ItemView.parse(archived.body).archivedAt).not.toBeNull();
    const change = await put(`items/${item.id}`, itemBody());
    expect([change.status, codeOf(change)]).toEqual([409, 'ITEM_ARCHIVED']);
    // Its short code is free again for an active item.
    expect((await post('items', itemBody({ name: 'Paneer Tikka Masala' }))).status).toBe(201);

    const restored = await post(`items/${item.id}/restore`, {});
    expect([restored.status, codeOf(restored)]).toEqual([409, 'ITEM_SHORT_CODE_TAKEN']);
    expect(await prisma.item.count()).toBe(2);
  });

  it('lists the whole draft for the editor, for managers only', async () => {
    expect((await server().get('/api/v1/menu/draft').set(as(cashier))).status).toBe(403);
    const response = await server().get('/api/v1/menu/draft').set(as(manager));
    expect(response.status).toBe(200);
    const draft = MenuDraftResponse.parse(response.body);
    expect(draft.categories).toHaveLength(3);
    expect(draft.modifierGroups[0]?.itemCount).toBe(1);
    expect(draft.items.map((entry) => [entry.name, entry.archivedAt === null])).toEqual([
      ['Paneer Butter Masala', false],
      ['Paneer Tikka Masala', true],
    ]);
  });
});
