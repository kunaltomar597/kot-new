import type { INestApplication } from '@nestjs/common';
import { type MenuDraft, MenuExtractionView } from '@rp/contracts/control-plane';
import type { TestDatabase } from '@rp/test-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { MenuExtractionsService } from '../../src/menu-import/menu-extractions.service.js';
import {
  ExtractionError,
  type ExtractionFile,
  MENU_EXTRACTOR,
  type MenuExtractor,
} from '../../src/menu-import/menu-extractor.js';
import { enrolledInstallation, signedGet, signedPost } from '../helpers/fleet.js';
import { createTestApp, createTestDatabase } from '../helpers/test-app.js';
import type { TestInstallation } from '../helpers/test-installation.js';

/**
 * AI-assisted menu import at the Control Plane (P6-04a, ONB-006, VCP-008, SEC-002): the files of a
 * restaurant's printed menu are read by the AI provider (here a scripted stand-in: CI never calls
 * the real one), the draft is the restaurant's alone, the files go once read, and the vendor's
 * daily limit and the provider's busy spells are handled.
 */

const DRAFT: MenuDraft = {
  categories: [
    {
      name: 'Starters',
      items: [
        {
          name: 'Paneer Tikka',
          description: null,
          price: 28_000,
          variants: [],
          foodType: 'VEG',
          spiceLevel: 2,
          tags: [],
          note: null,
        },
      ],
    },
  ],
  addOns: [],
  notes: [],
};

/** The reader's next answers, in order; `seen` records what it was given. */
const script: (() => Promise<MenuDraft>)[] = [];
const seen: (readonly ExtractionFile[])[] = [];
const reader: MenuExtractor = {
  configured: true,
  extract: (files) => {
    seen.push(files);
    const next = script.shift() ?? (() => Promise.resolve(DRAFT));
    return next().then((draft) => ({
      draft,
      model: 'scripted',
      inputTokens: 1_000,
      outputTokens: 200,
    }));
  },
};

let database: TestDatabase;
let app: INestApplication;
let offApp: INestApplication;
let prisma: PrismaService;
let extractions: MenuExtractionsService;
let restaurant: TestInstallation;
let neighbour: TestInstallation;

const photo = (bytes = 3, name = 'page-1.jpg') => ({
  name,
  contentType: 'image/jpeg',
  contentBase64: Buffer.alloc(bytes, 7).toString('base64'),
});

async function send(installation: TestInstallation, files: unknown[], on: INestApplication = app) {
  const response = await signedPost(
    on,
    installation,
    '/v1/menu-extractions',
    JSON.stringify({ files }),
  );
  return { status: response.status, body: response.body as unknown };
}

async function job(installation: TestInstallation, id: string) {
  const response = await signedGet(app, installation, `/v1/menu-extractions/${id}`);
  return { status: response.status, body: response.body as unknown };
}

beforeAll(async () => {
  database = await createTestDatabase();
  app = await createTestApp(database.url, { aiDailyLimit: 6 }, [
    { provide: MENU_EXTRACTOR, useValue: reader },
  ]);
  // The same database, as a Control Plane without an AI key.
  offApp = await createTestApp(database.url);
  prisma = app.get(PrismaService);
  extractions = app.get(MenuExtractionsService);
  restaurant = await enrolledInstallation(app);
  neighbour = await enrolledInstallation(app);
});

afterAll(async () => {
  await offApp.close();
  await app.close();
  await database.drop();
});

