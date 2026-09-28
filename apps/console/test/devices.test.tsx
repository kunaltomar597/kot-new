import type { DeviceView } from '@rp/contracts';
import { timeOfDayOf } from '@rp/domain';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_REFRESH_MS } from '../src/manage/devices/DevicesScreen.js';
import {
  device,
  deviceList,
  devices,
  KDS_1,
  KDS_2,
  OFFICE,
  pairingCode,
  PHONE_1,
  stationList,
  TABLET_1,
  TANDOOR,
} from './devices-fixture.js';
import type { FakeResponse, FakeServer } from './fake-server.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import { changed, crewList, H2, sectionsFloor, T7 } from './sections-fixture.js';

const PATH = '/manage/devices';
const NEW_TABLET = '0199a0e0-0000-7000-8000-000000000939';
const DEVICES = '/api/v1/devices';
const CODES = '/api/v1/devices/pairing-codes';

function devicesServer(...lists: DeviceView[][]): FakeServer {
  const answers = (lists.length === 0 ? [devices()] : lists).map((list) => (): FakeResponse => ({
    status: 200,
    body: deviceList(list),
  }));
  return signsInAs(server(), 'MANAGER')
    .on('GET', DEVICES, ...answers)
    .on('GET', '/api/v1/floor', () => ({ status: 200, body: sectionsFloor() }))
    .on('GET', '/api/v1/stations', () => ({ status: 200, body: stationList() }))
    .on('GET', '/api/v1/staff', () => ({ status: 200, body: crewList() }));
}

const rowOf = async (name: string) =>
  (await screen.findByRole('heading', { level: 4, name: new RegExp(`^${name}`) })).closest(
    'li',
  ) as HTMLElement;
const actionsFor = (name: string) =>
  screen.findByRole('group', { name: t('devices.actionsFor', { name }) });
