import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_REFRESH_MS } from '../src/manage/devices/DevicesScreen.js';
import {
  BAR,
  deviceList,
  deviceView,
  KDS_TANDOOR,
  pairingCode,
  stationList,
  TABLET_T7,
  TANDOOR,
} from './devices-fixture.js';
import type { FakeResponse, FakeServer } from './fake-server.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import { changed, crewList, sectionsFloor, T8 } from './sections-fixture.js';

const PATH = '/manage/devices';
const DEVICES = '/api/v1/devices';

function devicesServer(...lists: ReturnType<typeof deviceList>[]): FakeServer {
  const answers = (lists.length === 0 ? [deviceList()] : lists).map((body) => (): FakeResponse => ({
    status: 200,
    body,
  }));
  return signsInAs(server(), 'MANAGER')
    .on('GET', '/api/v1/floor', () => ({ status: 200, body: sectionsFloor() }))
    .on('GET', '/api/v1/stations', () => ({ status: 200, body: stationList() }))
    .on('GET', '/api/v1/staff', () => ({ status: 200, body: crewList() }))
    .on('GET', DEVICES, ...answers);
}

const rowOf = async (name: string) =>
  (await screen.findByRole('heading', { level: 4, name: new RegExp(`^${name}`) })).closest(
    'li',
  ) as HTMLElement;
const actionsFor = (name: string) =>
  screen.findByRole('group', { name: t('devices.actionsFor', { name }) });

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('[MGR-006] the device list', () => {
  it('shows every device by type with its binding and state in words', async () => {
    const { container } = await renderConsole({
      fake: devicesServer(),
      path: PATH,
      signedIn: 'MANAGER',
    });
    expect(
      await screen.findByRole('heading', { level: 2, name: t('devices.title') }),
    ).toBeVisible();
    for (const type of ['POS', 'KDS', 'WAITER_PHONE', 'TABLE_TABLET', 'PAGER'] as const) {
      expect(
        screen.getByRole('heading', { level: 3, name: t(`devices.type.${type}`) }),
      ).toBeVisible();
    }

    const pos = await rowOf('Counter POS');
    expect(within(pos).getByText(t('devices.thisDevice'))).toBeVisible();
    // The device in use cannot be unpaired from itself.
    expect(
      within(await actionsFor('Counter POS'))
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([t('devices.rename')]);

    const tablet = await rowOf('Tablet T7');
    expect(within(tablet).getByText(t('devices.forTable', { table: 'T7' }))).toBeVisible();
    expect(within(tablet).getByText(t('devices.connected'))).toBeVisible();
    expect(within(tablet).getByText(t('devices.batteryCharging', { percent: 42 }))).toBeVisible();
    expect(within(tablet).getByText(t('devices.network.WIFI'), { exact: false })).toBeVisible();
    expect(
      within(await actionsFor('Tablet T7'))
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([
      t('devices.rename'),
      t('devices.moveTable'),
      t('devices.locate'),
      t('devices.unpair'),
    ]);

    const kds = await rowOf('Tandoor screen');
    expect(within(kds).getByText(t('devices.forStation', { station: 'Tandoor' }))).toBeVisible();
    expect(within(kds).getByText(t('devices.notConnected'))).toBeVisible();
    // 04:30 UTC on 28 September is 10:00 in the restaurant (IST).
    expect(
      within(kds).getByText(t('devices.lastSeen', { date: '28-09-2026', time: '10:00' })),
    ).toBeVisible();

    const phone = await rowOf('Waiter phone 1');
    expect(within(phone).getByText(t('devices.forPerson', { name: 'Ravi' }))).toBeVisible();
    expect(
      within(phone).getByText(
        `${t('devices.appVersion', { version: '1.4.0' })} · ${t('devices.neverSeen')}`,
      ),
    ).toBeVisible();

    const pager = await rowOf('Pager 1');
    expect(within(pager).getByText(t('devices.battery', { percent: 80 }))).toBeVisible();

    // Unpaired devices are kept, folded away, without actions.
    expect(screen.getByText(t('devices.unpairedCount', { count: 1 }))).toBeVisible();
    expect(
      screen.queryByRole('group', { name: t('devices.actionsFor', { name: 'Old phone' }) }),
    ).toBeNull();
    await expectNoAxeViolations(container);
  });

  it('says when there are no devices yet', async () => {
    const empty = devicesServer({ devices: [] });
    await renderConsole({ fake: empty, path: PATH, signedIn: 'MANAGER' });
    expect(await screen.findByText(t('devices.none'))).toBeVisible();
  });

  it('is linked only for people who pair devices', async () => {
    const fake = signsInAs(server(), 'CASHIER');
    await renderConsole({ fake, path: PATH, signedIn: 'CASHIER' });
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: t('dashboard.section.devices') })).toBeNull();
    });
    expect(fake.callsTo('GET', DEVICES)).toHaveLength(0);
  });

  it('follows device changes from other screens and reads connections again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setInterval', 'clearInterval'] });
    const renamed = deviceList();
    renamed.devices[2] = { ...renamed.devices[2]!, name: 'Grill screen' };
    const reconnected = structuredClone(renamed);
    reconnected.devices[2] = { ...reconnected.devices[2]!, connected: true };
    const fake = devicesServer(deviceList(), renamed, reconnected);
    const { sockets } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await rowOf('Tandoor screen');
    act(() => {
      sockets.sync(0);
      sockets.last.fire('event', changed(1, 'DEVICES'));
    });
    const row = await rowOf('Grill screen');
    expect(within(row).getByText(t('devices.notConnected'))).toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(DEVICE_REFRESH_MS));
    expect(
      await within(await rowOf('Grill screen')).findByText(t('devices.connected')),
    ).toBeVisible();
  });
});

