import type { INestApplication } from '@nestjs/common';
import {
  type LoginResponse,
  MenuDraftResponse,
  MenuImportReport,
  MenuSnapshot,
  MenuTemplateResponse,
} from '@rp/contracts';
import { MENU_IMPORT_COLUMNS, toCsv } from '@rp/domain';
import readXlsxFile from 'read-excel-file/node';
import request from 'supertest';
import writeXlsxFile from 'write-excel-file/node';
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
let waiter: LoginResponse;

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp({ databaseUrl: database.url });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  waiter = await signIn(app, kit, 'WAITER');
  const base = { restaurantId: kit.restaurantId };
  await prisma.station.create({ data: { ...base, name: 'Tandoor' } });
  await prisma.station.create({ data: { ...base, name: 'Bar' } });
  await prisma.taxGroup.create({ data: { ...base, name: 'GST 5 %' } });
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);
const server = () => request(httpServer(app));
const header = (sheet: keyof typeof MENU_IMPORT_COLUMNS) =>
  MENU_IMPORT_COLUMNS[sheet].map((column) => column.name);
const itemRow = (cells: Record<string, string>) => header('Items').map((name) => cells[name] ?? '');

async function workbook(sheets: Record<string, string[][]>): Promise<string> {
  const buffer = await writeXlsxFile(
    Object.entries(sheets).map(([sheet, data]) => ({ sheet, data })),
  ).toBuffer();
  return buffer.toString('base64');
}

async function send(path: 'check' | '', file: object, login = manager) {
  return server()
    .post(`/api/v1/menu/import${path === '' ? '' : `/${path}`}`)
    .set(as(login))
    .send({ file });
}

describe('[ONB-005] the menu template', () => {
  it('gives managers the workbook with every sheet and column', async () => {
    const response = await server().get('/api/v1/menu/import/template').set(as(manager));
    expect(response.status).toBe(200);
    const template = MenuTemplateResponse.parse(response.body);
    const sheets = await readXlsxFile(Buffer.from(template.contentBase64, 'base64'));
    expect(sheets.map((sheet) => sheet.sheet)).toEqual([
      'Items',
      'Variants',
      'Modifiers',
      'Combos',
    ]);
    for (const sheet of sheets) {
      expect(sheet.data[0]).toEqual(header(sheet.sheet as keyof typeof MENU_IMPORT_COLUMNS));
    }
    // The empty template checks clean apart from having no items: the notes row is skipped.
    const report = MenuImportReport.parse(
      (await send('check', { format: 'XLSX', contentBase64: template.contentBase64 })).body,
    );
    expect(report.issues).toEqual([
      { sheet: 'Items', row: null, column: null, message: 'No items to import' },
    ]);
    expect((await server().get('/api/v1/menu/import/template').set(as(waiter))).status).toBe(403);
  });
});

