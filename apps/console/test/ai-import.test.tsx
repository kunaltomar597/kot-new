import type { AiMenuImportView, MenuReviewRequest } from '@rp/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkSection,
  dishProblems,
  readyToImport,
  removeDish,
  reviewOf,
  reviewRequest,
  updateDish,
} from '../src/manage/menu/ai-import-view.js';
import type { FakeServer } from './fake-server.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import { GST5, KITCHEN, stations, TANDOOR, taxGroups } from './menu-fixture.js';

const PATH = '/manage/menu/ai-import';
const IMPORTS = '/api/v1/menu/ai-imports';
const IMPORT_ID = '0199a0e0-0000-7000-8000-000000000c01';

const DRAFT: NonNullable<AiMenuImportView['draft']> = {
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
        {
          name: 'Chicken 65',
          description: null,
          price: null,
          variants: [
            { name: 'Half', price: 22_000 },
            { name: 'Full', price: 39_950 },
          ],
          foodType: null,
          spiceLevel: null,
          tags: [],
          note: 'Full price smudged',
        },
      ],
    },
  ],
  addOns: [{ group: 'Extras', options: [{ name: 'Extra cheese', price: 4_000 }] }],
  notes: ['Page 2 was cut off'],
};

const view = (status: AiMenuImportView['status']): AiMenuImportView => ({
  id: IMPORT_ID,
  status,
  createdAt: '2026-10-02T10:00:00.000Z',
  finishedAt: status === 'DONE' || status === 'FAILED' ? '2026-10-02T10:01:00.000Z' : null,
  error:
    status === 'FAILED'
      ? { code: 'AI_NO_MENU_FOUND', message: 'No menu could be read from these files.' }
      : null,
  draft: status === 'DONE' ? DRAFT : null,
});

