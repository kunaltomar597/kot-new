import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeServer } from './fake-server.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import {
  assignment,
  assignments,
  changed,
  crewList,
  H2,
  HALL,
  MEERA,
  RAVI,
  sectionsFloor,
  SUNIL,
  TERRACE,
} from './sections-fixture.js';
import { PRIYA } from './staff-fixture.js';

const PATH = '/manage/staff/sections';
const ASSIGNMENTS = '/api/v1/waiter-assignments';

function sectionsServer(...answers: ReturnType<typeof assignments>[]): FakeServer {
  const [first = assignments([]), ...later] = answers;
  return signsInAs(server(), 'MANAGER')
    .on('GET', '/api/v1/staff', () => ({ status: 200, body: crewList() }))
    .on('GET', '/api/v1/floor', () => ({ status: 200, body: sectionsFloor() }))
    .on(
      'GET',
      ASSIGNMENTS,
      () => ({ status: 200, body: first }),
      ...later.map((body) => () => ({ status: 200, body })),
    )
    .on('PUT', ASSIGNMENTS, (call) => ({
      status: 200,
      body: {
        current: { businessDate: '2026-09-28', assignments: [] },
        previous: null,
        echo: call.body,
      },
    }));
}

const row = async (name: string) =>
  (await screen.findByRole('heading', { level: 3, name })).closest('li') as HTMLElement;
const change = async (name: string) =>
  screen.findByRole('button', { name: t('sections.changeFor', { name }) });
