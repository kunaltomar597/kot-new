import type { FloorResponse, SectionView, TableView } from '@rp/contracts';
import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeResponse, FakeServer } from './fake-server.js';
import { login } from './fakes.js';
import {
  floor,
  MAIN,
  NEW_SECTION,
  NEW_TABLE,
  ROOF,
  section,
  table,
  TABLE_1,
  TABLE_2,
  TABLE_3,
  TABLE_R1,
  TERRACE,
} from './floor-fixture.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import { changed } from './sections-fixture.js';

const PATH = '/manage/settings/floor';
const FLOOR = '/api/v1/floor';

/** Answers the floor with each of `floors` in turn, then the last one from then on. */
function floorServer(...floors: FloorResponse[]): FakeServer {
  const answers = (floors.length === 0 ? [floor()] : floors).map((body) => (): FakeResponse => ({
    status: 200,
    body,
  }));
  return signsInAs(server(), 'MANAGER').on('GET', FLOOR, ...answers);
}

/** The fixture floor with one section's tables changed. */
function floorWith(
  sectionId: string,
  tables: (current: TableView[]) => TableView[],
): FloorResponse {
  return {
    sections: floor().sections.map((entry) =>
      entry.id === sectionId ? { ...entry, tables: tables(entry.tables) } : entry,
    ),
  };
}

const refusal = (status: number, code: string, message: string): FakeResponse => ({
  status,
  body: { code, message },
});

const sectionActions = (name: string) =>
  screen.findByRole('group', { name: t('floor.section.actionsFor', { name }) });
const tableActions = (label: string) =>
  screen.findByRole('group', { name: t('floor.table.actionsFor', { table: label }) });
const sectionOf = async (name: string) => (await sectionActions(name)).closest('section')!;
/** A section's name and facts, without its tables. */
const headerOf = async (name: string) =>
  within(await sectionOf(name)).getByRole('heading', { level: 3 }).parentElement!;
const tableRowOf = async (label: string) =>
  (await tableActions(label)).closest('li') as HTMLElement;
const buttonsOf = (group: HTMLElement) =>
  within(group)
    .getAllByRole('button')
    .map((button) => button.textContent);
const clickIn = async (group: Promise<HTMLElement>, name: string) => {
  (await group).querySelectorAll('button').forEach((button) => {
    if (button.textContent === name) button.click();
  });
  await act(() => Promise.resolve());
};
const fieldIn = (dialog: HTMLElement, label: string) =>
  within(dialog).getByRole('textbox', { name: label });