const buttonsOf = async (name: string) =>
  within(await actionsFor(name))
    .getAllByRole('button')
    .map((button) => button.textContent);

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('[MGR-006] the devices', () => {
  it('lists every paired device by type with its binding, state in words, details and actions', async () => {
    const fake = devicesServer();
    const { container } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    expect(
      await screen.findByRole('heading', { level: 2, name: t('devices.title') }),
    ).toBeVisible();
    expect(
      screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent),
    ).toEqual([
      t('devices.group.POS'),
      t('devices.group.MANAGER_BROWSER'),
      t('devices.group.KDS'),
      t('devices.group.WAITER_PHONE'),
      t('devices.group.TABLE_TABLET'),
      t('devices.group.PAGER'),
    ]);
    // The unpaired POS is gone.
    expect(screen.queryByText('Old POS')).toBeNull();

    // This console: marked, and neither located nor unpaired from itself.
    const counter = await rowOf('Counter POS');
    expect(within(counter).getByText(t('devices.thisDevice'))).toBeVisible();
    expect(within(counter).getByText(t('devices.ownDevice'))).toBeVisible();
    expect(within(counter).getByText(t('devices.appVersion', { version: '0.1.0' }))).toBeVisible();
    expect(await buttonsOf('Counter POS')).toEqual([t('devices.rename')]);

    const office = await rowOf('Office laptop');
    expect(within(office).getByText(t('devices.notConnected'))).toBeVisible();
    expect(within(office).getByText(t('devices.neverSeen'))).toBeVisible();
    // Not connected: nothing to locate.
    expect(await buttonsOf('Office laptop')).toEqual([t('devices.rename'), t('devices.unpair')]);

    const tandoor = await rowOf('Tandoor screen');
    expect(within(tandoor).getByText(t('devices.station', { station: 'Tandoor' }))).toBeVisible();
    expect(within(tandoor).getByText(t('devices.connected'))).toBeVisible();
    expect(await buttonsOf('Tandoor screen')).toEqual([
      t('devices.locate'),
      t('devices.rename'),
      t('devices.unpair'),
    ]);
    const pass = await rowOf('Pass screen');
    expect(within(pass).getByText(t('devices.allStations'))).toBeVisible();
    // 05:15 UTC is 10:45 in the restaurant (IST), today.
    expect(
      within(pass).getByText(new RegExp(t('devices.lastSeenToday', { time: '10:45' }))),
    ).toBeVisible();

    const phone = await rowOf('Waiter phone 1');
    expect(within(phone).getByText(t('devices.holder', { name: 'Ravi' }))).toBeVisible();

    const tablet = await rowOf('Table H1 tablet');
    expect(within(tablet).getByText(t('devices.table', { table: 'H1' }))).toBeVisible();
    expect(within(tablet).getByText(t('devices.batteryLow', { percent: 18 }))).toBeVisible();
    // 15:45 UTC on the 27th is 21:15 in the restaurant: yesterday.
    expect(
      within(tablet).getByText(
        new RegExp(`^${t('devices.lastSeenEarlier', { date: '27 Sep.*', time: '21:15' })}`),
      ),
    ).toBeVisible();
    expect(await buttonsOf('Table H1 tablet')).toEqual([
      t('devices.rename'),
      t('devices.move'),
      t('devices.unpair'),
    ]);

    const pager = await rowOf('Pager 1');
    expect(within(pager).getByText(t('devices.wornBy', { name: 'Ravi' }))).toBeVisible();
    expect(within(pager).getByText(t('devices.battery', { percent: 80 }))).toBeVisible();
    expect(
      within(pager).getByText(
        `${t('devices.firmware', { version: '1.0.3' })} · ${t('devices.serial', { serial: 'WP-0001' })}`,
      ),
    ).toBeVisible();
    expect(screen.getByText(t('devices.pagersElsewhere'))).toBeVisible();
    await expectNoAxeViolations(container);
  });

  it('is linked from the dashboard for managers', async () => {
    const fake = devicesServer();
    const { user } = await renderConsole({ fake, path: '/manage', signedIn: 'MANAGER' });
    const nav = await screen.findByRole('navigation', { name: t('dashboard.navigation') });
    await user.click(within(nav).getByRole('link', { name: t('dashboard.section.devices') }));
    expect(
      await screen.findByRole('heading', { level: 2, name: t('devices.title') }),
    ).toBeVisible();
  });

  it('follows device changes from other screens and reads connections every minute', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setInterval', 'clearInterval'] });
    const renamed = devices().map((entry) =>
      entry.id === KDS_1 ? { ...entry, name: 'Grill screen' } : entry,
    );
    const back = renamed.map((entry) => (entry.id === KDS_2 ? { ...entry, online: true } : entry));
    const fake = devicesServer(devices(), renamed, back);
    const { sockets } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await rowOf('Tandoor screen');
    act(() => {
      sockets.sync(0);
      sockets.last.fire('event', changed(1, 'DEVICES'));
    });
    expect(await rowOf('Grill screen')).toBeVisible();
    expect(within(await rowOf('Pass screen')).getByText(t('devices.notConnected'))).toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(DEVICE_REFRESH_MS));
    expect(
      await within(await rowOf('Pass screen')).findByText(t('devices.connected')),
    ).toBeVisible();
  });

  it('still lists the devices when the names of their bindings cannot be read', async () => {
    const fake = devicesServer().on('GET', '/api/v1/staff', () => ({
      status: 403,
      body: { code: 'FORBIDDEN', message: 'Not allowed.' },
    }));
    await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    const phone = await rowOf('Waiter phone 1');
    expect(
      within(phone).getByText(t('devices.holder', { name: t('devices.personGone') })),
    ).toBeVisible();
  });
});

