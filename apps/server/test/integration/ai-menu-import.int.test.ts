import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import {
  AiMenuImportView,
  ApiError,
  type LoginResponse,
  MenuImportReport,
  type MenuReviewRequest,
} from '@rp/contracts';
import {
  AdminService,
  CONTROL_PLANE_MIGRATIONS_DIR,
  CpConfigSchema,
  createControlPlaneApp,
} from '@rp/control-plane/testing';
import { createMigratedDatabase, type TestDatabase } from '@rp/test-postgres';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SECRET_STORE, type SecretStore } from '../../src/auth/secret-store.js';
import { enrolInstallation } from '../../src/cloud/enrolment.js';
import {
  CONTROL_PLANE_OPTIONS,
  DEFAULT_CONTROL_PLANE_OPTIONS,
} from '../../src/cloud/heartbeat.service.js';
import { APP_CONFIG, type AppConfig } from '../../src/config/app-config.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { authHeaders, type AuthKit, createAuthKit, signIn } from '../helpers/auth-kit.js';
import { createTestApp, httpServer } from '../helpers/test-app.js';
import { createTestDatabase, testAdminUrl } from '../helpers/test-database.js';
import { until } from '../helpers/wait.js';

/**
 * P6-04 acceptance (ONB-006, VCP-008, SEC-002): a manager's photos of the printed menu go from the
 * restaurant's server, made smaller, to a real Vendor Control Plane, whose worker has the AI
 * provider read them (here a stand-in on HTTP that answers with a fixture menu: CI never calls the
 * real one) and returns a draft. Nothing is imported until every dish is checked; then the draft
 * goes through the template import and is published.
 */

const AI_KEY = 'test-only-ai-key';

/** What the stand-in provider "reads" on the menu, as the record_menu tool's input. */
const READING = {
  found_menu: true,
  sections: [
    {
      name: 'Starters',
      dishes: [
        {
          name: 'Paneer Tikka',
          description: 'Char-grilled cottage cheese',
          price: '280',
          sizes: [],
          food_type: 'veg',
          spice_level: 2,
          tags: ['Chef special'],
          unsure: null,
        },
        {
          name: 'Chicken 65',
          description: null,
          price: null,
          sizes: [
            { name: 'Half', price: '220' },
            { name: 'Full', price: '399.50' },
          ],
          food_type: 'non_veg',
          spice_level: null,
          tags: [],
          unsure: 'Full price smudged',
        },
      ],
    },
    {
      name: 'Drinks',
      dishes: [
        { name: 'Sweet Lassi', price: '90', sizes: [], food_type: null, tags: [], unsure: null },
      ],
    },
  ],
  add_ons: [{ group: 'Extras', options: [{ name: 'Extra cheese', price: '40' }] }],
  notes: [],
};

let serverDatabase: TestDatabase;
let cpDatabase: TestDatabase;
let controlPlane: INestApplication;
let provider: Server;
let app: INestApplication;
let prisma: PrismaService;
let kit: AuthKit;
let manager: LoginResponse;
let waiter: LoginResponse;
const received: { key: string | undefined; body: Record<string, unknown> }[] = [];
const ids: Record<string, string> = {};
const id = (name: string) => ids[name] ?? '';
const server = () => request(httpServer(app));
const as = (login: LoginResponse) => authHeaders(kit.deviceId, login.accessToken);

function readBody(incoming: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    incoming.on('error', reject);
  });
}