const dialog = (name: string) =>
  screen.findByRole('dialog', { name: t('sections.dialog.title', { name }) });

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[TBL-002] [MGR-004] today’s sections', () => {
  it('shows who looks after which tables today, and the tables nobody does', async () => {
    const fake = sectionsServer(assignments([assignment(RAVI, [HALL])]));
    const { container } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    expect(
      await screen.findByRole('heading', { level: 2, name: t('sections.title') }),
    ).toBeVisible();
    const pages = screen.getByRole('navigation', { name: t('staff.pages.label') });
    expect(within(pages).getByRole('link', { name: t('staff.pages.sections') })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(pages).getByRole('link', { name: t('staff.pages.pagers') })).toBeVisible();
    expect(screen.getByText(t('sections.intro', { day: 'Monday, 28 September' }))).toBeVisible();

    const ravi = await row('Ravi');
    expect(within(ravi).getByText(t('sections.sectionsLine', { sections: 'Hall' }))).toBeVisible();
    expect(within(ravi).getByText(t('sections.tableCount', { count: 2 }))).toBeVisible();
    expect(within(await row('Sunil')).getByText(t('sections.none'))).toBeVisible();
    // Kitchen staff take no orders; Priya is deactivated.
    expect(screen.queryByRole('heading', { level: 3, name: 'Imran' })).toBeNull();
    expect(screen.queryByRole('heading', { level: 3, name: 'Priya' })).toBeNull();
    expect(screen.getByText(t('sections.uncoveredSection', { section: 'Terrace' }))).toBeVisible();
    // Nothing from an earlier day to give again.
    expect(screen.queryByRole('button', { name: /^Same as/ })).toBeNull();
    await expectNoAxeViolations(container);
  });

  it('gives a waiter a section and a single table, on the plan as the server has it now', async () => {
    const shown = assignments([assignment(RAVI, [HALL])]);
    // Meanwhile another manager gave Meera the terrace.
    const now = assignments([assignment(RAVI, [HALL]), assignment(MEERA, [TERRACE])]);
    const fake = sectionsServer(shown, now, now);
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(await change('Sunil'));
    const box = within(await dialog('Sunil'));
    await user.click(box.getByRole('checkbox', { name: /^Terrace/ }));
    const hall = box.getByRole('group', { name: t('sections.dialog.tables', { section: 'Hall' }) });
    await user.click(within(hall).getByRole('checkbox', { name: 'H2' }));
    await user.click(box.getByRole('button', { name: t('sections.dialog.save') }));

    expect(await screen.findByText(t('sections.saved', { name: 'Sunil' }))).toBeVisible();
    expect(fake.callsTo('PUT', ASSIGNMENTS)[0]?.body).toEqual({
      assignments: [
        { staffId: RAVI, sectionIds: [HALL], tableIds: [] },
        { staffId: MEERA, sectionIds: [TERRACE], tableIds: [] },
        { staffId: SUNIL.id, sectionIds: [TERRACE], tableIds: [H2] },
      ],
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('takes someone off for the day when nothing is ticked', async () => {
    const today = assignments([assignment(RAVI, [HALL]), assignment(SUNIL.id, [TERRACE])]);
    const fake = sectionsServer(today, today, today);
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(await change('Ravi'));
    const box = within(await dialog('Ravi'));
    expect(box.getByRole('checkbox', { name: /^Hall/ })).toBeChecked();
    await user.click(box.getByRole('checkbox', { name: /^Hall/ }));
    await user.click(box.getByRole('button', { name: t('sections.dialog.save') }));
    expect(await screen.findByText(t('sections.cleared', { name: 'Ravi' }))).toBeVisible();
    expect(fake.callsTo('PUT', ASSIGNMENTS)[0]?.body).toEqual({
      assignments: [{ staffId: SUNIL.id, sectionIds: [TERRACE], tableIds: [] }],
    });
  });

  it('keeps the dialog open with the server’s reason when a save is refused', async () => {
    const fake = sectionsServer().on('PUT', ASSIGNMENTS, () => ({
      status: 422,
      body: { code: 'SECTION_NOT_FOUND', message: 'A section is unknown or archived.' },
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(await change('Ravi'));
    const box = within(await dialog('Ravi'));
    await user.click(box.getByRole('checkbox', { name: /^Hall/ }));
    await user.click(box.getByRole('button', { name: t('sections.dialog.save') }));
    expect(await box.findByRole('alert')).toHaveTextContent('A section is unknown or archived.');
  });

  it('gives the last day’s sections again in one step, leaving out who is gone', async () => {
    const yesterday = [assignment(RAVI, [HALL]), assignment(PRIYA.id, [TERRACE])];
    const fake = sectionsServer(assignments([], yesterday));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      await screen.findByRole('button', {
        name: t('sections.sameAs', { day: 'Sunday, 27 September' }),
      }),
    );
    expect(
      await screen.findByText(t('sections.applied', { day: 'Sunday, 27 September' })),
    ).toBeVisible();
    expect(screen.getByText(t('sections.leftOut', { count: 1, names: 'Priya' }))).toBeVisible();
    expect(fake.callsTo('PUT', ASSIGNMENTS)[0]?.body).toEqual({
      assignments: [{ staffId: RAVI, sectionIds: [HALL], tableIds: [] }],
    });
  });

  it('asks before replacing sections already given today', async () => {
    const fake = sectionsServer(
      assignments([assignment(SUNIL.id, [HALL])], [assignment(RAVI, [HALL, TERRACE])]),
    );
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      await screen.findByRole('button', {
        name: t('sections.sameAs', { day: 'Sunday, 27 September' }),
      }),
    );
    const confirm = within(
      await screen.findByRole('dialog', {
        name: t('sections.replaceDialog.title', { day: 'Sunday, 27 September' }),
      }),
    );
    expect(fake.callsTo('PUT', ASSIGNMENTS)).toHaveLength(0);
    await user.click(confirm.getByRole('button', { name: t('sections.replaceDialog.confirm') }));
    expect(
      await screen.findByText(t('sections.applied', { day: 'Sunday, 27 September' })),
    ).toBeVisible();
    expect(fake.callsTo('PUT', ASSIGNMENTS)[0]?.body).toEqual({
      assignments: [{ staffId: RAVI, sectionIds: [HALL, TERRACE], tableIds: [] }],
    });
  });

  it('[ORD-010] follows changes made on other screens', async () => {
    const fake = sectionsServer(assignments([]), assignments([assignment(SUNIL.id, [TERRACE])]));
    const { sockets } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    expect(within(await row('Sunil')).getByText(t('sections.none'))).toBeVisible();
    act(() => {
      sockets.sync(0);
      sockets.last.fire('event', changed(1, 'WAITER_ASSIGNMENTS'));
    });
    expect(
      await within(await row('Sunil')).findByText(
        t('sections.sectionsLine', { sections: 'Terrace' }),
      ),
    ).toBeVisible();
  });

  it('keeps the Staff area to those who manage staff, and unknown pages to its first', async () => {
    const cashier = await renderConsole({
      fake: signsInAs(server(), 'CASHIER'),
      path: PATH,
      signedIn: 'CASHIER',
    });
    expect(
      await screen.findByText(t('modes.notAllowed', { mode: t('modes.manage') })),
    ).toBeInTheDocument();
    cashier.unmount();

    await renderConsole({
      fake: sectionsServer(),
      path: '/manage/staff/nowhere',
      signedIn: 'MANAGER',
    });
    expect(await screen.findByRole('heading', { level: 2, name: t('staff.title') })).toBeVisible();
  });
});
