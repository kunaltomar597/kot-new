import type { ItemView, MenuDraftResponse } from '@rp/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeResponse, FakeServer } from './fake-server.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import {
  BREADS,
  draftMenu,
  GST5,
  item,
  KITCHEN,
  MAINS,
  NAAN,
  PANEER,
  ROTI_TYPE,
  stations,
  taxGroups,
} from './menu-fixture.js';

const PATH = '/manage/menu';
const DRAFT = '/api/v1/menu/draft';
const ITEMS = '/api/v1/menu/items';

function menuServer(...drafts: MenuDraftResponse[]): FakeServer {
  const answers = (drafts.length === 0 ? [draftMenu()] : drafts).map(
    (body) => (): FakeResponse => ({ status: 200, body }),
  );
  return signsInAs(server(), 'MANAGER')
    .on('GET', '/api/v1/tax-groups', () => ({ status: 200, body: taxGroups() }))
    .on('GET', '/api/v1/stations', () => ({ status: 200, body: stations() }))
    .on('GET', DRAFT, ...answers);
}

const rowOf = async (name: string) =>
  (await screen.findByRole('heading', { level: 3, name: new RegExp(`^${name}`) })).closest(
    'li',
  ) as HTMLElement;
const actionsFor = (name: string) =>
  screen.findByRole('group', { name: t('menuEditor.items.actionsFor', { name }) });