/** The AI provider's Messages API, answering every request with the fixture reading. */
async function startProvider(): Promise<Server> {
  const http = createServer((incoming, outgoing) => {
    void readBody(incoming).then((text) => {
      received.push({
        key: incoming.headers['x-api-key'] as string | undefined,
        body: JSON.parse(text) as Record<string, unknown>,
      });
      outgoing.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          model: 'stand-in',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'record_menu', input: READING }],
          usage: { input_tokens: 2_400, output_tokens: 700 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return http;
}

const portOf = (listening: Server) => {
  const address = listening.address();
  if (address === null || typeof address === 'string') throw new Error('Not listening');
  return address.port;
};

async function readImport(importId: string): Promise<AiMenuImportView> {
  const response = await server().get(`/api/v1/menu/ai-imports/${importId}`).set(as(manager));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return AiMenuImportView.parse(response.body);
}

/** The draft as the review screen sends it: defaults chosen, every dish checked unless said. */
function reviewOf(view: AiMenuImportView, checked = true): MenuReviewRequest {
  const draft = view.draft;
  if (draft === null) throw new Error('No draft');
  return {
    categories: draft.categories.map((category) => ({
      name: category.name,
      items: category.items.map((item) => ({
        name: item.name,
        description: item.description,
        price: item.price,
        variants: item.variants,
        foodType: item.foodType ?? 'VEG',
        spiceLevel: item.spiceLevel ?? 0,
        tags: item.tags,
        taxGroupId: id('gst'),
        stationId: category.name === 'Drinks' ? id('bar') : id('kitchen'),
        checked,
      })),
    })),
    addOns: draft.addOns.map((addOn) => ({
      group: addOn.group,
      minSelections: 0,
      maxSelections: addOn.options.length,
      options: addOn.options.map((option) => ({ name: option.name, priceDelta: option.price })),
    })),
  };
}

beforeAll(async () => {
  serverDatabase = await createTestDatabase();
  cpDatabase = await createMigratedDatabase({
    adminUrl: testAdminUrl(),
    runId: inject('pgRunId'),
    prefix: 'rp',
    migrationsDir: CONTROL_PLANE_MIGRATIONS_DIR,
  });
  provider = await startProvider();
  controlPlane = await createControlPlaneApp(
    CpConfigSchema.parse({
      databaseUrl: cpDatabase.url,
      logLevel: 'silent',
      aiApiKey: AI_KEY,
      aiBaseUrl: `http://127.0.0.1:${String(portOf(provider))}`,
    }),
  );
  await controlPlane.listen(0, '127.0.0.1');
  const admin = controlPlane.get(AdminService);
  const tenant = await admin.createTenant('Spice Route', 'ci:test');
  const issued = await admin.createInstallation(
    { tenantId: tenant.id, name: 'Counter PC' },
    'ci:test',
  );

  app = await createTestApp({
    databaseUrl: serverDatabase.url,
    config: {
      controlPlaneUrl: `http://127.0.0.1:${String(portOf(controlPlane.getHttpServer() as Server))}`,
    },
    overrides: [
      {
        provide: CONTROL_PLANE_OPTIONS,
        useValue: { ...DEFAULT_CONTROL_PLANE_OPTIONS, firstHeartbeatDelayMs: 3_600_000 },
      },
    ],
  });
  prisma = app.get(PrismaService);
  kit = await createAuthKit(app);
  manager = await signIn(app, kit, 'MANAGER');
  waiter = await signIn(app, kit, 'WAITER');
  await enrolInstallation({
    config: app.get<AppConfig>(APP_CONFIG),
    prisma,
    secrets: app.get<SecretStore>(SECRET_STORE),
    code: issued.code,
  });
  const base = { restaurantId: kit.restaurantId };
  ids.kitchen = (await prisma.station.create({ data: { ...base, name: 'Kitchen' } })).id;
  ids.bar = (await prisma.station.create({ data: { ...base, name: 'Bar' } })).id;
  ids.gst = (
    await prisma.taxGroup.create({
      data: {
        ...base,
        name: 'GST 5 %',
        sacCode: '996331',
        components: { create: [{ ...base, code: 'IGST', rateBp: 500 }] },
      },
    })
  ).id;
});

afterAll(async () => {
  await app.close();
  await controlPlane.close();
  provider.close();
  await serverDatabase.drop();
  await cpDatabase.drop();
});

describe('[ONB-006] [VCP-008] reading a printed menu into the menu', () => {
  it('sends the photos, made smaller, to the vendor, whose AI reads them into a draft', async () => {
    const photo = await sharp({
      create: { width: 3_000, height: 4_000, channels: 3, background: '#f4ecd8' },
    })
      .jpeg()
      .toBuffer();
    const pdf = Buffer.from('%PDF-1.4\n% a menu page\n');
    const started = await server()
      .post('/api/v1/menu/ai-imports')
      .set(as(manager))
      .send({
        files: [
          {
            name: 'page-1.jpg',
            contentType: 'image/jpeg',
            contentBase64: photo.toString('base64'),
          },
          {
            name: 'page-2.pdf',
            contentType: 'application/pdf',
            contentBase64: pdf.toString('base64'),
          },
        ],
      });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const queued = AiMenuImportView.parse(started.body);
    ids.import = queued.id;
    const done = await until(
      async () => {
        const view = await readImport(queued.id);
        return view.status === 'DONE' || view.status === 'FAILED' ? view : undefined;
      },
      10_000,
      'the menu to be read',
    );
    expect(done.status).toBe('DONE');
    expect(
      done.draft?.categories.map((category) => category.items.map((item) => item.name)),
    ).toEqual([['Paneer Tikka', 'Chicken 65'], ['Sweet Lassi']]);
    expect(done.draft?.categories[0]?.items[1]).toMatchObject({
      price: null,
      variants: [
        { name: 'Half', price: 22_000 },
        { name: 'Full', price: 39_950 },
      ],
      note: 'Full price smudged',
    });

    // What reached the provider: the vendor's key (never this PC's), the photo 2,000 px at most.
    expect(received).toHaveLength(1);
    expect(received[0]?.key).toBe(AI_KEY);
    const content = (
      received[0]?.body.messages as { content: { type: string; source?: { data: string } }[] }[]
    )[0]?.content;
    expect(content?.map((block) => block.type)).toEqual(['image', 'document', 'text']);
    const sent = await sharp(Buffer.from(content?.[0]?.source?.data ?? '', 'base64')).metadata();
    expect(sent).toMatchObject({ format: 'jpeg', width: 1_500, height: 2_000 });
    const audit = await prisma.auditLog.findMany({ where: { action: 'MENU_AI_IMPORT_STARTED' } });
    expect(audit).toHaveLength(1);
  });

  it('imports nothing until every dish is checked', async () => {
    const view = await readImport(id('import'));
    const partly = reviewOf(view);
    const first = partly.categories[1]?.items[0];
    if (first === undefined) throw new Error('No drink');
    partly.categories[1] = { name: 'Drinks', items: [{ ...first, checked: false }] };
    const refused = await server()
      .post(`/api/v1/menu/ai-imports/${id('import')}/commit`)
      .set(as(manager))
      .send(partly);
    expect(refused.status).toBe(422);
    expect(ApiError.parse(refused.body)).toMatchObject({
      code: 'MENU_REVIEW_INCOMPLETE',
      details: { unchecked: 1, first: ['Sweet Lassi'] },
    });
    expect(await prisma.item.count({ where: { restaurantId: kit.restaurantId } })).toBe(0);
  });

  it('imports the checked draft through the template, audited, and publishes it', async () => {
    const response = await server()
      .post(`/api/v1/menu/ai-imports/${id('import')}/commit`)
      .set(as(manager))
      .send(reviewOf(await readImport(id('import'))));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const report = MenuImportReport.parse(response.body);
    expect(report).toMatchObject({
      ok: true,
      committed: true,
      summary: { categories: 2, modifierGroups: 1, items: 3, variants: 2, combos: 0 },
    });
    expect(report.menuVersion).not.toBeNull();
    const lassi = await prisma.item.findFirstOrThrow({ where: { name: 'Sweet Lassi' } });
    expect(lassi).toMatchObject({ basePrice: 9_000, stationId: id('bar'), foodType: 'VEG' });
    const imported = await prisma.auditLog.findFirstOrThrow({ where: { action: 'MENU_IMPORTED' } });
    expect(imported.after).toMatchObject({ format: 'AI', importId: id('import'), items: 3 });
  });

  it('is for people who manage the menu only', async () => {
    const response = await server()
      .get(`/api/v1/menu/ai-imports/${id('import')}`)
      .set(as(waiter));
    expect(response.status).toBe(403);
  });

  it('says when the vendor cannot be reached, so the Excel template is used', async () => {
    await controlPlane.close();
    const response = await server()
      .post('/api/v1/menu/ai-imports')
      .set(as(manager))
      .send({
        files: [{ name: 'menu.pdf', contentType: 'application/pdf', contentBase64: 'JVBERi0x' }],
      });
    expect(response.status).toBe(503);
    expect(ApiError.parse(response.body).code).toBe('VENDOR_UNREACHABLE');
  });
});
