import type { ItemRequest, ItemView } from '@rp/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeServer } from './fake-server.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import {
  IDS,
  item,
  menuDraft,
  menuEvent,
  stations,
  taxGroups,
  THALI_COMBO,
} from './menu-fixture.js';

const NEW_ITEM = '0199a0e0-0000-7000-8000-000000000399';

function menuServer(role: 'MANAGER' | 'OWNER' = 'MANAGER'): FakeServer {
  return signsInAs(server(), role)
    .on('GET', '/api/v1/menu/draft', () => ({ status: 200, body: menuDraft() }))
    .on('GET', '/api/v1/tax-groups', () => ({ status: 200, body: { taxGroups: taxGroups() } }))
    .on('GET', '/api/v1/stations', () => ({ status: 200, body: { stations: stations() } }));
}

/** What the server answers for a created or updated item: the request, as stored. */
function stored(id: string, body: unknown): ItemView {
  const request = body as ItemRequest;
  const { reason: _reason, variants, ...rest } = request;
  return item('lassi', request.name, {
    ...rest,
    id,
    variants: variants.map((variant, index) => ({
      id: variant.id ?? `0199a0e0-0000-7000-8000-0000000004${String(index).padStart(2, '0')}`,
      name: variant.name,
      price: variant.price,
      displayOrder: index + 1,
      externalId: variant.externalId ?? null,
      archivedAt: null,
    })),
  });
}

const PHOTO = {
  id: IDS.photo,
  mimeType: 'image/webp',
  width: 960,
  height: 720,
  renditions: [{ width: 160, height: 120, bytes: 4_000, url: `/api/v1/photos/${IDS.photo}/160` }],
  createdAt: '2026-09-28T10:00:00.000Z',
};

const nav = () => screen.getByRole('navigation', { name: t('dashboard.navigation') });
const actionsFor = (name: string) =>
  screen.findByRole('group', { name: t('menuEditor.items.actionsFor', { name }) });
