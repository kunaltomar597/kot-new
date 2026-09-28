import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGER_REFRESH_MS } from '../src/manage/staff/PagersScreen.js';
import type { FakeServer, FakeResponse } from './fake-server.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import {
  changed,
  credential,
  crewList,
  PAGER_1,
  PAGER_2,
  pager,
  pagerList,
  SUNIL,
} from './sections-fixture.js';

const PATH = '/manage/staff/pagers';
const PAGERS = '/api/v1/pagers';

function pagersServer(...lists: ReturnType<typeof pagerList>[]): FakeServer {
  const answers = (lists.length === 0 ? [pagerList()] : lists).map((body) => (): FakeResponse => ({
    status: 200,
    body,
  }));
  return signsInAs(server(), 'MANAGER')
    .on('GET', '/api/v1/staff', () => ({ status: 200, body: crewList() }))
    .on('GET', PAGERS, ...answers);
}

const actionsFor = (name: string) =>
  screen.findByRole('group', { name: t('pagers.actionsFor', { name }) });
const rowOf = async (name: string) =>
  (await screen.findByRole('heading', { level: 3, name })).closest('li') as HTMLElement;

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('[PGR-012] [PGR-013] the pagers', () => {
  it('lists each pager with its state in words, its wearer and its actions', async () => {
    const fake = pagersServer(
      pagerList([
        pager(),
        pager({
          deviceId: PAGER_2,
          name: 'Pager 2',
          serial: 'WP-0002',
          staffId: null,
          online: false,
          batteryPercent: 9,
          lastSeenAt: '2026-09-28T04:30:00.000Z',
        }),
      ]),
    );
    const { container } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    expect(await screen.findByRole('heading', { level: 2, name: t('pagers.title') })).toBeVisible();

    const first = await rowOf('Pager 1');
    expect(within(first).getByText(t('pagers.serial', { serial: 'WP-0001' }))).toBeVisible();
    expect(within(first).getByText(t('pagers.connected'))).toBeVisible();
    expect(within(first).getByText(t('pagers.battery', { percent: 80 }))).toBeVisible();
    expect(within(first).getByText(t('pagers.wornBy', { name: 'Ravi' }))).toBeVisible();
    expect(
      within(await actionsFor('Pager 1'))
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([t('pagers.giveOther'), t('pagers.takeBack'), t('pagers.newCredential')]);

    const second = await rowOf('Pager 2');
    expect(within(second).getByText(t('pagers.notConnected'))).toBeVisible();
    expect(within(second).getByText(t('pagers.batteryLow', { percent: 9 }))).toBeVisible();
    expect(within(second).getByText(t('pagers.notWorn'))).toBeVisible();
    // 04:30 UTC is 10:00 in the restaurant (IST).
    expect(
      within(second).getByText(
        `${t('pagers.lastSeen', { time: '10:00' })} · ${t('pagers.firmware', { version: '1.0.3' })}`,
      ),
    ).toBeVisible();
    expect(
      within(await actionsFor('Pager 2'))
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([t('pagers.give'), t('pagers.newCredential')]);
    await expectNoAxeViolations(container);
  });

  it('registers a pager by its serial and shows its credential once', async () => {
    const registered = pager({
      deviceId: PAGER_2,
      name: 'Pager 2',
      serial: 'WP-0002',
      staffId: SUNIL.id,
    });
    const fake = pagersServer(pagerList(), pagerList([pager(), registered])).on(
      'POST',
      PAGERS,
      () => ({ status: 201, body: credential() }),
    );
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(await screen.findByRole('button', { name: t('pagers.register') }));
    const form = within(await screen.findByRole('dialog', { name: t('pagers.form.title') }));
    // The first free name is suggested.
    expect(form.getByLabelText(new RegExp(`^${t('pagers.form.name')}`))).toHaveValue('Pager 2');
    const serial = form.getByLabelText(new RegExp(`^${t('pagers.form.serial')}`));
    expect(serial).toHaveFocus();
    await user.type(serial, 'WP 2');
    await user.click(form.getByRole('button', { name: t('pagers.form.register') }));
    expect(form.getByText(t('pagers.form.serialInvalid'))).toBeVisible();
    expect(fake.callsTo('POST', PAGERS)).toHaveLength(0);

    await user.clear(serial);
    await user.type(serial, 'WP-0002');
    await user.selectOptions(form.getByLabelText(t('pagers.form.wearer')), 'Sunil');
    await user.click(form.getByRole('button', { name: t('pagers.form.register') }));

    const shown = within(
      await screen.findByRole('dialog', {
        name: t('pagers.credentialDialog.title', { pager: 'Pager 2' }),
      }),
    );
    expect(shown.getByText(credential().mqttPassword)).toBeVisible();
    expect(shown.getByText(PAGER_2)).toBeVisible();
    expect(shown.getByText('8883')).toBeVisible();
    expect(fake.callsTo('POST', PAGERS)[0]?.body).toEqual({
      serial: 'WP-0002',
      name: 'Pager 2',
      staffId: SUNIL.id,
    });
    // Escape does not close it: the password cannot be shown again.
    await user.keyboard('{Escape}');
    expect(shown.getByText(credential().mqttPassword)).toBeVisible();
    await user.click(shown.getByRole('button', { name: t('pagers.credentialDialog.done') }));
    await waitFor(() => {
      expect(screen.queryByText(credential().mqttPassword)).toBeNull();
    });
    expect(
      within(await rowOf('Pager 2')).getByText(t('pagers.wornBy', { name: 'Sunil' })),
    ).toBeVisible();
  });

  it('says why a pager cannot be registered', async () => {
    const fake = pagersServer().on('POST', PAGERS, () => ({
      status: 409,
      body: { code: 'PAGER_ALREADY_REGISTERED', message: 'This pager is already registered.' },
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(await screen.findByRole('button', { name: t('pagers.register') }));
    const form = within(await screen.findByRole('dialog', { name: t('pagers.form.title') }));
    await user.type(form.getByLabelText(new RegExp(`^${t('pagers.form.serial')}`)), 'WP-0001');
    await user.click(form.getByRole('button', { name: t('pagers.form.register') }));
    expect(await form.findByRole('alert')).toHaveTextContent('This pager is already registered.');
  });

  it('[PGR-014] gives a pager to someone else and takes it back', async () => {
    const fake = pagersServer().on('PUT', `${PAGERS}/${PAGER_1}/wearer`, (call) => ({
      status: 200,
      body: pager({ staffId: (call.body as { staffId: string | null }).staffId }),
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      within(await actionsFor('Pager 1')).getByRole('button', { name: t('pagers.giveOther') }),
    );
    const give = within(
      await screen.findByRole('dialog', {
        name: t('pagers.giveDialog.title', { pager: 'Pager 1' }),
      }),
    );
    const person = give.getByLabelText(new RegExp(`^${t('pagers.giveDialog.person')}`));
    // Ravi wears it already; managers can wear one too (PGR-014).
    expect(within(person).queryByRole('option', { name: 'Ravi' })).toBeNull();
    expect(within(person).getByRole('option', { name: 'Meera' })).toBeInTheDocument();
    expect(give.getByRole('button', { name: t('pagers.giveDialog.confirm') })).toBeDisabled();
    await user.selectOptions(person, 'Sunil');
    await user.click(give.getByRole('button', { name: t('pagers.giveDialog.confirm') }));
    expect(
      await screen.findByText(t('pagers.given', { pager: 'Pager 1', name: 'Sunil' })),
    ).toBeVisible();

    await user.click(
      within(await actionsFor('Pager 1')).getByRole('button', { name: t('pagers.takeBack') }),
    );
    const confirm = within(
      await screen.findByRole('dialog', {
        name: t('pagers.takeBackDialog.title', { pager: 'Pager 1', name: 'Ravi' }),
      }),
    );
    await user.click(confirm.getByRole('button', { name: t('pagers.takeBackDialog.confirm') }));
    expect(await screen.findByText(t('pagers.takenBack', { pager: 'Pager 1' }))).toBeVisible();
    expect(fake.callsTo('PUT', `${PAGERS}/${PAGER_1}/wearer`).map((call) => call.body)).toEqual([
      { staffId: SUNIL.id },
      { staffId: null },
    ]);
  });

  it('[SEC-012] issues a new credential only after asking, and shows it once', async () => {
    const fake = pagersServer().on('POST', `${PAGERS}/${PAGER_1}/credential`, () => ({
      status: 200,
      body: { ...credential(PAGER_1), mqttPassword: 'n3w-s3cr3t-n3w-s3cr3t-n3w-s3cr3t' },
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      within(await actionsFor('Pager 1')).getByRole('button', { name: t('pagers.newCredential') }),
    );
    const confirm = within(
      await screen.findByRole('dialog', {
        name: t('pagers.credentialDialog.confirmTitle', { pager: 'Pager 1' }),
      }),
    );
    expect(fake.callsTo('POST', `${PAGERS}/${PAGER_1}/credential`)).toHaveLength(0);
    await user.click(confirm.getByRole('button', { name: t('pagers.credentialDialog.confirm') }));
    expect(await screen.findByText('n3w-s3cr3t-n3w-s3cr3t-n3w-s3cr3t')).toBeVisible();
    expect(fake.callsTo('POST', `${PAGERS}/${PAGER_1}/credential`)).toHaveLength(1);
  });

  it('follows pager changes from other screens and reads batteries every minute', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setInterval', 'clearInterval'] });
    const fake = pagersServer(
      pagerList(),
      pagerList([pager({ staffId: SUNIL.id })]),
      pagerList([pager({ staffId: SUNIL.id, batteryPercent: 14 })]),
    );
    const { sockets } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    expect(
      within(await rowOf('Pager 1')).getByText(t('pagers.wornBy', { name: 'Ravi' })),
    ).toBeVisible();
    act(() => {
      sockets.sync(0);
      sockets.last.fire('event', changed(1, 'DEVICES'));
    });
    expect(
      await within(await rowOf('Pager 1')).findByText(t('pagers.wornBy', { name: 'Sunil' })),
    ).toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(PAGER_REFRESH_MS));
    expect(
      await within(await rowOf('Pager 1')).findByText(t('pagers.batteryLow', { percent: 14 })),
    ).toBeVisible();
  });
});