describe('[ONB-006] [VCP-008] reading a printed menu', () => {
  it('takes the photos, reads them in the background and gives the restaurant its draft', async () => {
    const pdf = {
      name: 'menu.pdf',
      contentType: 'application/pdf',
      // Larger than the 64 kB every other request is held to.
      contentBase64: Buffer.alloc(200_000, 1).toString('base64'),
    };
    const created = await send(restaurant, [photo(), pdf]);
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    const queued = MenuExtractionView.parse(created.body);
    expect(queued).toMatchObject({ status: 'QUEUED', draft: null, error: null });
    await extractions.settled();
    expect(seen.at(-1)?.map((file) => [file.name, file.contentType, file.content.length])).toEqual([
      ['page-1.jpg', 'image/jpeg', 3],
      ['menu.pdf', 'application/pdf', 200_000],
    ]);
    const done = MenuExtractionView.parse((await job(restaurant, queued.id)).body);
    expect(done).toMatchObject({ status: 'DONE', draft: DRAFT, error: null });
    expect(done.finishedAt).not.toBeNull();
    // The photos are not kept once read; the cost is.
    expect(await prisma.menuExtractionFile.count({ where: { extractionId: queued.id } })).toBe(0);
    expect(await prisma.menuExtraction.findUnique({ where: { id: queued.id } })).toMatchObject({
      model: 'scripted',
      inputTokens: 1_000,
      outputTokens: 200,
      attempts: 1,
    });
    const audit = await prisma.auditEntry.findMany({
      where: { targetType: 'menu_extraction', targetId: queued.id },
      orderBy: { id: 'asc' },
    });
    expect(audit.map((entry) => [entry.actor, entry.action])).toEqual([
      [`installation:${restaurant.id ?? ''}`, 'menu_extraction.requested'],
      ['system:menu-reader', 'menu_extraction.read'],
    ]);
    ids.first = queued.id;
  });

  it('[QR-014] keeps a draft to its own restaurant', async () => {
    const other = await job(neighbour, ids.first ?? '');
    expect(other.status).toBe(404);
    expect((other.body as { code: string }).code).toBe('MENU_EXTRACTION_NOT_FOUND');
  });

  it('takes only menu photos and PDFs, a few at a time, of a size the reader accepts', async () => {
    const gif = await send(restaurant, [{ ...photo(), contentType: 'image/gif' }]);
    expect(gif.status).toBe(400);
    const big = await send(restaurant, [photo(5 * 1024 * 1024 + 1)]);
    expect(big.status).toBe(400);
    const many = await send(
      restaurant,
      Array.from({ length: 11 }, (_, index) => photo(3, `p${String(index)}.jpg`)),
    );
    expect(many.status).toBe(400);
    expect(await send(restaurant, [])).toMatchObject({ status: 400 });
  });

  it('tries a busy reader again later, and says why when it cannot read the menu', async () => {
    script.push(() =>
      Promise.reject(new ExtractionError('AI_PROVIDER_FAILED', 'The menu reader is busy.', true)),
    );
    const busy = MenuExtractionView.parse((await send(restaurant, [photo()])).body);
    await expect
      .poll(
        async () => (await prisma.menuExtraction.findUnique({ where: { id: busy.id } }))?.notBefore,
      )
      .not.toBeNull();
    expect((await prisma.menuExtraction.findUnique({ where: { id: busy.id } }))?.status).toBe(
      'QUEUED',
    );
    // Half a minute later, by the clock of the database.
    await prisma.menuExtraction.update({
      where: { id: busy.id },
      data: { notBefore: new Date(Date.now() - 1_000) },
    });
    extractions.kick();
    await extractions.settled();
    expect(MenuExtractionView.parse((await job(restaurant, busy.id)).body).status).toBe('DONE');
    expect((await prisma.menuExtraction.findUnique({ where: { id: busy.id } }))?.attempts).toBe(2);

    script.push(() =>
      Promise.reject(
        new ExtractionError('AI_NO_MENU_FOUND', 'No menu could be read from these files.', false),
      ),
    );
    const blurred = MenuExtractionView.parse((await send(restaurant, [photo()])).body);
    await extractions.settled();
    const failed = MenuExtractionView.parse((await job(restaurant, blurred.id)).body);
    expect(failed).toMatchObject({
      status: 'FAILED',
      draft: null,
      error: { code: 'AI_NO_MENU_FOUND', message: 'No menu could be read from these files.' },
    });
    expect(await prisma.menuExtractionFile.count({ where: { extractionId: blurred.id } })).toBe(0);
  });

  it('reads again a menu a restart cut off', async () => {
    const cut = MenuExtractionView.parse((await send(restaurant, [photo()])).body);
    await extractions.settled();
    await prisma.menuExtraction.update({ where: { id: cut.id }, data: { status: 'RUNNING' } });
    await extractions.onApplicationBootstrap();
    await extractions.settled();
    expect(MenuExtractionView.parse((await job(restaurant, cut.id)).body).status).toBe('DONE');
  });

  it('[SEC-002] holds each restaurant to the daily number, and is off without a key', async () => {
    // Four read today already; the limit here is six.
    expect((await send(restaurant, [photo()])).status).toBe(202);
    expect((await send(restaurant, [photo()])).status).toBe(202);
    const over = await send(restaurant, [photo()]);
    expect(over.status).toBe(429);
    expect((over.body as { code: string }).code).toBe('AI_IMPORT_LIMIT');
    // Another restaurant has its own.
    expect((await send(neighbour, [photo()])).status).toBe(202);
    await extractions.settled();
    const off = await send(neighbour, [photo()], offApp);
    expect(off.status).toBe(503);
    expect((off.body as { code: string }).code).toBe('AI_IMPORT_UNAVAILABLE');
  });

  it('[SEC-002] counts readings sent together against the day’s number (threat CP-D3)', async () => {
    // The neighbour has read one today; ten at once leave it at six.
    const sent = await Promise.all(Array.from({ length: 10 }, () => send(neighbour, [photo()])));
    expect(sent.filter((response) => response.status === 202)).toHaveLength(5);
    expect(sent.filter((response) => response.status === 429)).toHaveLength(5);
    await extractions.settled();
  });
});

const ids: Record<string, string> = {};
