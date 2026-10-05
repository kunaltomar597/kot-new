import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeServer } from './fake-server.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import { category, IDS, menuDraft, rotiType, stations, taxGroups } from './menu-fixture.js';

const NEW_ID = '0199a0e0-0000-7000-8000-000000000398';

function menuServer(): FakeServer {
  return signsInAs(server(), 'MANAGER')
    .on('GET', '/api/v1/menu/draft', () => ({ status: 200, body: menuDraft() }))
    .on('GET', '/api/v1/tax-groups', () => ({ status: 200, body: { taxGroups: taxGroups() } }))
    .on('GET', '/api/v1/stations', () => ({ status: 200, body: { stations: stations() } }));
}

const pages = () => screen.getByRole('navigation', { name: t('menuEditor.pages.label') });
const rowOf = async (actionsFor: string) => {
  const group = await screen.findByRole('group', { name: actionsFor });
  const row = group.closest('li');
  if (row === null) throw new Error(`No row for ${actionsFor}`);
  return within(row);
};
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const labelled = (box: HTMLElement, label: string) =>
  within(box).getByLabelText(new RegExp(`^${escape(label)}`));

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[MENU-001] the categories page', () => {
  it('lists categories with their sub-categories, item counts and places', async () => {
    const { user, container } = await renderConsole({
      fake: menuServer(),
      path: '/manage/menu',
      signedIn: 'MANAGER',
    });
    await user.click(
      within(await screenPages()).getByRole('link', { name: t('menuEditor.pages.categories') }),
    );
    expect(
      await screen.findByRole('heading', { level: 2, name: t('menuEditor.categories.title') }),
    ).toBeVisible();
    const veg = await rowOf(t('menuEditor.categories.actionsFor', { name: 'Veg starters' }));
    expect(veg.getByText(t('menuEditor.categories.sub', { name: 'Starters' }))).toBeVisible();
    expect(veg.getByText(t('menuEditor.categories.items', { count: 2 }))).toBeVisible();
    const starters = await rowOf(t('menuEditor.categories.actionsFor', { name: 'Starters' }));
    expect(starters.getByText(t('menuEditor.categories.items', { count: 0 }))).toBeVisible();
    expect(starters.getByText(t('menuEditor.categories.place', { order: 1 }))).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Festive' })).toBeNull();
    await user.click(
      screen.getByRole('checkbox', { name: t('menuEditor.categories.showArchived') }),
    );
    const festive = await rowOf(t('menuEditor.categories.actionsFor', { name: 'Festive' }));
    expect(festive.getByRole('button', { name: t('menuEditor.categories.restore') })).toBeVisible();
    await expectNoAxeViolations(container);
  });

  it('adds a category after the others, and a sub-category under a top-level one', async () => {
    const fake = menuServer().on('POST', '/api/v1/menu/categories', (call) => ({
      status: 201,
      body: category('festive', (call.body as { name: string }).name, { id: NEW_ID }),
    }));
    const { user } = await renderConsole({
      fake,
      path: '/manage/menu/categories',
      signedIn: 'MANAGER',
    });
    await user.click(await screen.findByRole('button', { name: t('menuEditor.categories.add') }));
    let dialog = await screen.findByRole('dialog', {
      name: t('menuEditor.categories.dialog.addTitle'),
    });
    await user.click(
      within(dialog).getByRole('button', { name: t('menuEditor.categories.dialog.save') }),
    );
    expect(within(dialog).getByText(t('menuEditor.categories.dialog.nameProblem'))).toBeVisible();
    await user.type(labelled(dialog, t('menuEditor.categories.dialog.name')), 'Desserts');
    await user.click(
      within(dialog).getByRole('button', { name: t('menuEditor.categories.dialog.save') }),
    );
    expect(
      await screen.findByText(t('menuEditor.categories.saved', { name: 'Desserts' })),
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: t('menuEditor.categories.add') }));
    dialog = await screen.findByRole('dialog', {
      name: t('menuEditor.categories.dialog.addTitle'),
    });
    await user.type(labelled(dialog, t('menuEditor.categories.dialog.name')), 'Tandoor');
    const parent = labelled(dialog, t('menuEditor.categories.dialog.parent'));
    // Only active top-level categories can hold sub-categories.
    expect(
      within(parent)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([t('menuEditor.categories.dialog.topLevel'), 'Starters', 'Mains', 'Drinks']);
    await user.selectOptions(parent, IDS.starters);
    await user.click(
      within(dialog).getByRole('button', { name: t('menuEditor.categories.dialog.save') }),
    );
    await screen.findByText(t('menuEditor.categories.saved', { name: 'Tandoor' }));
    expect(fake.callsTo('POST', '/api/v1/menu/categories').map((call) => call.body)).toEqual([
      { name: 'Desserts', parentId: null, displayOrder: 4 },
      { name: 'Tandoor', parentId: IDS.starters, displayOrder: 2 },
    ]);
  });

  it('keeps a category with sub-categories at the top level when editing it', async () => {
    const fake = menuServer().on('PUT', `/api/v1/menu/categories/${IDS.starters}`, () => ({
      status: 200,
      body: category('starters', 'Small plates', { displayOrder: 1 }),
    }));
    const { user } = await renderConsole({
      fake,
      path: '/manage/menu/categories',
      signedIn: 'MANAGER',
    });
    const starters = await rowOf(t('menuEditor.categories.actionsFor', { name: 'Starters' }));
    await user.click(starters.getByRole('button', { name: t('menuEditor.categories.edit') }));
    const dialog = await screen.findByRole('dialog', {
      name: t('menuEditor.categories.dialog.editTitle', { name: 'Starters' }),
    });
    expect(
      within(dialog).getByText(t('menuEditor.categories.dialog.hasSubcategories')),
    ).toBeVisible();
    const name = labelled(dialog, t('menuEditor.categories.dialog.name'));
    await user.clear(name);
    await user.type(name, 'Small plates');
    await user.click(
      within(dialog).getByRole('button', { name: t('menuEditor.categories.dialog.save') }),
    );
    await screen.findByText(t('menuEditor.categories.saved', { name: 'Small plates' }));
    expect(fake.callsTo('PUT', `/api/v1/menu/categories/${IDS.starters}`)[0]?.body).toEqual({
      name: 'Small plates',
      parentId: null,
      displayOrder: 1,
    });
  });

  it('[MENU-010] says why a category with items cannot be archived', async () => {
    const fake = menuServer().on('POST', `/api/v1/menu/categories/${IDS.drinks}/archive`, () => ({
      status: 409,
      body: { code: 'CATEGORY_NOT_EMPTY', message: 'Move or archive its items first.' },
    }));
    const { user } = await renderConsole({
      fake,
      path: '/manage/menu/categories',
      signedIn: 'MANAGER',
    });
    const drinks = await rowOf(t('menuEditor.categories.actionsFor', { name: 'Drinks' }));
    await user.click(drinks.getByRole('button', { name: t('menuEditor.categories.archive') }));
    const dialog = await screen.findByRole('dialog', {
      name: t('menuEditor.categories.archiveDialog.title', { name: 'Drinks' }),
    });
    await user.type(
      labelled(dialog, t('menuEditor.categories.archiveDialog.reason')),
      'Drinks move to the bar menu',
    );
    await user.click(
      within(dialog).getByRole('button', {
        name: t('menuEditor.categories.archiveDialog.confirm'),
      }),
    );
    expect(await within(dialog).findByText('Move or archive its items first.')).toBeVisible();
  });
});