const saveIn = (dialog: HTMLElement) =>
  within(dialog).getByRole('button', { name: t('settings.dialog.save') });

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[TBL-001] the Floor page', () => {
  it('lists the sections in order with their tables, seats, state and tablet', async () => {
    const { container, user } = await renderConsole({
      fake: floorServer(),
      path: PATH,
      signedIn: 'MANAGER',
    });
    expect(await screen.findByRole('heading', { level: 2, name: t('floor.title') })).toBeVisible();
    const main = await sectionOf('Main Hall');
    expect(
      screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(['Main Hall', 'Terrace']);
    // The tables in use and their seats; the archived table 3 counts for nothing.
    const mainHeader = within(await headerOf('Main Hall'));
    expect(mainHeader.getByText(t('floor.section.tables', { count: 2 }))).toBeVisible();
    expect(mainHeader.getByText(t('floor.section.seats', { count: 10 }))).toBeVisible();
    expect(mainHeader.getByText(t('floor.section.place', { order: 1 }))).toBeVisible();
    expect(
      within(main)
        .getAllByRole('heading', { level: 4 })
        .map((heading) => heading.textContent),
    ).toEqual([t('floor.table.name', { table: '1' }), t('floor.table.name', { table: '2' })]);

    const two = await tableRowOf('2');
    expect(within(two).getByText(t('floor.table.seats', { count: 6 }))).toBeVisible();
    expect(within(two).getByText(t('floor.table.place', { order: 2 }))).toBeVisible();
    expect(within(two).getByText(t('pos.tableState.OCCUPIED'))).toBeVisible();
    expect(within(two).getByText(t('floor.table.tablet'))).toBeVisible();
    const one = await tableRowOf('1');
    expect(within(one).getByText(t('pos.tableState.FREE'))).toBeVisible();
    expect(within(one).queryByText(t('floor.table.tablet'))).toBeNull();

    expect(buttonsOf(await sectionActions('Main Hall'))).toEqual([
      t('floor.section.addTable'),
      t('floor.section.edit'),
      t('floor.section.archive'),
    ]);
    expect(buttonsOf(await tableActions('1'))).toEqual([
      t('floor.table.edit'),
      t('floor.table.archive'),
    ]);
    // Archived sections and tables stay out of the way until asked for.
    expect(screen.queryByText('Roof')).toBeNull();
    expect(
      screen.queryByRole('group', { name: t('floor.table.actionsFor', { table: '3' }) }),
    ).toBeNull();
    await expectNoAxeViolations(container);

    await user.click(screen.getByRole('checkbox', { name: t('floor.showArchived') }));
    const roof = within(await headerOf('Roof'));
    expect(roof.getByText(t('floor.section.archived'))).toBeVisible();
    // No table in use there: no count, only its place; its archived table is listed below.
    expect(roof.getByRole('heading', { level: 3 }).nextElementSibling?.textContent).toBe(
      t('floor.section.place', { order: 3 }),
    );
    expect(buttonsOf(await sectionActions('Roof'))).toEqual([t('floor.section.restore')]);
    const three = await tableRowOf('3');
    expect(within(three).getByText(t('floor.table.archived'))).toBeVisible();
    expect(within(three).queryByText(t('pos.tableState.FREE'))).toBeNull();
    expect(buttonsOf(await tableActions('3'))).toEqual([t('floor.table.restore')]);
    expect(buttonsOf(await tableActions('R1'))).toEqual([t('floor.table.restore')]);
    // Still counting only the tables in use.
    expect(mainHeader.getByText(t('floor.section.tables', { count: 2 }))).toBeVisible();
    await expectNoAxeViolations(container);
  });

  it('[ONB-004] adds a section after the others, checking its name first', async () => {
    const garden = section({ id: NEW_SECTION, name: 'Garden', displayOrder: 4 });
    const fake = floorServer(floor(), { sections: [...floor().sections, garden] }).on(
      'POST',
      '/api/v1/sections',
      () => ({ status: 201, body: garden }),
    );
    const { container, user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await sectionOf('Main Hall');
    await user.click(screen.getByRole('button', { name: t('floor.addSection') }));
    const dialog = await screen.findByRole('dialog', { name: t('floor.sectionDialog.addTitle') });
    // After every section, the archived roof included.
    expect(fieldIn(dialog, t('floor.sectionDialog.place'))).toHaveValue('4');
    await expectNoAxeViolations(container);

    await user.click(saveIn(dialog));
    expect(within(dialog).getByText(t('floor.sectionDialog.problems.nameRequired'))).toBeVisible();
    const name = fieldIn(dialog, t('floor.sectionDialog.name'));
    await user.type(name, ' terrace ');
    expect(within(dialog).getByText(t('floor.sectionDialog.problems.nameTaken'))).toBeVisible();
    await user.clear(name);
    await user.type(name, 'Garden');
    expect(within(dialog).queryByText(t('floor.sectionDialog.problems.nameTaken'))).toBeNull();
    await user.click(saveIn(dialog));

    expect(
      await screen.findByText(t('floor.sectionDialog.saved', { name: 'Garden' })),
    ).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/sections').map((call) => call.body)).toEqual([
      { name: 'Garden', displayOrder: 4 },
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
    // Read again, with the new section and its hint.
    expect(within(await sectionOf('Garden')).getByText(t('floor.section.noTables'))).toBeVisible();
  });

  it('renames a section, and shows the server’s refusal in the dialog', async () => {
    const fake = floorServer().on(
      'PUT',
      `/api/v1/sections/${TERRACE}`,
      () =>
        refusal(
          409,
          'SECTION_NAME_TAKEN',
          'Another section is called "Garden". Choose another name.',
        ),
      () => ({
        status: 200,
        body: section({ id: TERRACE, name: 'Garden Terrace', displayOrder: 2 }),
      }),
    );
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await clickIn(sectionActions('Terrace'), t('floor.section.edit'));
    const dialog = await screen.findByRole('dialog', {
      name: t('floor.sectionDialog.editTitle', { name: 'Terrace' }),
    });
    const name = fieldIn(dialog, t('floor.sectionDialog.name'));
    expect(name).toHaveValue('Terrace');
    expect(fieldIn(dialog, t('floor.sectionDialog.place'))).toHaveValue('2');
    await user.clear(name);
    await user.type(name, 'Garden');
    await user.click(saveIn(dialog));
    // Another manager took the name meanwhile: the server says so and the dialog stays.
    expect(
      await within(dialog).findByText('Another section is called "Garden". Choose another name.'),
    ).toBeVisible();
    await user.type(name, ' Terrace');
    await user.click(saveIn(dialog));
    expect(
      await screen.findByText(t('floor.sectionDialog.saved', { name: 'Garden Terrace' })),
    ).toBeVisible();
    expect(fake.callsTo('PUT', `/api/v1/sections/${TERRACE}`).map((call) => call.body)).toEqual([
      { name: 'Garden', displayOrder: 2 },
      { name: 'Garden Terrace', displayOrder: 2 },
    ]);
  });

  it('[ONB-004] adds a table to a section, after its tables, with a label no table has', async () => {
    const t3 = table({
      id: NEW_TABLE,
      label: 'T3',
      capacity: 2,
      sectionId: TERRACE,
      displayOrder: 2,
    });
    const fake = floorServer(
      floor(),
      floorWith(TERRACE, (tables) => [...tables, t3]),
    ).on(
      'POST',
      '/api/v1/tables',
      () =>
        refusal(409, 'TABLE_LABEL_TAKEN', 'Another table is labelled "T2". Choose another label.'),
      () => ({ status: 201, body: t3 }),
    );
    const { container, user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await clickIn(sectionActions('Terrace'), t('floor.section.addTable'));
    const dialog = await screen.findByRole('dialog', { name: t('floor.tableDialog.addTitle') });
    const sectionChoice = within(dialog).getByRole('combobox', {
      name: t('floor.tableDialog.section'),
    });
    const place = fieldIn(dialog, t('floor.tableDialog.place'));
    expect(sectionChoice).toHaveValue(TERRACE);
    expect(fieldIn(dialog, t('floor.tableDialog.capacity'))).toHaveValue('4');
    expect(place).toHaveValue('2');
    // Only active sections are offered.
    expect(
      within(sectionChoice)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Main Hall', 'Terrace']);
    // In another section it goes last there, until a place is typed.
    await user.selectOptions(sectionChoice, MAIN);
    expect(place).toHaveValue('4');
    await user.selectOptions(sectionChoice, TERRACE);
    expect(place).toHaveValue('2');
    await expectNoAxeViolations(container);

    const label = fieldIn(dialog, t('floor.tableDialog.label'));
    await user.type(label, 't1');
    await user.click(saveIn(dialog));
    expect(within(dialog).getByText(t('floor.tableDialog.problems.labelTaken'))).toBeVisible();
    await user.clear(label);
    await user.type(label, '3');
    expect(within(dialog).getByText(t('floor.tableDialog.problems.labelArchived'))).toBeVisible();
    const capacity = fieldIn(dialog, t('floor.tableDialog.capacity'));
    await user.clear(capacity);
    await user.type(capacity, '0');
    expect(within(dialog).getByText(t('floor.tableDialog.problems.capacity'))).toBeVisible();
    await user.clear(capacity);
    await user.type(capacity, '2');
    await user.clear(label);
    await user.type(label, 'T2');
    await user.click(saveIn(dialog));
    // Someone added T2 meanwhile: the server's words, in the dialog.
    expect(
      await within(dialog).findByText('Another table is labelled "T2". Choose another label.'),
    ).toBeVisible();
    await user.clear(label);
    await user.type(label, 'T3');
    await user.click(saveIn(dialog));

    expect(await screen.findByText(t('floor.tableDialog.saved', { table: 'T3' }))).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/tables').map((call) => call.body)).toEqual([
      { label: 'T2', capacity: 2, sectionId: TERRACE, displayOrder: 2 },
      { label: 'T3', capacity: 2, sectionId: TERRACE, displayOrder: 2 },
    ]);
    expect(
      within(await tableRowOf('T3')).getByText(t('floor.table.seats', { count: 2 })),
    ).toBeVisible();
  });

  it('changes a table’s seats, section and place', async () => {
    const moved = table({
      id: TABLE_1,
      label: '1',
      capacity: 5,
      sectionId: TERRACE,
      displayOrder: 3,
    });
    const fake = floorServer().on('PUT', `/api/v1/tables/${TABLE_1}`, () => ({
      status: 200,
      body: moved,
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await clickIn(tableActions('1'), t('floor.table.edit'));
    const dialog = await screen.findByRole('dialog', {
      name: t('floor.tableDialog.editTitle', { table: '1' }),
    });
    expect(fieldIn(dialog, t('floor.tableDialog.label'))).toHaveValue('1');
    const capacity = fieldIn(dialog, t('floor.tableDialog.capacity'));
    const place = fieldIn(dialog, t('floor.tableDialog.place'));
    expect(capacity).toHaveValue('4');
    expect(place).toHaveValue('1');
    const sectionChoice = within(dialog).getByRole('combobox', {
      name: t('floor.tableDialog.section'),
    });
    expect(sectionChoice).toHaveValue(MAIN);
    // A table that moves keeps its place until another is typed.
    await user.selectOptions(sectionChoice, TERRACE);
    expect(place).toHaveValue('1');
    await user.clear(capacity);
    await user.type(capacity, '5');
    await user.clear(place);
    await user.type(place, '3');
    await user.click(saveIn(dialog));
    expect(await screen.findByText(t('floor.tableDialog.saved', { table: '1' }))).toBeVisible();
    expect(fake.callsTo('PUT', `/api/v1/tables/${TABLE_1}`).map((call) => call.body)).toEqual([
      { label: '1', capacity: 5, sectionId: TERRACE, displayOrder: 3 },
    ]);
  });

  it('[AUD-001] archives a table or a section with a reason, and says why the server refuses', async () => {
    const archivedOne = table({
      id: TABLE_1,
      label: '1',
      displayOrder: 1,
      archivedAt: '2026-09-27T05:00:00.000Z',
    });
    const fake = floorServer(
      floor(),
      floorWith(MAIN, (tables) =>
        tables.map((entry) => (entry.id === TABLE_1 ? archivedOne : entry)),
      ),
    )
      .on('POST', `/api/v1/tables/${TABLE_2}/archive`, () =>
        refusal(
          409,
          'TABLE_IN_USE',
          'Guests are seated at this table. Close it before archiving it.',
        ),
      )
      .on('POST', `/api/v1/tables/${TABLE_1}/archive`, () => ({ status: 200, body: archivedOne }))
      .on('POST', `/api/v1/sections/${TERRACE}/archive`, () =>
        refusal(
          409,
          'SECTION_NOT_EMPTY',
          'The section still has a table. Move or archive it first.',
        ),
      );
    const { container, user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });

    await clickIn(tableActions('2'), t('floor.table.archive'));
    let dialog = await screen.findByRole('dialog', {
      name: t('floor.archiveTable.title', { table: '2' }),
    });
    const confirm = () =>
      within(dialog).getByRole('button', { name: t('floor.archiveTable.confirm') });
    // A reason is required (AUD-001).
    expect(confirm()).toBeDisabled();
    await user.type(
      within(dialog).getByRole('textbox', { name: t('floor.archiveTable.reason') }),
      'Broken leg',
    );
    await expectNoAxeViolations(container);
    await user.click(confirm());
    expect(
      await within(dialog).findByText(
        'Guests are seated at this table. Close it before archiving it.',
      ),
    ).toBeVisible();
    expect(fake.callsTo('POST', `/api/v1/tables/${TABLE_2}/archive`)[0]?.body).toEqual({
      reason: 'Broken leg',
    });
    await user.click(within(dialog).getByRole('button', { name: t('ui.dialog.close') }));
    expect(screen.queryByRole('dialog')).toBeNull();

    await clickIn(tableActions('1'), t('floor.table.archive'));
    dialog = await screen.findByRole('dialog', {
      name: t('floor.archiveTable.title', { table: '1' }),
    });
    await user.type(
      within(dialog).getByRole('textbox', { name: t('floor.archiveTable.reason') }),
      'Moved to the terrace',
    );
    await user.click(confirm());
    expect(await screen.findByText(t('floor.tableArchived', { table: '1' }))).toBeVisible();
    // Read again: table 1 is gone from the list.
    expect(
      await within(await headerOf('Main Hall')).findByText(t('floor.section.tables', { count: 1 })),
    ).toBeVisible();
    expect(
      screen.queryByRole('group', { name: t('floor.table.actionsFor', { table: '1' }) }),
    ).toBeNull();

    await clickIn(sectionActions('Terrace'), t('floor.section.archive'));
    dialog = await screen.findByRole('dialog', {
      name: t('floor.archiveSection.title', { name: 'Terrace' }),
    });
    await user.type(
      within(dialog).getByRole('textbox', { name: t('floor.archiveSection.reason') }),
      'Monsoon',
    );
    await user.click(
      within(dialog).getByRole('button', { name: t('floor.archiveSection.confirm') }),
    );
    expect(
      await within(dialog).findByText('The section still has a table. Move or archive it first.'),
    ).toBeVisible();
  });

  it('restores an archived section and table, and says why when the server refuses', async () => {
    const restoredRoof: SectionView = { ...floor().sections[2]!, archivedAt: null };
    const fake = floorServer(floor(), {
      sections: floor().sections.map((entry) => (entry.id === ROOF ? restoredRoof : entry)),
    })
      .on('POST', `/api/v1/tables/${TABLE_R1}/restore`, () =>
        refusal(
          409,
          'SECTION_ARCHIVED',
          "The table's section is archived. Restore the section first.",
        ),
      )
      .on('POST', `/api/v1/sections/${ROOF}/restore`, () => ({
        status: 200,
        body: restoredRoof,
      }))
      .on('POST', `/api/v1/tables/${TABLE_3}/restore`, () => ({
        status: 200,
        body: table({ id: TABLE_3, label: '3', capacity: 2, displayOrder: 3 }),
      }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await sectionOf('Main Hall');
    await user.click(screen.getByRole('checkbox', { name: t('floor.showArchived') }));

    await clickIn(tableActions('R1'), t('floor.table.restore'));
    expect(
      await screen.findByText("The table's section is archived. Restore the section first."),
    ).toBeVisible();
    await clickIn(sectionActions('Roof'), t('floor.section.restore'));
    expect(await screen.findByText(t('floor.sectionRestored', { name: 'Roof' }))).toBeVisible();
    await clickIn(tableActions('3'), t('floor.table.restore'));
    expect(await screen.findByText(t('floor.tableRestored', { table: '3' }))).toBeVisible();
    expect(fake.callsTo('POST', `/api/v1/sections/${ROOF}/restore`)).toHaveLength(1);
    expect(fake.callsTo('POST', `/api/v1/tables/${TABLE_3}/restore`)).toHaveLength(1);
    // Read again: the roof is back, with nothing archived about it.
    expect(within(await headerOf('Roof')).queryByText(t('floor.section.archived'))).toBeNull();
    expect(within(await tableRowOf('R1')).getByText(t('floor.table.archived'))).toBeVisible();
  });

  it('follows changes to the floor made on other screens', async () => {
    const renamed: FloorResponse = {
      sections: floor().sections.map((entry) =>
        entry.id === TERRACE ? { ...entry, name: 'Garden' } : entry,
      ),
    };
    const { sockets } = await renderConsole({
      fake: floorServer(floor(), renamed),
      path: PATH,
      signedIn: 'MANAGER',
    });
    await sectionOf('Terrace');
    act(() => {
      sockets.sync(0);
      sockets.last.fire('event', changed(1, 'FLOOR'));
    });
    expect(await sectionOf('Garden')).toBeVisible();
    expect(screen.queryByText('Terrace')).toBeNull();
  });

  it('says when the floor cannot be read, and tries again', async () => {
    const fake = signsInAs(server(), 'MANAGER').on(
      'GET',
      FLOOR,
      () => refusal(503, 'UNAVAILABLE', 'The server is busy.'),
      () => ({ status: 200, body: floor() }),
    );
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    expect(await screen.findByText(t('floor.loadFailed'))).toBeVisible();
    await user.click(screen.getByRole('button', { name: t('states.retry') }));
    expect(await sectionOf('Main Hall')).toBeVisible();
  });
});

describe('[MGR-007] [AUTH-012] who sees the Floor page', () => {
  it('links it for people who manage staff and sections, and only for them', async () => {
    // A manager whose custom role does not manage staff configures the restaurant but not the floor.
    const configurer = login('MANAGER');
    const fake = server()
      .on('POST', '/api/v1/auth/pin-login', () => ({
        status: 200,
        body: {
          ...configurer,
          staff: {
            ...configurer.staff,
            customRole: {
              id: '0199a0e0-0000-7000-8000-000000000c01',
              name: 'Shift lead',
              added: [],
              removed: ['STAFF_MANAGE'],
            },
          },
        },
      }))
      .on('GET', '/api/v1/settings', () => ({ status: 200, body: { settings: [] } }));
    await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    const pages = await screen.findByRole('navigation', { name: t('settings.pages.label') });
    expect(within(pages).queryByRole('link', { name: t('settings.pages.floor') })).toBeNull();
    expect(within(pages).getByRole('link', { name: t('settings.pages.printing') })).toBeVisible();
    // The page itself sends them back to the general settings.
    expect(
      await screen.findByRole('heading', { level: 2, name: t('settings.title') }),
    ).toBeVisible();
    expect(fake.callsTo('GET', FLOOR)).toHaveLength(0);
  });

  it('links it for managers', async () => {
    await renderConsole({
      fake: floorServer(),
      path: '/manage/settings/floor',
      signedIn: 'MANAGER',
    });
    const pages = await screen.findByRole('navigation', { name: t('settings.pages.label') });
    expect(within(pages).getByRole('link', { name: t('settings.pages.floor') })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
