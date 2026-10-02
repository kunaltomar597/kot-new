import type { FloorResponse } from '@rp/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeResponse, FakeServer } from './fake-server.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import { H1, H2, HALL, ROOFTOP, sectionsFloor } from './sections-fixture.js';

const PATH = '/manage/floor';

function floorServer(...floors: FloorResponse[]): FakeServer {
  const answers = (floors.length === 0 ? [sectionsFloor()] : floors).map(
    (body) => (): FakeResponse => ({ status: 200, body }),
  );
  return signsInAs(server(), 'MANAGER').on('GET', '/api/v1/floor', ...answers);
}

const field = (scope: { getByLabelText: (matcher: RegExp) => HTMLElement }, label: string) =>
  scope.getByLabelText(new RegExp(`^${label}`));

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[TBL-001] [ONB-004] the floor page', () => {
  it('lists sections and tables, adds a section and a table, archives a table with a reason', async () => {
    const floor = sectionsFloor();
    const hall = floor.sections[0];
    const fake = floorServer()
      .on('POST', '/api/v1/sections', (call) => ({
        status: 201,
        body: { ...hall, ...(call.body as object), id: ROOFTOP, tables: [] },
      }))
      .on('POST', '/api/v1/tables', (call) => ({
        status: 201,
        body: { ...hall?.tables[0], ...(call.body as object) },
      }))
      .on('POST', `/api/v1/tables/${H2}/archive`, () => ({
        status: 200,
        body: { ...hall?.tables[1], archivedAt: '2026-10-03T10:00:00.000Z' },
      }));
    const { user, container } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    const hallCard = await screen.findByRole('region', { name: 'Hall' });
    expect(within(hallCard).getByRole('heading', { name: 'H1' })).toBeVisible();
    expect(within(hallCard).getAllByText(t('floorPage.archivedBadge'))).toHaveLength(1);
    // An archived section offers only Restore.
    const rooftop = screen.getByRole('group', {
      name: t('floorPage.sectionActions', { name: 'Rooftop' }),
    });
    expect(within(rooftop).getAllByRole('button')).toHaveLength(1);
    await expectNoAxeViolations(container);

    await user.click(screen.getByRole('button', { name: t('floorPage.addSection') }));
    const sectionDialog = await screen.findByRole('dialog', {
      name: t('floorPage.sectionDialog.addTitle'),
    });
    await user.click(
      within(sectionDialog).getByRole('button', { name: t('floorPage.sectionDialog.save') }),
    );
    expect(within(sectionDialog).getByText(t('floorPage.problems.nameRequired'))).toBeVisible();
    await user.type(field(within(sectionDialog), t('floorPage.sectionDialog.name')), 'Rooftop bar');
    await user.click(
      within(sectionDialog).getByRole('button', { name: t('floorPage.sectionDialog.save') }),
    );
    await waitFor(() => {
      expect(fake.callsTo('POST', '/api/v1/sections')[0]?.body).toEqual({
        name: 'Rooftop bar',
        displayOrder: 3,
      });
    });

    const hallActions = screen.getByRole('group', {
      name: t('floorPage.sectionActions', { name: 'Hall' }),
    });
    await user.click(within(hallActions).getByRole('button', { name: t('floorPage.addTable') }));
    const tableDialog = await screen.findByRole('dialog', {
      name: t('floorPage.tableDialog.addTitle'),
    });
    await user.type(field(within(tableDialog), t('floorPage.tableDialog.label')), 'H3');
    const seats = field(within(tableDialog), t('floorPage.tableDialog.capacity'));
    await user.clear(seats);
    await user.type(seats, '6');
    await user.click(
      within(tableDialog).getByRole('button', { name: t('floorPage.tableDialog.save') }),
    );
    await waitFor(() => {
      expect(fake.callsTo('POST', '/api/v1/tables')[0]?.body).toEqual({
        label: 'H3',
        capacity: 6,
        sectionId: HALL,
        displayOrder: 1,
      });
    });

    const h2 = screen.getByRole('group', { name: t('floorPage.tableActions', { label: 'H2' }) });
    await user.click(within(h2).getByRole('button', { name: t('floorPage.archive') }));
    const archive = await screen.findByRole('dialog', {
      name: t('floorPage.archiveTable.title', { label: 'H2' }),
    });
    await user.type(within(archive).getByRole('textbox'), 'Broken leg');
    await user.click(within(archive).getByRole('button', { name: t('floorPage.archive') }));
    await waitFor(() => {
      expect(fake.callsTo('POST', `/api/v1/tables/${H2}/archive`)[0]?.body).toEqual({
        reason: 'Broken leg',
      });
    });
  });

  it('[ONB-004] places tables on the plan with the keyboard, then saves the plan', async () => {
    const fake = floorServer().on('PUT', '/api/v1/floor/layout', () => ({
      status: 200,
      body: sectionsFloor(),
    }));
    const { user, container } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(await screen.findByRole('button', { name: t('floorPage.plan') }));
    const hallPlan = await screen.findByRole('group', {
      name: t('floorPage.planEditor.section', { name: 'Hall' }),
    });
    // Not placed yet: each table gets a free spot, sized for its seats; archived ones are left out.
    const h1 = within(hallPlan).getByRole('button', { name: /^Table H1,/ });
    expect(h1).toHaveAccessibleName('Table H1, 4 seats, at column 2, row 2, 4 by 3');
    expect(within(hallPlan).queryByRole('button', { name: /^Table H9,/ })).toBeNull();
    await expectNoAxeViolations(container);

    h1.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByText('Table H1 at column 3, row 2')).toBeInTheDocument();
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}');
    await user.keyboard('r');
    expect(screen.getByText(t('floorPage.planEditor.unsaved'))).toBeVisible();
    await user.click(screen.getByRole('button', { name: t('floorPage.planEditor.save') }));
    await waitFor(() => {
      expect(fake.callsTo('PUT', '/api/v1/floor/layout')).toHaveLength(1);
    });
    const body = fake.callsTo('PUT', '/api/v1/floor/layout')[0]?.body as {
      tables: { tableId: string; layout: object }[];
    };
    // Every table drawn is saved: the one moved, and the ones placed for it.
    expect(body.tables).toHaveLength(4);
    expect(body.tables.find((entry) => entry.tableId === H1)?.layout).toEqual({
      x: 2,
      y: 1,
      w: 4,
      h: 4,
      shape: 'ROUND',
    });
    expect(await screen.findByText(t('floorPage.planEditor.saved'))).toBeInTheDocument();
  });

  it('is in the manager’s menu', async () => {
    await renderConsole({ fake: floorServer(), path: '/manage', signedIn: 'MANAGER' });
    expect(
      await screen.findByRole('link', { name: t('dashboard.section.floor') }),
    ).toBeInTheDocument();
  });
});