describe('[UPD-006] apps to update', () => {
  it('marks an app to update soon, one the server no longer serves, and one ahead of it', async () => {
    const list = deviceList();
    const [pos, tablet, kds, ...rest] = list.devices;
    const fake = devicesServer({
      devices: [
        { ...pos!, compatibility: 'UNKNOWN', clientApi: null },
        { ...tablet!, compatibility: 'PREVIOUS', clientApi: '1.3' },
        { ...kds!, compatibility: 'TOO_OLD', clientApi: '1.2' },
        ...rest.map((device, index) =>
          index === 0 ? { ...device, compatibility: 'NEWER' as const, clientApi: '1.5' } : device,
        ),
      ],
    });
    await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    const tabletRow = within(await rowOf('Tablet T7'));
    expect(tabletRow.getByText(t('devices.compatibility.PREVIOUS'))).toHaveAttribute(
      'title',
      t('devices.compatibilityHint.PREVIOUS'),
    );
    expect(
      within(await rowOf('Tandoor screen')).getByText(t('devices.compatibility.TOO_OLD')),
    ).toBeVisible();
    expect(
      within(await rowOf(rest[0]!.name)).getByText(t('devices.compatibility.NEWER')),
    ).toBeVisible();
    // Current and unknown say nothing.
    const posRow = within(await rowOf('Counter POS'));
    for (const compatibility of ['PREVIOUS', 'TOO_OLD', 'NEWER'] as const) {
      expect(posRow.queryByText(t(`devices.compatibility.${compatibility}`))).toBeNull();
    }
  });
});