describe('[MENU-004] the modifier groups page', () => {
  it('lists each group with its rule, options, price changes and the items offering it', async () => {
    const { container } = await renderConsole({
      fake: menuServer(),
      path: '/manage/menu/modifiers',
      signedIn: 'MANAGER',
    });
    expect(
      await screen.findByRole('heading', { level: 2, name: t('menuEditor.modifiers.title') }),
    ).toBeVisible();
    const roti = await rowOf(t('menuEditor.modifiers.actionsFor', { name: 'Roti type' }));
    expect(roti.getByText(t('pos.item.ruleExactly', { count: 1 }))).toBeVisible();
    expect(roti.getByText(t('menuEditor.modifiers.usedBy', { count: 1 }))).toBeVisible();
    expect(roti.getByText('+₹10.00')).toBeVisible();
    expect(roti.getByText(t('menuEditor.modifiers.unavailable', { name: 'Garlic' }))).toBeVisible();
    const addOns = await rowOf(t('menuEditor.modifiers.actionsFor', { name: 'Add-ons' }));
    expect(addOns.getByText(t('pos.item.ruleOptional', { max: 2 }))).toBeVisible();
    expect(addOns.getByText(t('menuEditor.modifiers.usedBy', { count: 0 }))).toBeVisible();
    expect(screen.queryByText('Old sauces')).toBeNull();
    await expectNoAxeViolations(container);
  });

  it('adds a group with options and price changes, checking the counts first', async () => {
    const fake = menuServer().on('POST', '/api/v1/menu/modifier-groups', () => ({
      status: 201,
      body: rotiType({ id: NEW_ID, name: 'Spice level', itemCount: 0 }),
    }));
    const { user } = await renderConsole({
      fake,
      path: '/manage/menu/modifiers',
      signedIn: 'MANAGER',
    });
    await user.click(await screen.findByRole('button', { name: t('menuEditor.modifiers.add') }));
    const dialog = await screen.findByRole('dialog', {
      name: t('menuEditor.modifiers.dialog.addTitle'),
    });
    await user.type(labelled(dialog, t('menuEditor.modifiers.dialog.name')), 'Spice level');
    const min = labelled(dialog, t('menuEditor.modifiers.dialog.min'));
    await user.clear(min);
    await user.type(min, '2');
    await user.type(
      within(dialog).getByLabelText(t('menuEditor.modifiers.dialog.optionName', { number: 1 })),
      'Mild',
    );
    await user.click(
      within(dialog).getByRole('button', { name: t('menuEditor.modifiers.dialog.save') }),
    );
    expect(within(dialog).getByText(t('menuEditor.modifiers.dialog.countProblem'))).toBeVisible();
    await user.clear(min);
    await user.type(min, '1');
    await user.click(
      within(dialog).getByRole('button', { name: t('menuEditor.modifiers.dialog.addOption') }),
    );
    await user.type(
      within(dialog).getByLabelText(t('menuEditor.modifiers.dialog.optionName', { number: 2 })),
      'Extra hot',
    );
    await user.type(
      labelled(dialog, t('menuEditor.modifiers.dialog.optionPrice', { number: 2 })),
      '-5',
    );
    await user.click(
      within(dialog).getByRole('checkbox', {
        name: t('menuEditor.modifiers.dialog.optionAvailable', { number: 2 }),
      }),
    );
    await user.click(
      within(dialog).getByRole('button', { name: t('menuEditor.modifiers.dialog.save') }),
    );
    expect(
      await screen.findByText(t('menuEditor.modifiers.saved', { name: 'Spice level' })),
    ).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/menu/modifier-groups')[0]?.body).toEqual({
      name: 'Spice level',
      minSelections: 1,
      maxSelections: 1,
      options: [
        { name: 'Mild', priceDelta: 0, available: true },
        { name: 'Extra hot', priceDelta: -500, available: false },
      ],
    });
  });

  it('edits a group, keeping its options and archiving the one left out', async () => {
    const fake = menuServer().on('PUT', `/api/v1/menu/modifier-groups/${IDS.roti}`, () => ({
      status: 200,
      body: rotiType(),
    }));
    const { user } = await renderConsole({
      fake,
      path: '/manage/menu/modifiers',
      signedIn: 'MANAGER',
    });
    const roti = await rowOf(t('menuEditor.modifiers.actionsFor', { name: 'Roti type' }));
    await user.click(roti.getByRole('button', { name: t('menuEditor.modifiers.edit') }));
    const dialog = await screen.findByRole('dialog', {
      name: t('menuEditor.modifiers.dialog.editTitle', { name: 'Roti type' }),
    });
    await user.click(
      within(dialog).getByRole('button', {
        name: t('menuEditor.modifiers.dialog.removeOption', { number: 3 }),
      }),
    );
    await user.click(
      within(dialog).getByRole('button', { name: t('menuEditor.modifiers.dialog.save') }),
    );
    await screen.findByText(t('menuEditor.modifiers.saved', { name: 'Roti type' }));
    expect(fake.callsTo('PUT', `/api/v1/menu/modifier-groups/${IDS.roti}`)[0]?.body).toEqual({
      name: 'Roti type',
      minSelections: 1,
      maxSelections: 1,
      options: [
        { id: IDS.plain, name: 'Plain', priceDelta: 0, available: true },
        { id: IDS.butter, name: 'Butter', priceDelta: 1_000, available: true },
      ],
    });
  });

  it('archives a group with a reason and restores an archived one', async () => {
    const fake = menuServer()
      .on('POST', `/api/v1/menu/modifier-groups/${IDS.addOns}/archive`, () => ({
        status: 200,
        body: rotiType({ id: IDS.addOns, name: 'Add-ons', archivedAt: '2026-09-28T10:00:00.000Z' }),
      }))
      .on('POST', `/api/v1/menu/modifier-groups/${IDS.oldGroup}/restore`, () => ({
        status: 200,
        body: rotiType({ id: IDS.oldGroup, name: 'Old sauces' }),
      }));
    const { user } = await renderConsole({
      fake,
      path: '/manage/menu/modifiers',
      signedIn: 'MANAGER',
    });
    const addOns = await rowOf(t('menuEditor.modifiers.actionsFor', { name: 'Add-ons' }));
    await user.click(addOns.getByRole('button', { name: t('menuEditor.modifiers.archive') }));
    const dialog = await screen.findByRole('dialog', {
      name: t('menuEditor.modifiers.archiveDialog.title', { name: 'Add-ons' }),
    });
    await user.type(labelled(dialog, t('menuEditor.modifiers.archiveDialog.reason')), 'Not used');
    await user.click(
      within(dialog).getByRole('button', { name: t('menuEditor.modifiers.archiveDialog.confirm') }),
    );
    await screen.findByText(t('menuEditor.modifiers.archivedToast', { name: 'Add-ons' }));

    await user.click(
      screen.getByRole('checkbox', { name: t('menuEditor.modifiers.showArchived') }),
    );
    const old = await rowOf(t('menuEditor.modifiers.actionsFor', { name: 'Old sauces' }));
    await user.click(old.getByRole('button', { name: t('menuEditor.modifiers.restore') }));
    await screen.findByText(t('menuEditor.modifiers.restoredToast', { name: 'Old sauces' }));
    expect(
      fake.callsTo('POST', `/api/v1/menu/modifier-groups/${IDS.addOns}/archive`)[0]?.body,
    ).toEqual({ reason: 'Not used' });
    expect(
      fake.callsTo('POST', `/api/v1/menu/modifier-groups/${IDS.oldGroup}/restore`),
    ).toHaveLength(1);
  });
});

async function screenPages(): Promise<HTMLElement> {
  await screen.findByRole('heading', { level: 2, name: t('menuEditor.items.title') });
  return pages();
}
