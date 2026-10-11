import type { SystemView } from '@rp/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_REFRESH_MS } from '../src/manage/system/SystemScreen.js';
import type { FakeResponse, FakeServer } from './fake-server.js';
import { login, RESTAURANT_ID } from './fakes.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import { approval, NOW, offered, systemView, updates, withSupport } from './system-fixture.js';

const PATH = '/manage/system';
const SYSTEM = '/api/v1/system';
const INSTALL = '/api/v1/system/updates/install-now';
const DIAGNOSTICS = '/api/v1/system/diagnostics';

/** A server whose System page answers each read in turn (the last one again after that). */
function systemServer(...views: SystemView[]): FakeServer {
  return signsInAs(server(), 'MANAGER').on(
    'GET',
    SYSTEM,
    ...views.map((view) => (): FakeResponse => ({ status: 200, body: view })),
  );
}

const part = (name: string) => screen.findByRole('region', { name });
const toasts = () => screen.getByRole('region', { name: t('ui.toast.region') });
const installButton = async () =>
  within(await part(t('system.updates.title'))).getByRole('button', {
    name: t('system.updates.installNow'),
  });
const diagnosticsButton = () => screen.findByRole('button', { name: t('system.diagnostics.send') });
const termsOf = (region: HTMLElement) =>
  [...region.querySelectorAll('dt')].map((term) => term.textContent);