describe('[AUTH-007] [AUTH-009] pairing a device', () => {
  it('asks what the device is, then shows its one-time code, addresses and fingerprint', async () => {
    const fake = devicesServer().on('POST', '/api/v1/devices/pairing-codes', () => ({
      status: 201,
      body: pairingCode(),
    }));
    const { user, container } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(await screen.findByRole('button', { name: t('devices.pair') }));
    const form = within(await screen.findByRole('dialog', { name: t('devices.pairForm.title') }));
    // A table tablet is suggested first, with the next free name; it needs its table.
    expect(form.getByLabelText(t('devices.pairForm.type'))).toHaveValue('TABLE_TABLET');
    expect(form.getByLabelText(new RegExp(`^${t('devices.pairForm.name')}`))).toHaveValue(
      'Table tablet 1',
    );
    await user.click(form.getByRole('button', { name: t('devices.pairForm.create') }));
    expect(form.getByText(t('devices.pairForm.tableRequired'))).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/devices/pairing-codes')).toHaveLength(0);

    // Changing the type follows with the name and the binding it needs.
    await user.selectOptions(form.getByLabelText(t('devices.pairForm.type')), 'KDS');
    expect(form.getByLabelText(new RegExp(`^${t('devices.pairForm.name')}`))).toHaveValue(
      'Kitchen screen 1',
    );
    expect(form.queryByLabelText(new RegExp(`^${t('devices.pairForm.table')}`))).toBeNull();
    // KDS-002: one or more stations; the archived grill is not offered.
    const stations = within(form.getByRole('group', { name: t('devices.pairForm.stations') }));
    expect(stations.queryByLabelText('Grill')).toBeNull();
    await user.click(stations.getByLabelText('Tandoor'));
    await user.click(stations.getByLabelText('Bar'));
    await user.click(form.getByRole('button', { name: t('devices.pairForm.create') }));

    const shown = within(
      await screen.findByRole('dialog', {
        name: t('devices.codeDialog.title', { name: 'Kitchen screen 1' }),
      }),
    );
    expect(fake.callsTo('POST', '/api/v1/devices/pairing-codes')[0]?.body).toEqual({
      type: 'KDS',
      name: 'Kitchen screen 1',
      stationIds: [TANDOOR, BAR],
    });
    expect(shown.getByText('ABCD-EFGH')).toBeVisible();
    expect(shown.getByText('https://192.168.1.20:8443')).toBeVisible();
    expect(shown.getByText(pairingCode().caSha256 ?? '')).toBeVisible();
    expect(
      shown.getByRole('img', {
        name: t('devices.codeDialog.qrLabel', { name: 'Kitchen screen 1' }),
      }),
    ).toBeVisible();
    await expectNoAxeViolations(container);
    await user.click(shown.getByRole('button', { name: t('devices.codeDialog.done') }));
    await waitFor(() => {
      expect(screen.queryByText('ABCD-EFGH')).toBeNull();
    });
  });

  it('replaces an expired code in one press', async () => {
    const fake = devicesServer().on(
      'POST',
      '/api/v1/devices/pairing-codes',
      () => ({ status: 201, body: pairingCode({ expiresAt: '2020-01-01T00:00:00.000Z' }) }),
      () => ({ status: 201, body: pairingCode({ code: 'WXYZ-2345' }) }),
    );
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(await screen.findByRole('button', { name: t('devices.pair') }));
    const form = within(await screen.findByRole('dialog', { name: t('devices.pairForm.title') }));
    await user.selectOptions(form.getByLabelText(t('devices.pairForm.type')), 'POS');
    await user.click(form.getByRole('button', { name: t('devices.pairForm.create') }));
    expect(await screen.findByText(t('devices.codeDialog.expired'))).toBeVisible();
    await user.click(screen.getByRole('button', { name: t('devices.codeDialog.newCode') }));
    expect(await screen.findByText('WXYZ-2345')).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/devices/pairing-codes')).toHaveLength(2);
  });
});