describe('[AUTH-007] [AUTH-009] pairing a device', () => {
  it('pairs a table tablet: its table, a suggested name, then the QR code until it pairs', async () => {
    const tablet = device({
      id: NEW_TABLET,
      type: 'TABLE_TABLET',
      name: 'Table T7 tablet',
      tableId: T7,
    });
    const fake = devicesServer(devices(), [...devices(), tablet]).on('POST', CODES, () => ({
      status: 201,
      body: pairingCode(),
    }));
    const { user, sockets } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(await screen.findByRole('button', { name: t('devices.pair') }));
    const dialog = within(
      await screen.findByRole('dialog', { name: t('devices.pairDialog.title') }),
    );
    const type = dialog.getByLabelText(t('devices.pairDialog.type'));
    expect(type).toHaveFocus();
    const name = dialog.getByLabelText(new RegExp(`^${t('devices.pairDialog.name')}`));
    // The first free number: POS 1 is free, since this console is the Counter POS.
    expect(name).toHaveValue(t('devices.pairDialog.defaultName.POS', { number: 1 }));

    await user.selectOptions(type, t('devices.type.TABLE_TABLET'));
    expect(name).toHaveValue(t('devices.pairDialog.defaultName.TABLE_TABLET', { number: 1 }));
    const table = dialog.getByLabelText(new RegExp(`^${t('devices.pairDialog.table')}`));
    // Tables in use only: not H9 (archived) or the rooftop.
    expect(
      within(table)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      t('devices.pairDialog.chooseTable'),
      t('devices.pairDialog.tableIn', { table: 'H1', section: 'Hall' }),
      t('devices.pairDialog.tableIn', { table: 'H2', section: 'Hall' }),
      t('devices.pairDialog.tableIn', { table: 'T7', section: 'Terrace' }),
      t('devices.pairDialog.tableIn', { table: 'T8', section: 'Terrace' }),
    ]);
    await user.click(dialog.getByRole('button', { name: t('devices.pairDialog.create') }));
    expect(dialog.getByText(t('devices.pairDialog.tableRequired'))).toBeVisible();
    expect(fake.callsTo('POST', CODES)).toHaveLength(0);

    await user.selectOptions(
      table,
      t('devices.pairDialog.tableIn', { table: 'T7', section: 'Terrace' }),
    );
    expect(name).toHaveValue(t('devices.pairDialog.tabletName', { table: 'T7' }));
    await user.click(dialog.getByRole('button', { name: t('devices.pairDialog.create') }));

    const code = within(
      await screen.findByRole('dialog', {
        name: t('devices.pairDialog.codeTitle', { name: 'Table T7 tablet' }),
      }),
    );
    expect(fake.callsTo('POST', CODES)[0]?.body).toEqual({
      type: 'TABLE_TABLET',
      name: 'Table T7 tablet',
      tableId: T7,
    });
    expect(code.getByText(t('devices.pairDialog.scanApp'))).toBeVisible();
    expect(
      code.getByRole('img', {
        name: t('devices.pairDialog.qrLabel', { name: 'Table T7 tablet' }),
      }),
    ).toBeVisible();
    expect(code.getByText('ABCD-EFGH')).toBeVisible();
    expect(code.getByText('https://192.168.1.20:8443')).toBeVisible();
    expect(code.getByText('https://pos.local:8443')).toBeVisible();
    expect(code.getByText(pairingCode().caSha256 ?? '')).toBeVisible();
    expect(
      code.getByText(
        t('devices.pairDialog.validUntil', {
          time: timeOfDayOf(new Date(pairingCode().expiresAt)),
        }),
      ),
    ).toBeVisible();
    expect(code.getByRole('status')).toHaveTextContent(t('devices.pairDialog.waiting'));

    // The tablet pairs: the server announces it, and the list has it.
    act(() => {
      sockets.sync(0);
      sockets.last.fire('event', changed(1, 'DEVICES'));
    });
    await waitFor(() => {
      expect(code.getByRole('status')).toHaveTextContent(
        t('devices.pairDialog.paired', { name: 'Table T7 tablet' }),
      );
    });
    expect(code.queryByRole('img')).toBeNull();
    await user.click(code.getByRole('button', { name: t('devices.pairDialog.done') }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(
      within(await rowOf('Table T7 tablet')).getByText(t('devices.table', { table: 'T7' })),
    ).toBeVisible();
  });

  it('pairs a kitchen screen for one station, opened in a browser: no QR code', async () => {
    const fake = devicesServer().on('POST', CODES, () => ({
      status: 201,
      body: pairingCode({ caSha256: null, serverUrls: [] }),
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(await screen.findByRole('button', { name: t('devices.pair') }));
    const dialog = within(
      await screen.findByRole('dialog', { name: t('devices.pairDialog.title') }),
    );
    await user.selectOptions(
      dialog.getByLabelText(t('devices.pairDialog.type')),
      t('devices.type.KDS'),
    );
    const name = dialog.getByLabelText(new RegExp(`^${t('devices.pairDialog.name')}`));
    expect(name).toHaveValue(t('devices.pairDialog.defaultName.KDS', { number: 1 }));
    const station = dialog.getByLabelText(new RegExp(`^${t('devices.pairDialog.station')}`));
    // Stations in use only: not the archived grill.
    expect(
      within(station)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([t('devices.pairDialog.allStations'), 'Tandoor', 'Curry']);
    await user.selectOptions(station, 'Tandoor');
    // A typed name is kept when the type changes.
    await user.clear(name);
    await user.type(name, 'Tandoor 2');
    await user.selectOptions(
      dialog.getByLabelText(t('devices.pairDialog.type')),
      t('devices.type.WAITER_PHONE'),
    );
    expect(name).toHaveValue('Tandoor 2');
    await user.selectOptions(
      dialog.getByLabelText(t('devices.pairDialog.type')),
      t('devices.type.KDS'),
    );
    await user.click(dialog.getByRole('button', { name: t('devices.pairDialog.create') }));
    const code = within(
      await screen.findByRole('dialog', {
        name: t('devices.pairDialog.codeTitle', { name: 'Tandoor 2' }),
      }),
    );
    expect(fake.callsTo('POST', CODES)[0]?.body).toEqual({
      type: 'KDS',
      name: 'Tandoor 2',
      stationId: TANDOOR,
    });
    expect(code.getByText(t('devices.pairDialog.openConsole'))).toBeVisible();
    expect(code.queryByRole('img')).toBeNull();
    // A development server without TLS: no fingerprint to compare.
    expect(code.queryByText(t('devices.pairDialog.fingerprint'))).toBeNull();
  });

  it('pairs a waiter phone that alerts someone until they sign in', async () => {
    const fake = devicesServer().on('POST', CODES, () => ({ status: 201, body: pairingCode() }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(await screen.findByRole('button', { name: t('devices.pair') }));
    const dialog = within(
      await screen.findByRole('dialog', { name: t('devices.pairDialog.title') }),
    );
    await user.selectOptions(
      dialog.getByLabelText(t('devices.pairDialog.type')),
      t('devices.type.WAITER_PHONE'),
    );
    // Waiter phone 1 exists, so 2 is suggested.
    expect(dialog.getByLabelText(new RegExp(`^${t('devices.pairDialog.name')}`))).toHaveValue(
      t('devices.pairDialog.defaultName.WAITER_PHONE', { number: 2 }),
    );
    const holder = dialog.getByLabelText(new RegExp(`^${t('devices.pairDialog.holder')}`));
    // Active people only: not Priya.
    expect(within(holder).queryByRole('option', { name: 'Priya' })).toBeNull();
    await user.selectOptions(holder, 'Sunil');
    await user.click(dialog.getByRole('button', { name: t('devices.pairDialog.create') }));
    await screen.findByRole('dialog', {
      name: t('devices.pairDialog.codeTitle', { name: 'Waiter phone 2' }),
    });
    expect(fake.callsTo('POST', CODES)[0]?.body).toMatchObject({
      type: 'WAITER_PHONE',
      staffId: expect.any(String) as string,
    });
  });

  it('offers a new code once the code expires, and says why a code could not be made', async () => {
    const fake = devicesServer().on(
      'POST',
      CODES,
      () => ({
        status: 201,
        body: pairingCode({ expiresAt: new Date(Date.now() - 1_000).toISOString() }),
      }),
      () => ({ status: 201, body: pairingCode({ code: 'JKLM-NPQR' }) }),
    );
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(await screen.findByRole('button', { name: t('devices.pair') }));
    const form = within(await screen.findByRole('dialog', { name: t('devices.pairDialog.title') }));
    await user.click(form.getByRole('button', { name: t('devices.pairDialog.create') }));
    const code = within(
      await screen.findByRole('dialog', {
        name: t('devices.pairDialog.codeTitle', { name: 'POS 1' }),
      }),
    );
    expect(code.getByRole('status')).toHaveTextContent(t('devices.pairDialog.expired'));
    await user.click(code.getByRole('button', { name: t('devices.pairDialog.newCode') }));
    expect(await code.findByText('JKLM-NPQR')).toBeVisible();
    expect(code.getByRole('status')).toHaveTextContent(t('devices.pairDialog.waiting'));
    expect(fake.callsTo('POST', CODES).map((call) => call.body)).toEqual([
      { type: 'POS', name: 'POS 1' },
      { type: 'POS', name: 'POS 1' },
    ]);

    await user.click(code.getByRole('button', { name: t('ui.dialog.close') }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    fake.on('POST', CODES, () => ({
      status: 404,
      body: { code: 'TABLE_NOT_FOUND', message: 'That table is no longer on the floor.' },
    }));
    await user.click(await screen.findByRole('button', { name: t('devices.pair') }));
    const again = within(
      await screen.findByRole('dialog', { name: t('devices.pairDialog.title') }),
    );
    await user.click(again.getByRole('button', { name: t('devices.pairDialog.create') }));
    expect(await again.findByRole('alert')).toHaveTextContent(
      'That table is no longer on the floor.',
    );
  });
});

describe('[MGR-006] renaming, moving, locating and unpairing', () => {
  it('renames a device', async () => {
    const fake = devicesServer().on('PATCH', `${DEVICES}/${OFFICE}`, (call) => ({
      status: 200,
      body: { ...device({ id: OFFICE }), name: (call.body as { name: string }).name },
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      within(await actionsFor('Office laptop')).getByRole('button', { name: t('devices.rename') }),
    );
    const dialog = within(
      await screen.findByRole('dialog', {
        name: t('devices.renameDialog.title', { name: 'Office laptop' }),
      }),
    );
    const name = dialog.getByLabelText(new RegExp(`^${t('devices.renameDialog.name')}`));
    expect(name).toHaveFocus();
    await user.clear(name);
    await user.click(dialog.getByRole('button', { name: t('devices.renameDialog.confirm') }));
    expect(dialog.getByText(t('devices.renameDialog.nameRequired'))).toBeVisible();
    await user.type(name, '  Back office  ');
    await user.click(dialog.getByRole('button', { name: t('devices.renameDialog.confirm') }));
    expect(await screen.findByText(t('devices.renamed', { name: 'Back office' }))).toBeVisible();
    expect(fake.callsTo('PATCH', `${DEVICES}/${OFFICE}`).map((call) => call.body)).toEqual([
      { name: 'Back office' },
    ]);
  });

  it('[AUTH-009] [TAB-002] moves a table tablet to another table', async () => {
    const fake = devicesServer().on('PUT', `${DEVICES}/${TABLET_1}/table`, () => ({
      status: 200,
      body: device({ id: TABLET_1, type: 'TABLE_TABLET', name: 'Table H1 tablet', tableId: H2 }),
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      within(await actionsFor('Table H1 tablet')).getByRole('button', { name: t('devices.move') }),
    );
    const dialog = within(
      await screen.findByRole('dialog', {
        name: t('devices.moveDialog.title', { name: 'Table H1 tablet' }),
      }),
    );
    const table = dialog.getByLabelText(new RegExp(`^${t('devices.moveDialog.table')}`));
    // Not the table it serves already.
    expect(
      within(table).queryByRole('option', {
        name: t('devices.pairDialog.tableIn', { table: 'H1', section: 'Hall' }),
      }),
    ).toBeNull();
    expect(dialog.getByRole('button', { name: t('devices.moveDialog.confirm') })).toBeDisabled();
    await user.selectOptions(
      table,
      t('devices.pairDialog.tableIn', { table: 'H2', section: 'Hall' }),
    );
    await user.click(dialog.getByRole('button', { name: t('devices.moveDialog.confirm') }));
    expect(
      await screen.findByText(t('devices.moved', { name: 'Table H1 tablet', table: 'H2' })),
    ).toBeVisible();
    expect(fake.callsTo('PUT', `${DEVICES}/${TABLET_1}/table`)[0]?.body).toEqual({ tableId: H2 });
  });

  it('[AUTH-008] unpairs a device only with a reason', async () => {
    const fake = devicesServer(
      devices(),
      devices().filter((entry) => entry.id !== PHONE_1),
    ).on('POST', `${DEVICES}/${PHONE_1}/revoke`, () => ({
      status: 200,
      body: device({ id: PHONE_1, type: 'WAITER_PHONE', status: 'REVOKED' }),
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      within(await actionsFor('Waiter phone 1')).getByRole('button', { name: t('devices.unpair') }),
    );
    const dialog = within(
      await screen.findByRole('dialog', {
        name: t('devices.unpairDialog.title', { name: 'Waiter phone 1' }),
      }),
    );
    expect(dialog.getByText(t('devices.unpairDialog.description'))).toBeVisible();
    const confirm = dialog.getByRole('button', { name: t('devices.unpairDialog.confirm') });
    expect(confirm).toBeDisabled();
    await user.type(dialog.getByLabelText(t('devices.unpairDialog.reason')), 'Lost');
    await user.click(confirm);
    expect(
      await screen.findByText(t('devices.unpaired', { name: 'Waiter phone 1' })),
    ).toBeVisible();
    expect(fake.callsTo('POST', `${DEVICES}/${PHONE_1}/revoke`)[0]?.body).toEqual({
      reason: 'Lost',
    });
    await waitFor(() => {
      expect(screen.queryByRole('heading', { level: 4, name: 'Waiter phone 1' })).toBeNull();
    });
  });

  it('says that an unpaired pager must be registered again', async () => {
    const { user } = await renderConsole({
      fake: devicesServer(),
      path: PATH,
      signedIn: 'MANAGER',
    });
    await user.click(
      within(await actionsFor('Pager 1')).getByRole('button', { name: t('devices.unpair') }),
    );
    const dialog = within(
      await screen.findByRole('dialog', {
        name: t('devices.unpairDialog.title', { name: 'Pager 1' }),
      }),
    );
    expect(dialog.getByText(t('devices.unpairDialog.pagerDescription'))).toBeVisible();
  });

  it('locates a connected device, and says why when it cannot', async () => {
    const fake = devicesServer().on(
      'POST',
      `${DEVICES}/${KDS_1}/locate`,
      () => ({ status: 204 }),
      () => ({
        status: 409,
        body: {
          code: 'DEVICE_NOT_CONNECTED',
          message: 'Tandoor screen is not connected, so it cannot show itself.',
        },
      }),
    );
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    const locate = within(await actionsFor('Tandoor screen')).getByRole('button', {
      name: t('devices.locate'),
    });
    await user.click(locate);
    expect(await screen.findByText(t('devices.located', { name: 'Tandoor screen' }))).toBeVisible();
    await user.click(locate);
    expect(
      await screen.findByText('Tandoor screen is not connected, so it cannot show itself.'),
    ).toBeVisible();
    expect(fake.callsTo('POST', `${DEVICES}/${KDS_1}/locate`)).toHaveLength(2);
  });
});