/** A table closing, as the live connection delivers it. */
function tableClosed(sequence: number) {
  return {
    sequence,
    event: {
      eventId: `0199a0e0-0000-7000-8000-0000000009${String(sequence).padStart(2, '0')}`,
      type: 'TableClosed',
      version: 1,
      occurredAt: NOW,
      restaurantId: RESTAURANT_ID,
      businessDate: '2026-10-11',
      payload: {
        tableId: '0199a0e0-0000-7000-8000-000000000a71',
        tableSessionId: '0199a0e0-0000-7000-8000-000000000a72',
      },
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('[MGR-010] [NFR-I03] the System page', () => {
  it('[DATA-006] [LIC-008] shows versions, services, devices, storage, backups, the licence and updates', async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(new Date(NOW));
    const { container } = await renderConsole({
      fake: systemServer(systemView()),
      path: PATH,
      signedIn: 'MANAGER',
    });
    expect(await screen.findByRole('heading', { level: 2, name: t('system.title') })).toBeVisible();

    const versions = await part(t('system.versions.title'));
    expect(termsOf(versions)).toEqual([
      t('system.versions.product'),
      t('system.versions.server'),
      t('system.versions.node'),
      t('system.versions.postgres'),
    ]);
    expect(versions).toHaveTextContent('16.4');
    expect(within(versions).getByText('Running for 3 days 4 h')).toBeVisible();

    const services = await part(t('system.services.title'));
    expect(within(services).getByText('Answers in 2 ms')).toBeVisible();
    expect(within(services).getByText('3 pagers connected, on port 8883, encrypted')).toBeVisible();
    // The printers need attention: in words, not only in colour (NFR-U05).
    expect(within(services).getAllByText(t('system.status.ok'))).toHaveLength(3);
    expect(within(services).getByText(t('system.status.problem'))).toBeVisible();
    expect(within(services).getByText('1 of 2 not printing; 4 tickets waiting')).toBeVisible();
    expect(within(services).getByText('Last report at 11:45')).toBeVisible();

    const devices = await part(t('system.devices.title'));
    expect(termsOf(devices)).toEqual([
      t('devices.group.POS'),
      t('devices.group.KDS'),
      t('devices.group.TABLE_TABLET'),
    ]);
    expect(within(devices).getByText('9 of 10 connected')).toBeVisible();

    const storage = await part(t('system.storage.title'));
    expect(within(storage).getByText(t('system.storage.level.WARNING'))).toBeVisible();
    expect(
      within(storage).getByText('The data drive is 86% full, with 14 GB free of 100 GB.'),
    ).toBeVisible();
    expect(within(storage).getByLabelText(t('system.storage.meter'))).toHaveAttribute(
      'value',
      '86',
    );
    expect(within(storage).getByText('Managers are warned at 80% and 90%.')).toBeVisible();
    expect(termsOf(storage)).toEqual([
      t('system.storage.category.TRANSACTIONS'),
      t('system.storage.category.AUDIT'),
      t('system.storage.category.PHOTOS'),
      t('system.storage.category.LOGS'),
      t('system.storage.category.BACKUPS'),
    ]);
    expect(within(storage).getByText(t('system.storage.notMeasured'))).toBeVisible();

    const backups = await part(t('system.backups.title'));
    expect(within(backups).getByText(t('system.backups.never'))).toBeVisible();
    expect(within(backups).getByText(t('system.backups.walMode.CONTINUOUS'))).toBeVisible();
    expect(within(backups).getByText('7 daily and 4 weekly backups')).toBeVisible();
    expect(within(backups).getByText(t('system.backups.cloudOn'))).toBeVisible();

    const licence = await part(t('system.licence.title'));
    expect(within(licence).getByText(t('system.licence.none'))).toBeVisible();

    const update = await part(t('system.updates.title'));
    expect(within(update).getByText('Version 1.0.0')).toBeVisible();
    expect(within(update).getByText(t('system.updates.channel.STABLE'))).toBeVisible();
    expect(within(update).getByText('Version 1.1.0 is ready to install (50 MB).')).toBeVisible();
    expect(within(update).getByText('What is new: Faster bill printing')).toBeVisible();
    expect(
      within(update).getByText(
        'Updates install between 03:00 and 06:00, while every table is closed.',
      ),
    ).toBeVisible();
    expect(await installButton()).toBeEnabled();
    expect(await diagnosticsButton()).toBeEnabled();
    await expectNoAxeViolations(container);
  });

  it('shows the licence state with the days left once activated', async () => {
    await renderConsole({
      fake: systemServer(
        systemView({
          licence: { state: 'PAYMENT_DUE', daysLeft: 5, validUntil: '2026-10-16T00:00:00.000Z' },
        }),
      ),
      path: PATH,
      signedIn: 'MANAGER',
    });
    const licence = await part(t('system.licence.title'));
    expect(await within(licence).findByText(t('system.licence.state.PAYMENT_DUE'))).toBeVisible();
    expect(within(licence).getByText('5 days left')).toBeVisible();
  });

  it('is linked from the dashboard for people who configure operations', async () => {
    const { user } = await renderConsole({
      fake: systemServer(systemView()),
      path: '/manage',
      signedIn: 'MANAGER',
    });
    const nav = await screen.findByRole('navigation', { name: t('dashboard.navigation') });
    await user.click(within(nav).getByRole('link', { name: t('dashboard.section.system') }));
    expect(await screen.findByRole('heading', { level: 2, name: t('system.title') })).toBeVisible();
  });

  it('reads the details again every minute and after table changes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setInterval', 'clearInterval'] });
    const later = systemView({ uptimeSeconds: 3 * 86_400 + 5 * 3_600 });
    const fake = systemServer(systemView(), later, systemView({ uptimeSeconds: 4 * 86_400 }));
    const { sockets } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    expect(await screen.findByText('Running for 3 days 4 h')).toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(SYSTEM_REFRESH_MS));
    expect(await screen.findByText('Running for 3 days 5 h')).toBeVisible();
    act(() => {
      sockets.sync(0);
      sockets.last.fire('event', tableClosed(1));
    });
    expect(await screen.findByText('Running for 4 days 0 h')).toBeVisible();
    expect(fake.callsTo('GET', SYSTEM)).toHaveLength(3);
  });

  it('offers to try again when the details cannot be read', async () => {
    const fake = signsInAs(server(), 'MANAGER').on(
      'GET',
      SYSTEM,
      () => ({ status: 503, body: { code: 'UNAVAILABLE', message: 'The server is starting.' } }),
      () => ({ status: 200, body: systemView() }),
    );
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    expect(await screen.findByText(t('system.loadFailed'))).toBeVisible();
    expect(screen.getByText('The server is starting.')).toBeVisible();
    // Diagnostics waits until the page knows the support link.
    expect(await diagnosticsButton()).toBeDisabled();
    await user.click(screen.getByRole('button', { name: t('states.retry') }));
    expect(await part(t('system.versions.title'))).toBeVisible();
    expect(await diagnosticsButton()).toBeEnabled();
  });
});