function importServer(...reads: AiMenuImportView['status'][]): FakeServer {
  return signsInAs(server(), 'MANAGER')
    .on('GET', '/api/v1/tax-groups', () => ({ status: 200, body: taxGroups() }))
    .on('GET', '/api/v1/stations', () => ({ status: 200, body: stations() }))
    .on('POST', IMPORTS, () => ({ status: 202, body: view('QUEUED') }))
    .on(
      'GET',
      `${IMPORTS}/${IMPORT_ID}`,
      ...reads.map((status) => () => ({ status: 200, body: view(status) })),
    )
    .on('POST', `${IMPORTS}/${IMPORT_ID}/commit`, () => ({
      status: 200,
      body: {
        ok: true,
        committed: true,
        issues: [],
        summary: { categories: 1, modifierGroups: 1, items: 2, variants: 2, combos: 0 },
        menuVersion: 4,
      },
    }));
}

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[ONB-006] checking an AI-read menu', () => {
  it('needs every dish checked and complete, and sends each section’s station and tax group', () => {
    let review = reviewOf(DRAFT, { stationId: KITCHEN, taxGroupId: GST5 });
    const [tikka, chicken] = review.sections[0]?.dishes ?? [];
    if (tikka === undefined || chicken === undefined) throw new Error('No dishes');
    expect(chicken).toMatchObject({ price: '', foodType: '', note: 'Full price smudged' });
    expect(dishProblems(chicken)).toEqual(['FOOD_TYPE']);
    expect(dishProblems({ ...tikka, price: 'abc' })).toEqual(['PRICE']);
    review = checkSection(review, review.sections[0]?.key ?? '');
    expect(readyToImport(review)).toBe(false);
    review = updateDish(review, chicken.key, { foodType: 'NON_VEG' });
    expect(readyToImport(review)).toBe(true);
    const request: MenuReviewRequest = reviewRequest(review);
    expect(request.categories[0]?.items[1]).toMatchObject({
      name: 'Chicken 65',
      price: null,
      variants: [
        { name: 'Half', price: 22_000 },
        { name: 'Full', price: 39_950 },
      ],
      foodType: 'NON_VEG',
      taxGroupId: GST5,
      stationId: KITCHEN,
      checked: true,
    });
    expect(request.addOns).toEqual([
      {
        group: 'Extras',
        minSelections: 0,
        maxSelections: 1,
        options: [{ name: 'Extra cheese', priceDelta: 4_000 }],
      },
    ]);
    expect(removeDish(review, tikka.key).sections[0]?.dishes).toHaveLength(1);
    expect(removeDish(removeDish(review, tikka.key), chicken.key).sections).toEqual([]);
  });

  it('reads the photos, then imports only once every dish is checked', async () => {
    const fake = importServer('RUNNING', 'DONE');
    const { user, container } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.upload(
      await screen.findByLabelText(t('aiImport.files')),
      new File(['menu photo'], 'page-1.jpg', { type: 'image/jpeg' }),
    );
    await user.click(screen.getByRole('button', { name: t('aiImport.read') }));
    await waitFor(() => {
      expect(fake.callsTo('POST', IMPORTS)[0]?.body).toEqual({
        files: [
          { name: 'page-1.jpg', contentType: 'image/jpeg', contentBase64: 'bWVudSBwaG90bw==' },
        ],
      });
    });
    expect(await screen.findByText(t('aiImport.reading'), { selector: 'p' })).toBeVisible();

    // The draft arrives (after a poll).
    const starters = within(
      await screen.findByRole('region', { name: 'Starters' }, { timeout: 5_000 }),
    );
    expect(screen.getByText(t('aiImport.review.progress', { checked: 0, total: 2 }))).toBeVisible();
    expect(screen.getByText('Page 2 was cut off')).toBeVisible();
    expect(
      starters.getByText(t('aiImport.review.unsure', { note: 'Full price smudged' })),
    ).toBeVisible();
    const add = screen.getByRole('button', { name: t('aiImport.review.add') });
    expect(add).toBeDisabled();

    await user.click(
      starters.getByRole('button', { name: t('aiImport.review.checkAll', { name: 'Starters' }) }),
    );
    expect(screen.getByText(t('aiImport.review.progress', { checked: 2, total: 2 }))).toBeVisible();
    // Chicken 65 still needs its food type.
    expect(add).toBeDisabled();
    expect(starters.getByText(t('aiImport.review.problem.FOOD_TYPE'))).toBeVisible();
    const foodTypes = starters.getAllByLabelText(new RegExp(`^${t('aiImport.review.foodType')}`));
    await user.selectOptions(foodTypes[1]!, t('pos.menu.foodType.NON_VEG'));
    // The section's station: the tandoor.
    await user.selectOptions(
      starters.getByLabelText(new RegExp(`^${t('aiImport.review.station')}`)),
      'Tandoor',
    );
    await expectNoAxeViolations(container);
    expect(add).toBeEnabled();
    await user.click(add);

    expect(await screen.findByText(t('aiImport.done'))).toBeVisible();
    const sent = fake.callsTo('POST', `${IMPORTS}/${IMPORT_ID}/commit`)[0]
      ?.body as MenuReviewRequest;
    expect(
      sent.categories[0]?.items.map((item) => [
        item.name,
        item.foodType,
        item.stationId,
        item.checked,
      ]),
    ).toEqual([
      ['Paneer Tikka', 'VEG', TANDOOR, true],
      ['Chicken 65', 'NON_VEG', TANDOOR, true],
    ]);
    expect(
      screen.getByText(t('aiImport.doneSummary', { items: 2, categories: 1, version: 4 })),
    ).toBeVisible();
  });

  it('says why a menu could not be read, and starts again', async () => {
    window.localStorage.setItem('rp.console.aiImport', IMPORT_ID);
    const { user } = await renderConsole({
      fake: importServer('FAILED'),
      path: PATH,
      signedIn: 'MANAGER',
    });
    expect(await screen.findByText('No menu could be read from these files.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: t('aiImport.startAgain') }));
    expect(await screen.findByRole('button', { name: t('aiImport.read') })).toBeDisabled();
  });
});