describe('[MGR-006] [AUTH-008] [AUTH-009] changing a device', () => {
  it('renames a device', async () => {
    const fake = devicesServer().on('PATCH', `${DEVICES}/${KDS_TANDOOR}`, () => ({
      status: 200,
      body: deviceView({ id: KDS_TANDOOR, type: 'KDS', name: 'Grill screen' }),
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      within(await actionsFor('Tandoor screen')).getByRole('button', { name: t('devices.rename') }),
    );
    const dialog = within(
      await screen.findByRole('dialog', {
        name: t('devices.renameDialog.title', { name: 'Tandoor screen' }),
      }),
    );
    const field = dialog.getByLabelText(new RegExp(`^${t('devices.renameDialog.name')}`));
    await user.clear(field);
    await user.type(field, 'Grill screen');
    await user.click(dialog.getByRole('button', { name: t('devices.renameDialog.save') }));
    expect(await screen.findByText(t('devices.renamed', { name: 'Grill screen' }))).toBeVisible();
    expect(fake.callsTo('PATCH', `${DEVICES}/${KDS_TANDOOR}`)[0]?.body).toEqual({
      name: 'Grill screen',
    });
  });

  it('[KDS-002] gives a kitchen screen more stations', async () => {
    const fake = devicesServer().on('PUT', `${DEVICES}/${KDS_TANDOOR}/stations`, () => ({
      status: 200,
      body: deviceView({
        id: KDS_TANDOOR,
        type: 'KDS',
        name: 'Tandoor screen',
        tableId: null,
        stationId: TANDOOR,
        stationIds: [TANDOOR, BAR],
      }),
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      within(await actionsFor('Tandoor screen')).getByRole('button', {
        name: t('devices.stations'),
      }),
    );
    const dialog = within(
      await screen.findByRole('dialog', {
        name: t('devices.stationsDialog.title', { name: 'Tandoor screen' }),
      }),
    );
    expect(dialog.getByLabelText('Tandoor')).toBeChecked();
    await user.click(dialog.getByLabelText('Bar'));
    await user.click(dialog.getByRole('button', { name: t('devices.stationsDialog.save') }));
    expect(
      await screen.findByText(t('devices.stationsChanged', { name: 'Tandoor screen' })),
    ).toBeVisible();
    expect(fake.callsTo('PUT', `${DEVICES}/${KDS_TANDOOR}/stations`)[0]?.body).toEqual({
      stationIds: [TANDOOR, BAR],
    });
  });

  it('[MGR-006] locates a connected table tablet', async () => {
    const fake = devicesServer().on('POST', `${DEVICES}/${TABLET_T7}/locate`, () => ({
      status: 200,
      body: { seconds: 15 },
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      within(await actionsFor('Tablet T7')).getByRole('button', {
        name: t('devices.locateNamed', { name: 'Tablet T7' }),
      }),
    );
    expect(
      await screen.findByText(t('devices.locating', { name: 'Tablet T7', seconds: 15 })),
    ).toBeVisible();
    expect(fake.callsTo('POST', `${DEVICES}/${TABLET_T7}/locate`)).toHaveLength(1);
    // A kitchen screen that is not connected offers no Locate.
    expect(
      within(await actionsFor('Tandoor screen')).queryByRole('button', {
        name: t('devices.locateNamed', { name: 'Tandoor screen' }),
      }),
    ).toBeNull();
  });

  it('moves a table tablet to another table', async () => {
    const fake = devicesServer().on('PUT', `${DEVICES}/${TABLET_T7}/table`, () => ({
      status: 200,
      body: deviceView({ tableId: T8 }),
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      within(await actionsFor('Tablet T7')).getByRole('button', { name: t('devices.moveTable') }),
    );
    const dialog = within(
      await screen.findByRole('dialog', {
        name: t('devices.moveDialog.title', { name: 'Tablet T7' }),
      }),
    );
    const table = dialog.getByLabelText(t('devices.moveDialog.table'));
    // The table it serves now is not offered.
    expect(within(table).queryByRole('option', { name: /^T7/ })).toBeNull();
    await user.selectOptions(table, T8);
    await user.click(dialog.getByRole('button', { name: t('devices.moveDialog.move') }));
    expect(
      await screen.findByText(t('devices.moved', { name: 'Tablet T7', table: 'T8' })),
    ).toBeVisible();
    expect(fake.callsTo('PUT', `${DEVICES}/${TABLET_T7}/table`)[0]?.body).toEqual({ tableId: T8 });
  });

  it('unpairs a device only with a reason, after asking', async () => {
    const fake = devicesServer().on('POST', `${DEVICES}/${TABLET_T7}/revoke`, () => ({
      status: 200,
      body: deviceView({ status: 'REVOKED' }),
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      within(await actionsFor('Tablet T7')).getByRole('button', { name: t('devices.unpair') }),
    );
    const dialog = within(
      await screen.findByRole('dialog', {
        name: t('devices.unpairDialog.title', { name: 'Tablet T7' }),
      }),
    );
    await user.click(dialog.getByRole('button', { name: t('devices.unpairDialog.confirm') }));
    expect(dialog.getByText(t('devices.unpairDialog.reasonRequired'))).toBeVisible();
    expect(fake.callsTo('POST', `${DEVICES}/${TABLET_T7}/revoke`)).toHaveLength(0);
    await user.type(
      dialog.getByLabelText(new RegExp(`^${t('devices.unpairDialog.reason')}`)),
      'Screen cracked',
    );
    await user.click(dialog.getByRole('button', { name: t('devices.unpairDialog.confirm') }));
    expect(await screen.findByText(t('devices.unpaired', { name: 'Tablet T7' }))).toBeVisible();
    expect(fake.callsTo('POST', `${DEVICES}/${TABLET_T7}/revoke`)[0]?.body).toEqual({
      reason: 'Screen cracked',
    });
  });

  it('says why a change was refused', async () => {
    const fake = devicesServer().on('PATCH', `${DEVICES}/${KDS_TANDOOR}`, () => ({
      status: 409,
      body: { code: 'DEVICE_REVOKED', message: 'This device is unpaired. Pair it again first.' },
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      within(await actionsFor('Tandoor screen')).getByRole('button', { name: t('devices.rename') }),
    );
    const dialog = within(await screen.findByRole('dialog'));
    await user.click(dialog.getByRole('button', { name: t('devices.renameDialog.save') }));
    expect(await dialog.findByText('This device is unpaired. Pair it again first.')).toBeVisible();
  });
});