describe('[ONB-005] [ONB-009] [MENU-011] importing a menu', () => {
  it('reports every error with sheet, row and column and writes nothing', async () => {
    const before = await prisma.item.count({ where: { restaurantId: kit.restaurantId } });
    const response = await send('', {
      format: 'XLSX',
      contentBase64: await workbook({
        Items: [
          header('Items'),
          itemRow({
            Category: 'Starters',
            Item: 'Tikka',
            Price: 'abc',
            'Tax group': 'GST 5 %',
            'Food type': 'Veg',
            Station: 'Tandoor',
          }),
          itemRow({
            Category: 'Starters',
            Item: 'Kebab',
            Price: '200',
            'Tax group': 'GST 12',
            'Food type': 'Veg',
            Station: 'Grill',
          }),
        ],
        Variants: [header('Variants'), ['Nothing', 'Half', '10', '']],
      }),
    });
    expect(response.status).toBe(200);
    const report = MenuImportReport.parse(response.body);
    expect(report).toMatchObject({ ok: false, committed: false, summary: null, menuVersion: null });
    expect(report.issues.map(({ sheet, row, column }) => [sheet, row, column])).toEqual([
      ['Items', 2, 'Price'],
      ['Items', 3, 'Tax group'],
      ['Items', 3, 'Station'],
      ['Variants', 2, 'Item'],
    ]);
    expect(await prisma.item.count({ where: { restaurantId: kit.restaurantId } })).toBe(before);
  });

  it('checks, then imports 150 items with variants, modifiers and a combo in one go and publishes', async () => {
    const rows: string[][] = [header('Items')];
    for (let index = 1; index <= 150; index += 1) {
      rows.push(
        itemRow({
          Category: index <= 100 ? 'Mains' : 'Drinks',
          'Sub-category': index <= 50 ? 'Curries' : '',
          Item: `Dish ${String(index)}`,
          'Short code': `D${String(index)}`,
          Price: `${String(100 + index)}.50`,
          'Tax group': 'GST 5 %',
          'Food type': index % 3 === 0 ? 'Non-veg' : 'Veg',
          Station: index <= 100 ? 'Tandoor' : 'Bar',
          Synonyms: `dish${String(index)}, plate ${String(index)}`,
          'Modifier groups': index <= 10 ? 'Roti type' : '',
        }),
      );
    }
    rows.push(
      itemRow({
        Category: 'Combos',
        Item: 'Lunch Combo',
        Price: '299',
        'Tax group': 'GST 5 %',
        'Food type': 'Veg',
        Station: 'Tandoor',
      }),
    );
    const file = {
      format: 'XLSX',
      contentBase64: await workbook({
        Items: rows,
        Variants: [header('Variants'), ['Dish 1', 'Half', '80', ''], ['Dish 1', 'Full', '150', '']],
        Modifiers: [
          header('Modifiers'),
          ['Roti type', '1', '1', 'Plain', ''],
          ['Roti type', '1', '1', 'Butter', '10'],
        ],
        Combos: [
          header('Combos'),
          ['Lunch Combo', 'Item', 'Dish 1', '', '', '', '', '', ''],
          ['Lunch Combo', 'Choice', 'Dish 101 | Dish 102', 'Any 1 drink', '', '', '', '', ''],
        ],
      }),
    };
    const checked = MenuImportReport.parse((await send('check', file)).body);
    expect(checked).toMatchObject({
      ok: true,
      committed: false,
      summary: { categories: 4, modifierGroups: 1, items: 151, variants: 2, combos: 1 },
    });
    expect(await prisma.item.count({ where: { restaurantId: kit.restaurantId } })).toBe(0);

    const refused = await send('', file, waiter);
    expect(refused.status).toBe(403);

    const started = performance.now();
    const response = await send('', file);
    const seconds = (performance.now() - started) / 1000;
    const report = MenuImportReport.parse(response.body);
    expect(report).toMatchObject({ ok: true, committed: true, menuVersion: 1 });
    // ONB-009: a 150-item menu imports in seconds, far inside the hour.
    expect(seconds).toBeLessThan(30);

    const draft = MenuDraftResponse.parse(
      (await server().get('/api/v1/menu/draft').set(as(manager))).body,
    );
    expect(draft.items).toHaveLength(151);
    const dish1 = draft.items.find((item) => item.name === 'Dish 1');
    expect(dish1).toMatchObject({
      shortCode: 'D1',
      basePrice: 10_150,
      synonyms: ['dish1', 'plate 1'],
      variants: [
        expect.objectContaining({ name: 'Half', price: 8_000 }),
        expect.objectContaining({ name: 'Full', price: 15_000 }),
      ],
    });
    expect(dish1?.modifierGroupIds).toHaveLength(1);
    const curries = draft.categories.find((category) => category.name === 'Curries');
    expect(draft.categories.find((category) => category.id === curries?.parentId)?.name).toBe(
      'Mains',
    );

    const menu = MenuSnapshot.parse((await server().get('/api/v1/menu').set(as(manager))).body);
    expect(menu.version).toBe(1);
    expect(menu.items.find((item) => item.name === 'Lunch Combo')).toBeDefined();
    const audit = await prisma.auditLog.findMany({
      where: {
        restaurantId: kit.restaurantId,
        action: { in: ['MENU_IMPORTED', 'MENU_PUBLISHED'] },
      },
      select: { action: true, after: true },
    });
    expect(audit.map((entry) => entry.action).sort()).toEqual(['MENU_IMPORTED', 'MENU_PUBLISHED']);
    expect(
      await prisma.auditLog.count({
        where: { restaurantId: kit.restaurantId, action: 'MENU_ITEM_CREATED' },
      }),
    ).toBe(151);

    // Importing the same file again: every item is already on the menu.
    const again = MenuImportReport.parse((await send('check', file)).body);
    expect(again.ok).toBe(false);
    expect(again.issues[0]).toMatchObject({ sheet: 'Items', row: 2, column: 'Item' });
  });

  it('imports CSV sheets too, reusing existing categories and groups by name', async () => {
    const file = {
      format: 'CSV',
      sheets: {
        Items: toCsv([
          header('Items'),
          itemRow({
            Category: 'Drinks',
            Item: 'Masala "Chai", hot',
            Price: '40',
            'Tax group': 'GST 5 %',
            'Food type': 'Veg',
            Station: 'Bar',
            'Modifier groups': 'roti type',
          }),
        ]),
      },
    };
    const report = MenuImportReport.parse((await send('', file)).body);
    expect(report).toMatchObject({
      ok: true,
      committed: true,
      summary: { categories: 0, modifierGroups: 0, items: 1 },
      menuVersion: 2,
    });
    const broken = MenuImportReport.parse(
      (await send('check', { format: 'CSV', sheets: { Items: '"unclosed' } })).body,
    );
    expect(broken.issues[0]?.message).toContain('not closed');
  });

  it('refuses a file that is not a workbook', async () => {
    const report = MenuImportReport.parse(
      (
        await send('check', {
          format: 'XLSX',
          contentBase64: Buffer.from('hello').toString('base64'),
        })
      ).body,
    );
    expect(report.issues[0]?.message).toContain('not an Excel workbook');
  });
});