/** The control labelled `label` (its label may end with a required mark or hint). */
const field = (
  dialog: { getByLabelText: (matcher: RegExp) => HTMLElement },
  label: string,
): HTMLElement => dialog.getByLabelText(new RegExp(`^${label.replace(/[()₹]/g, '.')}`));

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[MGR-005] [MENU-002] [MENU-006] the dishes', () => {
  it('lists the dishes in menu order with category, price and stock in words', async () => {
    const { container } = await renderConsole({
      fake: menuServer(),
      path: PATH,
      signedIn: 'MANAGER',
    });
    expect(
      await screen.findByRole('heading', { level: 2, name: t('menuEditor.title') }),
    ).toBeVisible();
    const list = await screen.findByRole('list', { name: t('menuEditor.tabs.items') });
    expect(
      within(list)
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.firstChild?.textContent),
    ).toEqual(['Veg Thali', 'Paneer Tikka Masala', 'Butter Naan']);

    const paneer = await rowOf('Paneer Tikka Masala');
    expect(
      within(paneer).getByText(
        t('menuEditor.items.line', {
          category: 'Mains › Curries',
          price: t('menuEditor.items.priceFrom', { price: '₹180.00' }),
        }),
      ),
    ).toBeVisible();
    expect(within(paneer).getByText(t('menuEditor.items.stockLeft', { count: 4 }))).toBeVisible();
    expect(within(paneer).getByText(t('menuEditor.items.variants', { count: 2 }))).toBeVisible();

    const thali = await rowOf('Veg Thali');
    expect(within(thali).getByText(t('menuEditor.items.soldOut'))).toBeVisible();
    expect(within(thali).getByText(t('menuEditor.items.combo'))).toBeVisible();
    await expectNoAxeViolations(container);
  });

  it('adds a dish only once it is complete, with its photo, size and option group', async () => {
    const created = item({ id: '0199a0e0-0000-7000-8000-000000001099', name: 'Garlic Naan' });
    const after = draftMenu();
    after.items.push(created);
    const fake = menuServer(draftMenu(), after)
      .on('POST', '/api/v1/photos', () => ({
        status: 201,
        body: {
          id: '0199a0e0-0000-7000-8000-000000001098',
          mimeType: 'image/webp',
          width: 960,
          height: 720,
          renditions: [],
          createdAt: '2026-10-01T10:00:00.000Z',
        },
      }))
      .on('POST', ITEMS, () => ({ status: 201, body: created }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(await screen.findByRole('button', { name: t('menuEditor.items.add') }));
    const dialog = within(
      await screen.findByRole('dialog', { name: t('menuEditor.item.addTitle') }),
    );
    await user.click(dialog.getByRole('button', { name: t('menuEditor.item.add') }));
    expect(dialog.getByText(t('menuEditor.item.problems.nameRequired'))).toBeVisible();
    expect(dialog.getByText(t('menuEditor.item.problems.priceInvalid'))).toBeVisible();
    expect(fake.callsTo('POST', ITEMS)).toHaveLength(0);

    await user.type(field(dialog, t('menuEditor.item.name')), 'Garlic Naan');
    await user.selectOptions(field(dialog, t('menuEditor.item.category')), BREADS);
    await user.type(field(dialog, t('menuEditor.item.price')), '80');
    await user.selectOptions(field(dialog, t('menuEditor.item.station')), KITCHEN);
    await user.upload(
      dialog.getByLabelText(t('menuEditor.item.uploadPhoto')),
      new File(['photo'], 'naan.jpg', { type: 'image/jpeg' }),
    );
    expect(
      await dialog.findByRole('img', {
        name: t('menuEditor.item.photoAlt', { name: 'Garlic Naan' }),
      }),
    ).toBeVisible();
    await user.click(dialog.getByRole('button', { name: t('menuEditor.item.addVariant') }));
    await user.type(field(dialog, t('menuEditor.item.variantName')), 'Two pieces');
    await user.type(field(dialog, t('menuEditor.item.variantPrice')), '150');
    await user.click(dialog.getByRole('checkbox', { name: 'Roti type' }));
    await user.type(field(dialog, t('menuEditor.item.tags')), 'Jain, bestseller');
    await user.click(dialog.getByRole('button', { name: t('menuEditor.item.add') }));

    expect(
      await screen.findByText(t('menuEditor.items.added', { name: 'Garlic Naan' })),
    ).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/photos')[0]?.body).toEqual({
      contentBase64: btoa('photo'),
    });
    expect(fake.callsTo('POST', ITEMS)[0]?.body).toMatchObject({
      name: 'Garlic Naan',
      categoryId: BREADS,
      basePrice: 8000,
      taxGroupId: GST5,
      stationId: KITCHEN,
      photoId: '0199a0e0-0000-7000-8000-000000001098',
      variants: [{ name: 'Two pieces', price: 15000 }],
      modifierGroupIds: [ROTI_TYPE],
      tags: ['Jain', 'bestseller'],
      channels: ['POS', 'WAITER_APP', 'TABLE_TABLET', 'QR'],
    });
    expect(await rowOf('Garlic Naan')).toBeVisible();
  });

  it('[MENU-009] asks why when a price changes, and keeps the answer with the change', async () => {
    const fake = menuServer().on('PUT', `${ITEMS}/${NAAN}`, () => ({
      status: 200,
      body: item({ basePrice: 6500 }),
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      within(await actionsFor('Butter Naan')).getByRole('button', { name: t('menuEditor.edit') }),
    );
    const dialog = within(
      await screen.findByRole('dialog', {
        name: t('menuEditor.item.editTitle', { name: 'Butter Naan' }),
      }),
    );
    expect(dialog.queryByLabelText(new RegExp(`^${t('menuEditor.item.reason')}`))).toBeNull();
    const price = field(dialog, t('menuEditor.item.price'));
    expect(price).toHaveValue('60.00');
    await user.clear(price);
    await user.type(price, '65');
    await user.type(field(dialog, t('menuEditor.item.reason')), 'Butter costs more');
    await user.click(dialog.getByRole('button', { name: t('menuEditor.item.save') }));
    expect(
      await screen.findByText(t('menuEditor.items.saved', { name: 'Butter Naan' })),
    ).toBeVisible();
    expect(fake.callsTo('PUT', `${ITEMS}/${NAAN}`)[0]?.body).toMatchObject({
      basePrice: 6500,
      reason: 'Butter costs more',
      modifierGroupIds: [ROTI_TYPE],
    });
  });

  it('[MENU-005] makes a new dish a combo of other dishes', async () => {
    const created: ItemView = item({
      id: '0199a0e0-0000-7000-8000-000000001097',
      name: 'Mini Meal',
    });
    const fake = menuServer()
      .on('POST', ITEMS, () => ({ status: 201, body: created }))
      .on('PUT', `${ITEMS}/${created.id}/combo`, () => ({
        status: 200,
        body: {
          itemId: created.id,
          components: [],
          activeFrom: null,
          activeUntil: null,
          timeWindow: null,
        },
      }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(await screen.findByRole('button', { name: t('menuEditor.items.add') }));
    const dialog = within(
      await screen.findByRole('dialog', { name: t('menuEditor.item.addTitle') }),
    );
    await user.type(field(dialog, t('menuEditor.item.name')), 'Mini Meal');
    await user.selectOptions(field(dialog, t('menuEditor.item.category')), MAINS);
    await user.type(field(dialog, t('menuEditor.item.price')), '199');
    await user.selectOptions(field(dialog, t('menuEditor.item.station')), KITCHEN);
    await user.click(dialog.getByRole('checkbox', { name: t('menuEditor.item.isCombo') }));
    await user.selectOptions(field(dialog, t('menuEditor.combo.dish')), PANEER);
    await user.click(dialog.getByRole('button', { name: t('menuEditor.combo.addChoice') }));
    await user.type(field(dialog, t('menuEditor.combo.label')), 'Any 1 bread');
    // Only one dish to choose from: a choice needs two.
    await user.click(dialog.getByRole('checkbox', { name: 'Butter Naan' }));
    await user.click(dialog.getByRole('button', { name: t('menuEditor.item.add') }));
    expect(dialog.getByText(t('menuEditor.combo.problems.partInvalid'))).toBeVisible();
    expect(fake.callsTo('POST', ITEMS)).toHaveLength(0);

    await user.click(dialog.getByRole('checkbox', { name: 'Paneer Tikka Masala' }));
    await user.click(dialog.getByRole('button', { name: t('menuEditor.item.add') }));
    expect(
      await screen.findByText(t('menuEditor.items.added', { name: 'Mini Meal' })),
    ).toBeVisible();
    expect(fake.callsTo('PUT', `${ITEMS}/${created.id}/combo`)[0]?.body).toEqual({
      components: [
        { kind: 'FIXED', itemId: PANEER, quantity: 1 },
        { kind: 'CHOICE', label: 'Any 1 bread', itemIds: [NAAN, PANEER], quantity: 1 },
      ],
      activeFrom: null,
      activeUntil: null,
      timeWindow: null,
    });
  });

  it('[MENU-006] sets a dish out of stock or counts its portions, at once', async () => {
    const fake = menuServer().on('PUT', `${ITEMS}/${NAAN}/availability`, () => ({
      status: 200,
      body: { itemId: NAAN, available: true, stockCount: 12 },
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      within(await actionsFor('Butter Naan')).getByRole('button', {
        name: t('menuEditor.items.availability'),
      }),
    );
    const dialog = within(
      await screen.findByRole('dialog', {
        name: t('menuEditor.availability.title', { name: 'Butter Naan' }),
      }),
    );
    await user.click(dialog.getByRole('checkbox', { name: t('menuEditor.availability.count') }));
    await user.type(field(dialog, t('menuEditor.availability.left')), '12');
    await user.click(dialog.getByRole('button', { name: t('menuEditor.availability.save') }));
    expect(
      await screen.findByText(t('menuEditor.availability.saved', { name: 'Butter Naan' })),
    ).toBeVisible();
    expect(fake.callsTo('PUT', `${ITEMS}/${NAAN}/availability`)[0]?.body).toEqual({
      available: true,
      stockCount: 12,
    });
  });

  it('[MENU-010] archives a dish only with a reason, and restores it', async () => {
    const fake = menuServer()
      .on('POST', `${ITEMS}/${NAAN}/archive`, () => ({ status: 200, body: item() }))
      .on('POST', `${ITEMS}/0199a0e0-0000-7000-8000-000000001044/restore`, () => ({
        status: 200,
        body: item(),
      }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      within(await actionsFor('Butter Naan')).getByRole('button', {
        name: t('menuEditor.archive'),
      }),
    );
    const dialog = within(
      await screen.findByRole('dialog', {
        name: t('menuEditor.items.archiveTitle', { name: 'Butter Naan' }),
      }),
    );
    await user.click(dialog.getByRole('button', { name: t('menuEditor.archive') }));
    expect(dialog.getByText(t('menuEditor.reasonRequired'))).toBeVisible();
    await user.type(field(dialog, t('menuEditor.reason')), 'Oven broken');
    await user.click(dialog.getByRole('button', { name: t('menuEditor.archive') }));
    expect(
      await screen.findByText(t('menuEditor.items.archivedToast', { name: 'Butter Naan' })),
    ).toBeVisible();
    expect(fake.callsTo('POST', `${ITEMS}/${NAAN}/archive`)[0]?.body).toEqual({
      reason: 'Oven broken',
    });

    await user.click(screen.getByRole('checkbox', { name: t('menuEditor.items.showArchived') }));
    await user.click(
      within(await actionsFor('Mango Lassi')).getByRole('button', {
        name: t('menuEditor.restore'),
      }),
    );
    expect(
      await screen.findByText(t('menuEditor.items.restored', { name: 'Mango Lassi' })),
    ).toBeVisible();
  });
});

describe('[MENU-013] publishing', () => {
  it('publishes the draft, or says nothing changed', async () => {
    const fake = menuServer().on(
      'POST',
      '/api/v1/menu/publish',
      () => ({
        status: 200,
        body: {
          version: 4,
          publishedAt: '2026-10-01T10:00:00.000Z',
          checksum: 'a',
          published: true,
        },
      }),
      () => ({
        status: 200,
        body: {
          version: 4,
          publishedAt: '2026-10-01T10:00:00.000Z',
          checksum: 'a',
          published: false,
        },
      }),
    );
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(await screen.findByRole('button', { name: t('menuEditor.publish') }));
    expect(await screen.findByText(t('menuEditor.published', { version: 4 }))).toBeVisible();
    await user.click(screen.getByRole('button', { name: t('menuEditor.publish') }));
    expect(await screen.findByText(t('menuEditor.unchanged', { version: 4 }))).toBeVisible();
  });
});

describe('[MENU-001] [MENU-004] categories and option groups', () => {
  it('adds a sub-category inside a top-level one', async () => {
    const fake = menuServer().on('POST', '/api/v1/menu/categories', () => ({
      status: 201,
      body: {
        id: '0199a0e0-0000-7000-8000-000000001096',
        name: 'Rolls',
        parentId: MAINS,
        displayOrder: 40,
        archivedAt: null,
      },
    }));
    const { user, container } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(await screen.findByRole('tab', { name: t('menuEditor.tabs.categories') }));
    const list = await screen.findByRole('list', { name: t('menuEditor.tabs.categories') });
    const curries = within(list).getByRole('heading', { name: 'Curries' }).closest('li');
    expect(curries).toHaveAttribute('data-depth', '1');
    expect(
      within(curries as HTMLElement).getByText(t('menuEditor.categories.dishes', { count: 1 })),
    ).toBeVisible();
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: t('menuEditor.categories.add') }));
    const dialog = within(
      await screen.findByRole('dialog', { name: t('menuEditor.categories.addTitle') }),
    );
    await user.type(field(dialog, t('menuEditor.categories.name')), 'Rolls');
    await user.selectOptions(field(dialog, t('menuEditor.categories.parent')), MAINS);
    await user.click(dialog.getByRole('button', { name: t('menuEditor.save') }));
    expect(
      await screen.findByText(t('menuEditor.categories.added', { name: 'Rolls' })),
    ).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/menu/categories')[0]?.body).toEqual({
      name: 'Rolls',
      parentId: MAINS,
      displayOrder: 40,
    });
  });

  it('adds an option group with its rule and priced options', async () => {
    const fake = menuServer().on('POST', '/api/v1/menu/modifier-groups', () => ({
      status: 201,
      body: draftMenu().modifierGroups[0],
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(await screen.findByRole('tab', { name: t('menuEditor.tabs.groups') }));
    expect(
      within(await screen.findByRole('list', { name: t('menuEditor.tabs.groups') })).getByText(
        t('menuEditor.groups.ruleExactly', { count: 1 }),
      ),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: t('menuEditor.groups.add') }));
    const dialog = within(
      await screen.findByRole('dialog', { name: t('menuEditor.groups.addTitle') }),
    );
    await user.type(field(dialog, t('menuEditor.groups.name')), 'Spice');
    const min = field(dialog, t('menuEditor.groups.min'));
    await user.clear(min);
    await user.type(min, '1');
    await user.type(field(dialog, t('menuEditor.groups.optionName')), 'Mild');
    await user.click(dialog.getByRole('button', { name: t('menuEditor.groups.addOption') }));
    const names = dialog.getAllByLabelText(new RegExp(`^${t('menuEditor.groups.optionName')}`));
    await user.type(names[1]!, 'Extra hot');
    const prices = dialog.getAllByLabelText(
      new RegExp(`^${t('menuEditor.groups.optionPrice').replace(/[()₹]/g, '.')}`),
    );
    await user.clear(prices[1]!);
    await user.type(prices[1]!, '10');
    await user.click(dialog.getByRole('button', { name: t('menuEditor.save') }));
    expect(await screen.findByText(t('menuEditor.groups.added', { name: 'Spice' }))).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/menu/modifier-groups')[0]?.body).toEqual({
      name: 'Spice',
      minSelections: 1,
      maxSelections: 1,
      options: [
        { name: 'Mild', priceDelta: 0, available: true },
        { name: 'Extra hot', priceDelta: 1000, available: true },
      ],
    });
  });
});

describe('[SEC-003] who sees the menu editor', () => {
  it('is linked for managers and not for cashiers', async () => {
    const fake = signsInAs(server(), 'CASHIER');
    await renderConsole({ fake, path: PATH, signedIn: 'CASHIER' });
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: t('dashboard.section.menu') })).toBeNull();
    });
    expect(fake.callsTo('GET', DRAFT)).toHaveLength(0);
  });
});