describe('[UPD-004] "Install now"', () => {
  it('cannot install while a table is open, and installs once the tables close', async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(new Date(NOW));
    const fake = systemServer(
      systemView({ updates: updates({ openTables: 1 }) }),
      systemView(),
      systemView({ updates: updates({ approval: approval() }) }),
    ).on('POST', INSTALL, () => ({
      status: 200,
      body: updates({ approval: approval() }),
    }));
    const { user, sockets } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });

    const update = await part(t('system.updates.title'));
    expect(
      await within(update).findByText('1 table is open, so it cannot install now.'),
    ).toBeVisible();
    expect(await installButton()).toBeDisabled();

    // The last table closes: the page follows it live.
    act(() => {
      sockets.sync(0);
      sockets.last.fire('event', tableClosed(1));
    });
    await waitFor(async () => {
      expect(await installButton()).toBeEnabled();
    });
    expect(within(update).queryByText('1 table is open, so it cannot install now.')).toBeNull();

    await user.click(await installButton());
    const dialog = await screen.findByRole('dialog', {
      name: t('system.install.title', { version: '1.1.0' }),
    });
    expect(within(dialog).getByText(t('system.install.description'))).toBeVisible();
    // A release that is not a security update needs no reason.
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: t('system.install.confirm') }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(fake.callsTo('POST', INSTALL).map((call) => call.body)).toEqual([{ version: '1.1.0' }]);
    expect(
      within(toasts()).getByText(t('system.install.approved', { version: '1.1.0' })),
    ).toBeVisible();
    expect(
      await within(update).findByText('Installation approved by Meera at 12:05.'),
    ).toBeVisible();
    expect(
      within(update).queryByRole('button', { name: t('system.updates.installNow') }),
    ).toBeNull();
  });

  it('installs a security update while tables are open once the manager says why', async () => {
    const security = updates({ openTables: 2, offered: offered({ securityCritical: true }) });
    const fake = systemServer(
      systemView({ updates: security }),
      systemView({
        updates: { ...security, approval: approval({ reason: 'Card payments fail' }) },
      }),
    ).on('POST', INSTALL, () => ({
      status: 200,
      body: { ...security, approval: approval({ reason: 'Card payments fail' }) },
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });

    const update = await part(t('system.updates.title'));
    expect(await within(update).findByText(t('system.updates.security'))).toBeVisible();
    expect(
      within(update).getByText(
        '2 tables are open. A security update can install anyway once you say why.',
      ),
    ).toBeVisible();
    await user.click(await installButton());
    const dialog = await screen.findByRole('dialog', {
      name: t('system.install.title', { version: '1.1.0' }),
    });
    expect(within(dialog).getByText(t('system.install.security'))).toBeVisible();

    // Without a reason nothing is sent.
    await user.click(within(dialog).getByRole('button', { name: t('system.install.confirm') }));
    expect(within(dialog).getByText(t('system.install.reasonShort'))).toBeVisible();
    expect(fake.callsTo('POST', INSTALL)).toHaveLength(0);

    await user.type(
      within(dialog).getByRole('textbox', { name: t('system.install.reason') }),
      '  Card payments fail ',
    );
    await user.click(within(dialog).getByRole('button', { name: t('system.install.confirm') }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(fake.callsTo('POST', INSTALL).map((call) => call.body)).toEqual([
      { version: '1.1.0', reason: 'Card payments fail' },
    ]);
    expect(await within(update).findByText(/^Installation approved by Meera/)).toBeVisible();
  });

  it('shows why the server refused and keeps the dialog open', async () => {
    const fake = systemServer(systemView()).on('POST', INSTALL, () => ({
      status: 409,
      body: {
        code: 'TABLES_OPEN',
        message:
          '1 table is open. An update installs only when every table is closed: settle or free them, then press Install now again.',
      },
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(await installButton());
    const dialog = await screen.findByRole('dialog', {
      name: t('system.install.title', { version: '1.1.0' }),
    });
    await user.click(within(dialog).getByRole('button', { name: t('system.install.confirm') }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '1 table is open. An update installs only when every table is closed',
    );
    await user.click(within(dialog).getByRole('button', { name: t('settings.dialog.cancel') }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('[AUTH-012] is not offered to people who may not install updates', async () => {
    // A manager whose custom role reads the System page but does not install updates.
    const reader = login('MANAGER');
    const fake = systemServer(systemView()).on('POST', '/api/v1/auth/pin-login', () => ({
      status: 200,
      body: {
        ...reader,
        staff: {
          ...reader.staff,
          customRole: {
            id: '0199a0e0-0000-7000-8000-000000000c02',
            name: 'Night manager',
            added: [],
            removed: ['UPDATE_INSTALL_NOW'],
          },
        },
      },
    }));
    await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    const update = await part(t('system.updates.title'));
    expect(
      await within(update).findByText('Version 1.1.0 is ready to install (50 MB).'),
    ).toBeVisible();
    expect(
      within(update).queryByRole('button', { name: t('system.updates.installNow') }),
    ).toBeNull();
  });

  it('says when no update is waiting', async () => {
    await renderConsole({
      fake: systemServer(systemView({ updates: updates({ offered: null }) })),
      path: PATH,
      signedIn: 'MANAGER',
    });
    const update = await part(t('system.updates.title'));
    expect(await within(update).findByText(t('system.updates.upToDate'))).toBeVisible();
    expect(
      within(update).queryByRole('button', { name: t('system.updates.installNow') }),
    ).toBeNull();
  });
});

describe('[UPD-008] "Send diagnostics to support"', () => {
  it('sends the health report now and says when it arrived', async () => {
    const fake = systemServer(systemView(), systemView()).on('POST', DIAGNOSTICS, () => ({
      status: 200,
      body: { sentAt: '2026-10-11T06:31:00.000Z' },
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await part(t('system.versions.title'));
    await user.click(await diagnosticsButton());
    expect(
      await within(toasts()).findByText(t('system.diagnostics.sent', { time: '12:01' })),
    ).toBeVisible();
    expect(fake.callsTo('POST', DIAGNOSTICS)).toHaveLength(1);
    // The support link's last report is read again.
    await waitFor(() => {
      expect(fake.callsTo('GET', SYSTEM)).toHaveLength(2);
    });
  });

  it('says why the report did not reach support', async () => {
    const fake = systemServer(systemView()).on('POST', DIAGNOSTICS, () => ({
      status: 503,
      body: {
        code: 'SUPPORT_UNREACHABLE',
        message:
          'Support could not be reached. Check the internet connection and try again; the restaurant keeps working meanwhile.',
      },
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await part(t('system.versions.title'));
    await user.click(await diagnosticsButton());
    expect(await within(toasts()).findByRole('alert')).toHaveTextContent(
      'Support could not be reached. Check the internet connection and try again',
    );
    expect(await diagnosticsButton()).toBeEnabled();
  });

  it('cannot send before this PC is linked to support', async () => {
    await renderConsole({
      fake: systemServer(withSupport({ enrolled: false, lastReportAt: null })),
      path: PATH,
      signedIn: 'MANAGER',
    });
    const services = await part(t('system.services.title'));
    expect(await within(services).findByText(t('system.services.supportNotLinked'))).toBeVisible();
    expect(await diagnosticsButton()).toBeDisabled();
  });
});