const rowOf = async (name: string) => {
  const group = await actionsFor(name);
  const row = group.closest('li');
  if (row === null) throw new Error(`No row for ${name}`);
  return within(row);
};
/** A field by the start of its label (a required field's label ends with a marker). */
const field = (label: string) =>
  screen.getByLabelText(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[MGR-005] the menu editor', () => {
  it('lists the items by category with prices, food type and state in words', async () => {
    const { container } = await renderConsole({
      fake: menuServer(),
      path: '/manage/menu',
      signedIn: 'MANAGER',
    });
    expect(
      await screen.findByRole('heading', { level: 2, name: t('menuEditor.items.title') }),
    ).toBeVisible();
    expect(within(nav()).getByRole('link', { name: t('dashboard.section.menu') })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Starters' })).toBeVisible();
    expect(
      screen.getByRole('heading', {
        level: 4,
        name: t('menuEditor.categoryPath', { parent: 'Starters', name: 'Veg starters' }),
      }),
    ).toBeVisible();
    // Starters itself holds only an archived soup, which is not shown.
    expect(screen.getByText(t('menuEditor.items.emptyCategory'))).toBeVisible();
    expect(screen.queryByText('Tomato Soup')).toBeNull();

    const tikka = await rowOf('Paneer Tikka');
    expect(tikka.getByText('PT')).toBeVisible();
    expect(
      tikka.getByText(t('menuEditor.items.priceRange', { low: '₹180.00', high: '₹320.00' })),
    ).toBeVisible();
    expect(tikka.getByText(t('menuEditor.items.sizes', { count: 2 }))).toBeVisible();
    expect(tikka.getByText(t('pos.menu.foodType.VEG'))).toBeVisible();
    expect(
      (await rowOf('Hariyali Kebab')).getByText(t('menuEditor.items.left', { count: 6 })),
    ).toBeVisible();
    expect((await rowOf('Lassi')).getByText(t('menuEditor.items.outOfStock'))).toBeVisible();
    expect(
      (await rowOf('Masala Chaas')).getByText(
        t('menuEditor.items.notOn', { channels: t('menuEditor.editor.channel.QR') }),
      ),
    ).toBeVisible();
    expect((await rowOf('Veg Thali')).getByText(t('menuEditor.items.combo'))).toBeVisible();
    expect(
      within(await actionsFor('Dal Makhani'))
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([
      t('menuEditor.items.edit'),
      t('menuEditor.items.availability'),
      t('menuEditor.items.archive'),
    ]);

    expect(
      screen.getByText(/^Version 3 is on every screen, published .+ at 14:00\.$/),
    ).toBeVisible();
    expect(screen.getByText(t('menuEditor.publish.changes'))).toBeVisible();
    await expectNoAxeViolations(container);
  });

  it('[MENU-011] searches by name, short code, tag or search word, and shows archived items', async () => {
    const fake = menuServer().on('POST', `/api/v1/menu/items/${IDS.oldSoup}/restore`, () => ({
      status: 200,
      body: item('oldSoup', 'Tomato Soup', { categoryId: IDS.starters }),
    }));
    const { user } = await renderConsole({ fake, path: '/manage/menu', signedIn: 'MANAGER' });
    await actionsFor('Paneer Tikka');
    await user.type(screen.getByRole('searchbox', { name: /^Search items/ }), 'panir');
    expect(await actionsFor('Paneer Tikka')).toBeVisible();
    expect(
      screen.queryByRole('group', { name: t('menuEditor.items.actionsFor', { name: 'Lassi' }) }),
    ).toBeNull();
    await user.clear(screen.getByRole('searchbox', { name: /^Search items/ }));
    await user.type(screen.getByRole('searchbox', { name: /^Search items/ }), 'pizza');
    expect(screen.getByText(t('menuEditor.items.noMatch', { query: 'pizza' }))).toBeVisible();
    await user.clear(screen.getByRole('searchbox', { name: /^Search items/ }));

    await user.click(screen.getByRole('checkbox', { name: t('menuEditor.items.showArchived') }));
    const soup = await rowOf('Tomato Soup');
    expect(soup.getByText(t('menuEditor.items.archived'))).toBeVisible();
    expect(screen.getByText(t('menuEditor.items.archivedCategory'))).toBeVisible();
    await user.click(soup.getByRole('button', { name: t('menuEditor.items.restore') }));
    expect(
      await screen.findByText(t('menuEditor.items.restoredToast', { name: 'Tomato Soup' })),
    ).toBeVisible();
    expect(fake.callsTo('POST', `/api/v1/menu/items/${IDS.oldSoup}/restore`)).toHaveLength(1);
  });

  it('[MENU-013] publishes the draft after asking, and then says everything is published', async () => {
    const fake = menuServer()
      .on(
        'GET',
        '/api/v1/menu/draft',
        () => ({ status: 200, body: menuDraft() }),
        () => ({
          status: 200,
          body: menuDraft({
            published: { version: 4, publishedAt: '2026-09-28T10:00:00.000Z' },
            unpublished: false,
          }),
        }),
      )
      .on('POST', '/api/v1/menu/publish', () => ({
        status: 200,
        body: {
          version: 4,
          publishedAt: '2026-09-28T10:00:00.000Z',
          checksum: 'abc',
          published: true,
        },
      }));
    const { user } = await renderConsole({ fake, path: '/manage/menu', signedIn: 'MANAGER' });
    await user.click(await screen.findByRole('button', { name: t('menuEditor.publish.button') }));
    const confirm = await screen.findByRole('dialog', {
      name: t('menuEditor.publish.confirmTitle'),
    });
    expect(within(confirm).getByText(t('menuEditor.publish.confirmDescription'))).toBeVisible();
    await user.click(
      within(confirm).getByRole('button', { name: t('menuEditor.publish.confirm') }),
    );
    expect(await screen.findByText(t('menuEditor.publish.done', { version: 4 }))).toBeVisible();
    expect(await screen.findByText(t('menuEditor.publish.upToDate'))).toBeVisible();
    expect(
      screen.getByText(/^Version 4 is on every screen, published .+ at 15:30\.$/),
    ).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/menu/publish')).toHaveLength(1);
  });

  it('[MENU-006] marks an item available again and counts what is left', async () => {
    const fake = menuServer().on('PUT', `/api/v1/menu/items/${IDS.lassi}/availability`, () => ({
      status: 200,
      body: { itemId: IDS.lassi, available: true, stockCount: 20 },
    }));
    const { user, container } = await renderConsole({
      fake,
      path: '/manage/menu',
      signedIn: 'MANAGER',
    });
    await user.click(
      within(await actionsFor('Lassi')).getByRole('button', {
        name: t('menuEditor.items.availability'),
      }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: t('menuEditor.availabilityDialog.title', { name: 'Lassi' }),
    });
    expect(
      within(dialog).getByRole('radio', { name: t('menuEditor.availabilityDialog.outOfStock') }),
    ).toBeChecked();
    await user.click(
      within(dialog).getByRole('radio', { name: t('menuEditor.availabilityDialog.available') }),
    );
    await user.click(
      within(dialog).getByRole('checkbox', { name: t('menuEditor.availabilityDialog.count') }),
    );
    const left = within(dialog).getByLabelText(
      new RegExp(`^${t('menuEditor.availabilityDialog.left')}`),
    );
    await user.type(left, 'many');
    await user.click(
      within(dialog).getByRole('button', { name: t('menuEditor.availabilityDialog.save') }),
    );
    expect(within(dialog).getByText(t('menuEditor.availabilityDialog.leftInvalid'))).toBeVisible();
    await expectNoAxeViolations(container);
    await user.clear(left);
    await user.type(left, '20');
    await user.click(
      within(dialog).getByRole('button', { name: t('menuEditor.availabilityDialog.save') }),
    );
    expect(
      await screen.findByText(t('menuEditor.availabilityDialog.saved', { name: 'Lassi' })),
    ).toBeVisible();
    expect(fake.callsTo('PUT', `/api/v1/menu/items/${IDS.lassi}/availability`)[0]?.body).toEqual({
      available: true,
      stockCount: 20,
    });
  });

  it('[MENU-010] archives an item with a reason', async () => {
    const fake = menuServer().on('POST', `/api/v1/menu/items/${IDS.chaas}/archive`, () => ({
      status: 200,
      body: item('chaas', 'Masala Chaas', { archivedAt: '2026-09-28T10:00:00.000Z' }),
    }));
    const { user } = await renderConsole({ fake, path: '/manage/menu', signedIn: 'MANAGER' });
    await user.click(
      within(await actionsFor('Masala Chaas')).getByRole('button', {
        name: t('menuEditor.items.archive'),
      }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: t('menuEditor.items.archiveDialog.title', { name: 'Masala Chaas' }),
    });
    await user.type(
      within(dialog).getByLabelText(new RegExp(`^${t('menuEditor.items.archiveDialog.reason')}`)),
      'Seasonal, back in summer',
    );
    await user.click(
      within(dialog).getByRole('button', { name: t('menuEditor.items.archiveDialog.confirm') }),
    );
    expect(
      await screen.findByText(t('menuEditor.items.archivedToast', { name: 'Masala Chaas' })),
    ).toBeVisible();
    expect(fake.callsTo('POST', `/api/v1/menu/items/${IDS.chaas}/archive`)[0]?.body).toEqual({
      reason: 'Seasonal, back in summer',
    });
  });

  it('[ORD-010] follows menu changes made on another screen', async () => {
    const fake = menuServer().on(
      'GET',
      '/api/v1/menu/draft',
      () => ({ status: 200, body: menuDraft() }),
      () => ({
        status: 200,
        body: menuDraft({
          items: [...menuDraft().items, item('lassi', 'Malai Kofta', { id: NEW_ITEM })],
        }),
      }),
    );
    const { sockets } = await renderConsole({ fake, path: '/manage/menu', signedIn: 'MANAGER' });
    await actionsFor('Dal Makhani');
    act(() => {
      sockets.sync(0);
      sockets.last.fire('event', menuEvent(1, 'MenuDraftChanged', { part: 'ITEMS' }));
    });
    expect(await actionsFor('Malai Kofta')).toBeVisible();
  });
});

describe('[MGR-005] the item page', () => {
  it('[MENU-002] [MENU-003] [MENU-004] [MENU-008] adds an item with sizes, a modifier group and a photo', async () => {
    const fake = menuServer()
      .on('POST', '/api/v1/photos', () => ({ status: 201, body: PHOTO }))
      .on('POST', '/api/v1/menu/items', (call) => ({
        status: 201,
        body: stored(NEW_ITEM, call.body),
      }));
    const { user, container } = await renderConsole({
      fake,
      path: '/manage/menu',
      signedIn: 'MANAGER',
    });
    await user.click(await screen.findByRole('button', { name: t('menuEditor.items.add') }));
    expect(
      await screen.findByRole('heading', { level: 2, name: t('menuEditor.editor.newTitle') }),
    ).toBeVisible();

    // Nothing is sent until the form is right, and veg or not is never guessed.
    await user.click(screen.getByRole('button', { name: t('menuEditor.editor.save') }));
    expect(await screen.findByText(t('menuEditor.editor.problems'))).toBeVisible();
    expect(screen.getByText(t('menuEditor.editor.nameProblem'))).toBeVisible();
    expect(screen.getByText(t('menuEditor.editor.foodTypeProblem'))).toBeVisible();
    expect(screen.getByText(t('menuEditor.editor.stationProblem'))).toBeVisible();
    expect(field(t('menuEditor.editor.name'))).toHaveFocus();
    await expectNoAxeViolations(container);

    await user.type(field(t('menuEditor.editor.name')), 'Shahi Paneer');
    await user.selectOptions(field(t('menuEditor.editor.category')), IDS.mains);
    await user.type(screen.getByLabelText(t('menuEditor.editor.description')), 'Rich tomato gravy');
    await user.click(screen.getByRole('radio', { name: t('pos.menu.foodType.VEG') }));
    await user.click(screen.getByRole('radio', { name: t('menuEditor.editor.spice.level1') }));
    // The only active tax group is chosen already; the archived one is not offered.
    expect(field(t('menuEditor.editor.taxGroup'))).toHaveValue(IDS.gst5);
    expect(screen.queryByRole('option', { name: 'Old VAT' })).toBeNull();
    await user.type(field(t('menuEditor.editor.basePrice')), '250');
    await user.click(screen.getByRole('button', { name: t('menuEditor.editor.addSize') }));
    await user.click(screen.getByRole('button', { name: t('menuEditor.editor.addSize') }));
    expect(field(t('menuEditor.editor.basePriceWithSizes'))).toHaveValue('250');
    await user.type(field(t('menuEditor.editor.sizeName', { number: 1 })), 'Half');
    await user.type(field(t('menuEditor.editor.sizePrice', { number: 1 })), '150');
    await user.type(field(t('menuEditor.editor.sizeName', { number: 2 })), 'Full');
    await user.type(field(t('menuEditor.editor.sizePrice', { number: 2 })), '250');
    await user.click(screen.getByRole('checkbox', { name: /^Roti type/ }));
    await user.selectOptions(field(t('menuEditor.editor.station')), IDS.kitchen);
    await user.type(field(t('menuEditor.editor.tags')), 'Bestseller, Jain');
    await user.type(field(t('menuEditor.editor.synonyms')), 'paneer masala');
    await user.click(
      screen.getByRole('checkbox', { name: t('menuEditor.editor.channel.TABLE_TABLET') }),
    );

    await user.upload(
      screen.getByLabelText(t('menuEditor.editor.photo')),
      new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'paneer.jpg', { type: 'image/jpeg' }),
    );
    const photo = await screen.findByRole('img', {
      name: t('menuEditor.editor.photoAlt', { name: 'Shahi Paneer' }),
    });
    expect(photo).toHaveAttribute('src', `http://pos.test/api/v1/photos/${IDS.photo}/480`);
    expect(fake.callsTo('POST', '/api/v1/photos')[0]?.body).toEqual({ contentBase64: '/9j/4A==' });

    await user.click(screen.getByRole('button', { name: t('menuEditor.editor.save') }));
    expect(
      await screen.findByText(t('menuEditor.editor.saved', { name: 'Shahi Paneer' })),
    ).toBeVisible();
    expect(
      await screen.findByRole('heading', { level: 2, name: t('menuEditor.items.title') }),
    ).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/menu/items')[0]?.body).toEqual({
      categoryId: IDS.mains,
      name: 'Shahi Paneer',
      shortCode: null,
      description: 'Rich tomato gravy',
      photoId: IDS.photo,
      basePrice: 25_000,
      taxGroupId: IDS.gst5,
      foodType: 'VEG',
      spiceLevel: 1,
      tags: ['Bestseller', 'Jain'],
      stationId: IDS.kitchen,
      prepTimeMinutes: null,
      displayOrder: 2,
      channels: ['POS', 'WAITER_APP', 'QR'],
      variants: [
        { name: 'Half', price: 15_000, externalId: null },
        { name: 'Full', price: 25_000, externalId: null },
      ],
      modifierGroupIds: [IDS.roti],
      synonyms: ['paneer masala'],
      repeatable: false,
      externalId: null,
    });
  });

  it('refuses a photo above 5 MB before uploading it', async () => {
    const fake = menuServer();
    const { user } = await renderConsole({
      fake,
      path: '/manage/menu/items/new',
      signedIn: 'MANAGER',
    });
    await screen.findByRole('heading', { level: 2, name: t('menuEditor.editor.newTitle') });
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'huge.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText(t('menuEditor.editor.photo')), big);
    expect(await screen.findByText(t('menuEditor.editor.photoTooLarge'))).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/photos')).toHaveLength(0);
  });

  it('[MENU-009] asks why a price changed and keeps the sizes orders refer to', async () => {
    const fake = menuServer().on('PUT', `/api/v1/menu/items/${IDS.paneerTikka}`, (call) => ({
      status: 200,
      body: stored(IDS.paneerTikka, call.body),
    }));
    const { user } = await renderConsole({ fake, path: '/manage/menu', signedIn: 'MANAGER' });
    await user.click(
      within(await actionsFor('Paneer Tikka')).getByRole('button', {
        name: t('menuEditor.items.edit'),
      }),
    );
    expect(
      await screen.findByRole('heading', {
        level: 2,
        name: t('menuEditor.editor.editTitle', { name: 'Paneer Tikka' }),
      }),
    ).toBeVisible();
    expect(screen.queryByLabelText(t('menuEditor.editor.reason'))).toBeNull();
    const halfPrice = field(t('menuEditor.editor.sizePrice', { number: 1 }));
    expect(halfPrice).toHaveValue('180.00');
    await user.clear(halfPrice);
    await user.type(halfPrice, '190');
    await user.type(screen.getByLabelText(t('menuEditor.editor.reason')), 'Paneer costs more');
    await user.click(screen.getByRole('button', { name: t('menuEditor.editor.save') }));
    expect(
      await screen.findByText(t('menuEditor.editor.saved', { name: 'Paneer Tikka' })),
    ).toBeVisible();
    expect(fake.callsTo('PUT', `/api/v1/menu/items/${IDS.paneerTikka}`)[0]?.body).toMatchObject({
      variants: [
        { id: IDS.half, name: 'Half', price: 19_000, externalId: 'POS-PT-H' },
        { id: IDS.full, name: 'Full', price: 32_000, externalId: null },
      ],
      reason: 'Paneer costs more',
    });
  });

  it('[MENU-005] changes a combo’s time window without saving the unchanged item', async () => {
    const fake = menuServer().on('PUT', `/api/v1/menu/items/${IDS.thali}/combo`, () => ({
      status: 200,
      body: { ...THALI_COMBO, timeWindow: { start: '11:00', end: '17:00' } },
    }));
    const { user } = await renderConsole({
      fake,
      path: `/manage/menu/items/${IDS.thali}`,
      signedIn: 'MANAGER',
    });
    const make = await screen.findByRole('checkbox', { name: t('menuEditor.combo.make') });
    expect(make).toBeChecked();
    expect(make).toBeDisabled();
    expect(screen.getByText(t('menuEditor.combo.archiveToStop'))).toBeVisible();
    expect(field(t('menuEditor.combo.item'))).toHaveValue(IDS.dalMakhani);
    expect(
      screen.getByRole('button', { name: t('menuEditor.combo.removeChoice', { name: 'Lassi' }) }),
    ).toBeVisible();
    const end = field(t('menuEditor.combo.end'));
    await user.clear(end);
    await user.type(end, '17:00');
    await user.click(screen.getByRole('button', { name: t('menuEditor.editor.save') }));
    expect(
      await screen.findByText(t('menuEditor.editor.saved', { name: 'Veg Thali' })),
    ).toBeVisible();
    expect(fake.callsTo('PUT', `/api/v1/menu/items/${IDS.thali}`)).toHaveLength(0);
    expect(fake.callsTo('PUT', `/api/v1/menu/items/${IDS.thali}/combo`)[0]?.body).toEqual({
      components: [
        { kind: 'FIXED', itemId: IDS.dalMakhani, quantity: 1 },
        { kind: 'CHOICE', label: 'Any 1 drink', itemIds: [IDS.lassi, IDS.chaas], quantity: 1 },
      ],
      activeFrom: null,
      activeUntil: null,
      timeWindow: { start: '11:00', end: '17:00' },
    });
  });

  it('[MENU-005] says when a part of a combo cannot be a combo itself', async () => {
    await renderConsole({
      fake: menuServer(),
      path: `/manage/menu/items/${IDS.lassi}`,
      signedIn: 'MANAGER',
    });
    expect(await screen.findByText(t('menuEditor.combo.partOfCombo'))).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: t('menuEditor.combo.make') })).toBeNull();
  });

  it('[MENU-005] keeps a new item saved without its combo, and sets the combo on the next save', async () => {
    const fake = menuServer()
      .on('POST', '/api/v1/menu/items', (call) => ({
        status: 201,
        body: stored(NEW_ITEM, call.body),
      }))
      .on(
        'PUT',
        `/api/v1/menu/items/${NEW_ITEM}/combo`,
        () => ({
          status: 422,
          body: { code: 'COMBO_COMPONENT_INVALID', message: 'Combo parts must be active items.' },
        }),
        () => ({
          status: 200,
          body: {
            itemId: NEW_ITEM,
            components: [
              { kind: 'FIXED', itemId: IDS.dalMakhani, label: null, itemIds: [], quantity: 1 },
            ],
            activeFrom: null,
            activeUntil: null,
            timeWindow: null,
          },
        }),
      );
    const { user } = await renderConsole({
      fake,
      path: '/manage/menu/items/new',
      signedIn: 'MANAGER',
    });
    await user.type(await screen.findByLabelText(/^Name/), 'Mini Meal');
    await user.selectOptions(field(t('menuEditor.editor.category')), IDS.mains);
    await user.click(screen.getByRole('radio', { name: t('pos.menu.foodType.VEG') }));
    await user.type(field(t('menuEditor.editor.basePrice')), '199');
    await user.selectOptions(field(t('menuEditor.editor.station')), IDS.kitchen);
    await user.click(screen.getByRole('checkbox', { name: t('menuEditor.combo.make') }));
    // The thali is a combo itself, so it cannot be bundled.
    expect(screen.queryByRole('option', { name: 'Veg Thali' })).toBeNull();
    await user.selectOptions(field(t('menuEditor.combo.item')), IDS.dalMakhani);
    await user.click(screen.getByRole('button', { name: t('menuEditor.editor.save') }));
    expect(
      await screen.findByText(
        t('menuEditor.combo.savedItemOnly', { message: 'Combo parts must be active items.' }),
      ),
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: t('menuEditor.editor.save') }));
    expect(
      await screen.findByText(t('menuEditor.editor.saved', { name: 'Mini Meal' })),
    ).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/menu/items')).toHaveLength(1);
    expect(fake.callsTo('PUT', `/api/v1/menu/items/${NEW_ITEM}/combo`)).toHaveLength(2);
    expect(fake.callsTo('PUT', `/api/v1/menu/items/${NEW_ITEM}/combo`)[1]?.body).toEqual({
      components: [{ kind: 'FIXED', itemId: IDS.dalMakhani, quantity: 1 }],
      activeFrom: null,
      activeUntil: null,
      timeWindow: null,
    });
  });

  it('[MENU-005] bundles a fixed item and a choice of drinks for festival dates and lunch hours', async () => {
    const fake = menuServer()
      .on('POST', '/api/v1/menu/items', (call) => ({
        status: 201,
        body: stored(NEW_ITEM, call.body),
      }))
      .on('PUT', `/api/v1/menu/items/${NEW_ITEM}/combo`, (call) => ({
        status: 200,
        body: {
          ...THALI_COMBO,
          itemId: NEW_ITEM,
          ...(call.body as Record<string, unknown>),
          components: THALI_COMBO.components,
        },
      }));
    const { user, container } = await renderConsole({
      fake,
      path: '/manage/menu/items/new',
      signedIn: 'MANAGER',
    });
    await user.type(await screen.findByLabelText(/^Name/), 'Diwali Thali');
    await user.selectOptions(field(t('menuEditor.editor.category')), IDS.mains);
    await user.click(screen.getByRole('radio', { name: t('pos.menu.foodType.VEG') }));
    await user.type(field(t('menuEditor.editor.basePrice')), '449');
    await user.selectOptions(field(t('menuEditor.editor.station')), IDS.kitchen);
    await user.click(screen.getByRole('checkbox', { name: t('menuEditor.combo.make') }));
    await user.selectOptions(field(t('menuEditor.combo.item')), IDS.dalMakhani);
    await user.click(screen.getByRole('button', { name: t('menuEditor.combo.addPart') }));
    const second = screen.getByRole('group', { name: t('menuEditor.combo.part', { number: 2 }) });
    await user.click(within(second).getByRole('radio', { name: t('menuEditor.combo.choice') }));
    await user.type(
      within(second).getByLabelText(new RegExp(`^${t('menuEditor.combo.label')}`)),
      'Any 1 drink',
    );
    const add = within(second).getByLabelText(new RegExp(`^${t('menuEditor.combo.addChoice')}`));
    await user.selectOptions(add, IDS.lassi);
    // One choice is not a choice.
    await user.click(screen.getByRole('button', { name: t('menuEditor.editor.save') }));
    expect(within(second).getByText(t('menuEditor.combo.choicesProblem'))).toBeVisible();
    await user.selectOptions(add, IDS.chaas);
    await user.selectOptions(add, IDS.paneerTikka);
    await user.click(
      within(second).getByRole('button', {
        name: t('menuEditor.combo.removeChoice', { name: 'Paneer Tikka' }),
      }),
    );
    await user.click(screen.getByRole('button', { name: t('menuEditor.combo.addPart') }));
    await user.click(
      screen.getByRole('button', { name: t('menuEditor.combo.removePart', { number: 3 }) }),
    );
    await user.type(field(t('menuEditor.combo.from')), '2026-10-20');
    await user.type(field(t('menuEditor.combo.until')), '2026-11-05');
    await user.type(field(t('menuEditor.combo.start')), '12:00');
    await user.type(field(t('menuEditor.combo.end')), '15:30');
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: t('menuEditor.editor.save') }));
    expect(
      await screen.findByText(t('menuEditor.editor.saved', { name: 'Diwali Thali' })),
    ).toBeVisible();
    expect(fake.callsTo('PUT', `/api/v1/menu/items/${NEW_ITEM}/combo`)[0]?.body).toEqual({
      components: [
        { kind: 'FIXED', itemId: IDS.dalMakhani, quantity: 1 },
        { kind: 'CHOICE', label: 'Any 1 drink', itemIds: [IDS.lassi, IDS.chaas], quantity: 1 },
      ],
      activeFrom: '2026-10-20',
      activeUntil: '2026-11-05',
      timeWindow: { start: '12:00', end: '15:30' },
    });
  });

  it('says when an item is not on the menu, or is archived', async () => {
    const { user } = await renderConsole({
      fake: menuServer(),
      path: `/manage/menu/items/${NEW_ITEM}`,
      signedIn: 'MANAGER',
    });
    expect(await screen.findByText(t('menuEditor.editor.notFound'))).toBeVisible();
    await user.click(screen.getByRole('button', { name: t('menuEditor.editor.back') }));
    expect(
      await screen.findByRole('heading', { level: 2, name: t('menuEditor.items.title') }),
    ).toBeVisible();
  });

  it('shows an archived item without its form', async () => {
    await renderConsole({
      fake: menuServer(),
      path: `/manage/menu/items/${IDS.oldSoup}`,
      signedIn: 'MANAGER',
    });
    expect(await screen.findByText(t('menuEditor.editor.archivedNotice'))).toBeVisible();
    expect(screen.queryByRole('button', { name: t('menuEditor.editor.save') })).toBeNull();
  });

  it('shows the server’s reason when saving fails', async () => {
    const fake = menuServer().on('PUT', `/api/v1/menu/items/${IDS.dalMakhani}`, () => ({
      status: 409,
      body: { code: 'SHORT_CODE_TAKEN', message: 'Another item already uses PT.' },
    }));
    const { user } = await renderConsole({
      fake,
      path: `/manage/menu/items/${IDS.dalMakhani}`,
      signedIn: 'MANAGER',
    });
    await user.type(await screen.findByLabelText(/^Short code/), 'PT');
    await user.click(screen.getByRole('button', { name: t('menuEditor.editor.save') }));
    expect(await screen.findByText('Another item already uses PT.')).toBeVisible();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: t('menuEditor.editor.save') })).toBeEnabled();
    });
  });
});
