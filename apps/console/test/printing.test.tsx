import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeServer } from './fake-server.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import {
  BAR,
  BAR_PRINTER,
  KITCHEN_PRINTER,
  printers,
  printerView,
  stations,
  stationView,
} from './printing-fixture.js';

const PATH = '/manage/printing';

function printingServer(): FakeServer {
  return signsInAs(server(), 'MANAGER')
    .on('GET', '/api/v1/printers', () => ({ status: 200, body: { printers: printers() } }))
    .on('GET', '/api/v1/stations', () => ({ status: 200, body: { stations: stations() } }))
    .on('POST', '/api/v1/printers', () => ({ status: 201, body: printerView() }))
    .on('POST', '/api/v1/stations', () => ({ status: 201, body: stationView() }))
    .on(
      'POST',
      `/api/v1/printers/${KITCHEN_PRINTER}/test`,
      () => ({ status: 200, body: { printed: true, error: null } }),
      () => ({ status: 200, body: { printed: false, error: 'The printer did not answer.' } }),
    )
    .on('POST', `/api/v1/printers/${KITCHEN_PRINTER}/redirect`, () => ({
      status: 200,
      body: printerView({ redirectToId: BAR_PRINTER }),
    }))
    .on('POST', `/api/v1/stations/${BAR}/archive`, () => ({
      status: 200,
      body: stationView({ id: BAR, archivedAt: '2026-10-01T10:00:00.000Z' }),
    }));
}

const rowOf = async (name: string) =>
  (await screen.findByRole('heading', { level: 4, name })).closest('li') as HTMLElement;
const actionsFor = async (kind: 'printers' | 'stations', name: string) =>
  within(await screen.findByRole('group', { name: t(`printing.${kind}.actionsFor`, { name }) }));

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[KDS-008] [ONB-004] stations and printers', () => {
  it('lists the active printers and stations with how each is doing', async () => {
    const { container, user } = await renderConsole({
      fake: printingServer(),
      path: '/manage',
      signedIn: 'MANAGER',
    });
    await user.click(
      within(screen.getByRole('navigation', { name: t('dashboard.navigation') })).getByRole(
        'link',
        { name: t('dashboard.section.printing') },
      ),
    );
    const kitchen = await rowOf('Kitchen printer');
    expect(
      within(kitchen).getByText(
        [
          t('printing.printers.connection.NETWORK'),
          '192.168.1.50:9100',
          t('printing.printers.paper', { width: 80 }),
        ].join(' · '),
      ),
    ).toBeVisible();
    expect(
      within(kitchen).getByText(t('printing.printers.usedBy', { list: 'Kitchen' })),
    ).toBeVisible();
    expect(within(kitchen).getByText(t('printing.printers.state.ONLINE'))).toBeVisible();
    const bar = await rowOf('Bar printer');
    expect(within(bar).getByText(t('printing.printers.state.UNTESTED'))).toBeVisible();
    expect(within(bar).getByText(t('printing.printers.unused'))).toBeVisible();
    expect(screen.queryByRole('heading', { level: 4, name: 'Old printer' })).toBeNull();

    const station = await rowOf('Bar');
    expect(within(station).getByText(t('printing.stations.mode.SCREEN'))).toBeVisible();
    expect(within(station).getByText(t('printing.stations.noPrinter'))).toBeVisible();
    expect(
      within(await rowOf('Kitchen')).getByText(
        t('printing.stations.printer', { name: 'Kitchen printer' }),
      ),
    ).toBeVisible();
    await expectNoAxeViolations(container);
  });

  it('adds a network printer after checking its address', async () => {
    const fake = printingServer();
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(await screen.findByRole('button', { name: t('printing.printers.add') }));
    const dialog = within(
      await screen.findByRole('dialog', { name: t('printing.printerDialog.addTitle') }),
    );
    await user.type(
      dialog.getByRole('textbox', { name: t('printing.printerDialog.name') }),
      'Tandoor',
    );
    const host = dialog.getByRole('textbox', { name: t('printing.printerDialog.host') });
    await user.type(host, 'http://x');
    await user.click(dialog.getByRole('button', { name: t('printing.printerDialog.save') }));
    expect(dialog.getByText(t('printing.problems.HOST_INVALID'))).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/printers')).toHaveLength(0);

    await user.clear(host);
    await user.type(host, '192.168.1.60');
    await user.selectOptions(
      dialog.getByRole('combobox', { name: t('printing.printerDialog.paper') }),
      t('printing.printerDialog.paperWidth', { width: '58' }),
    );
    await user.click(dialog.getByRole('button', { name: t('printing.printerDialog.save') }));
    expect(
      await screen.findByText(t('printing.printers.added', { name: 'Tandoor' })),
    ).toBeVisible();
    expect(fake.callsTo('POST', '/api/v1/printers')[0]?.body).toEqual({
      name: 'Tandoor',
      connection: 'NETWORK',
      host: '192.168.1.60',
      port: 9100,
      paperWidthMm: 58,
    });
  });

  it('[ONB-004] finds printers on the network and adds one in a tap', async () => {
    const fake = printingServer().on('POST', '/api/v1/printers/discover', () => ({
      status: 200,
      body: {
        networks: ['192.168.1.0/24'],
        printers: [
          {
            host: '192.168.1.50',
            port: 9100,
            printerId: KITCHEN_PRINTER,
            printerName: 'Kitchen printer',
          },
          { host: '192.168.1.61', port: 9100, printerId: null, printerName: null },
        ],
      },
    }));
    const { user, container } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(await screen.findByRole('button', { name: t('printing.printers.find') }));
    const found = within(await screen.findByRole('dialog', { name: t('printing.discover.title') }));
    expect(
      await found.findByText(t('printing.discover.looked', { list: '192.168.1.0/24' })),
    ).toBeVisible();
    expect(
      found.getByText(t('printing.discover.addedAs', { name: 'Kitchen printer' })),
    ).toBeVisible();
    // Only the one not added yet can be added.
    expect(found.getAllByRole('button', { name: /^Add / })).toHaveLength(1);
    await expectNoAxeViolations(container);
    await user.click(found.getByRole('button', { name: /^Add 192\.168\.1\.61/ }));

    const dialog = within(
      await screen.findByRole('dialog', { name: t('printing.printerDialog.addTitle') }),
    );
    expect(dialog.getByRole('textbox', { name: t('printing.printerDialog.host') })).toHaveValue(
      '192.168.1.61',
    );
    await user.click(dialog.getByRole('button', { name: t('printing.printerDialog.save') }));
    await waitFor(() => {
      expect(fake.callsTo('POST', '/api/v1/printers')[0]?.body).toEqual({
        name: 'Printer 192.168.1.61',
        connection: 'NETWORK',
        host: '192.168.1.61',
        port: 9100,
        paperWidthMm: 80,
      });
    });
  });

  it('prints a test page and says whether it printed', async () => {
    const { user } = await renderConsole({
      fake: printingServer(),
      path: PATH,
      signedIn: 'MANAGER',
    });
    const test = async () => {
      await user.click(
        (await actionsFor('printers', 'Kitchen printer')).getByRole('button', {
          name: t('printing.printers.test'),
        }),
      );
    };
    await test();
    expect(
      await screen.findByText(t('printing.printers.testPrinted', { name: 'Kitchen printer' })),
    ).toBeVisible();
    await test();
    expect(
      await screen.findByText(
        t('printing.printers.testFailed', {
          name: 'Kitchen printer',
          error: 'The printer did not answer.',
        }),
      ),
    ).toBeVisible();
  });

  it('sends a broken printer’s tickets to another one, with a reason', async () => {
    const fake = printingServer();
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(
      (await actionsFor('printers', 'Kitchen printer')).getByRole('button', {
        name: t('printing.printers.redirect'),
      }),
    );
    const dialog = within(
      await screen.findByRole('dialog', {
        name: t('printing.redirectDialog.title', { name: 'Kitchen printer' }),
      }),
    );
    await user.type(dialog.getByRole('textbox'), 'Paper jam');
    await user.click(dialog.getByRole('button', { name: t('printing.redirectDialog.confirm') }));
    expect(dialog.getByText(t('printing.redirectDialog.required'))).toBeVisible();
    // Only the other active printer is offered.
    expect(dialog.getAllByRole('option').map((option) => option.textContent)).toEqual([
      t('printing.redirectDialog.choose'),
      'Bar printer',
    ]);
    await user.selectOptions(
      dialog.getByRole('combobox', { name: t('printing.redirectDialog.target') }),
      'Bar printer',
    );
    await user.click(dialog.getByRole('button', { name: t('printing.redirectDialog.confirm') }));
    expect(
      await screen.findByText(
        t('printing.printers.redirectedDone', { name: 'Kitchen printer', target: 'Bar printer' }),
      ),
    ).toBeVisible();
    expect(fake.callsTo('POST', `/api/v1/printers/${KITCHEN_PRINTER}/redirect`)[0]?.body).toEqual({
      toPrinterId: BAR_PRINTER,
      reason: 'Paper jam',
    });
  });

  it('adds a printing station only with a printer, and archives one with a reason', async () => {
    const fake = printingServer();
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await user.click(await screen.findByRole('button', { name: t('printing.stations.add') }));
    const dialog = within(
      await screen.findByRole('dialog', { name: t('printing.stationDialog.addTitle') }),
    );
    await user.type(
      dialog.getByRole('textbox', { name: t('printing.stationDialog.name') }),
      'Tandoor',
    );
    await user.click(dialog.getByRole('radio', { name: t('printing.stations.mode.PRINT') }));
    await user.click(dialog.getByRole('button', { name: t('printing.stationDialog.save') }));
    expect(dialog.getByText(t('printing.problems.PRINTER_REQUIRED'))).toBeVisible();
    await user.selectOptions(
      dialog.getByRole('combobox', { name: t('printing.stationDialog.printer') }),
      'Kitchen printer',
    );
    await user.click(dialog.getByRole('button', { name: t('printing.stationDialog.save') }));
    await waitFor(() => {
      expect(fake.callsTo('POST', '/api/v1/stations')[0]?.body).toEqual({
        name: 'Tandoor',
        mode: 'PRINT',
        printerId: KITCHEN_PRINTER,
      });
    });

    await user.click(
      (await actionsFor('stations', 'Bar')).getByRole('button', {
        name: t('printing.stations.archive'),
      }),
    );
    const archive = within(
      await screen.findByRole('dialog', {
        name: t('printing.archiveStationDialog.title', { name: 'Bar' }),
      }),
    );
    await user.type(archive.getByRole('textbox'), 'Bar closed');
    await user.click(archive.getByRole('button', { name: t('printing.stations.archive') }));
    expect(await screen.findByText(t('printing.stations.archived', { name: 'Bar' }))).toBeVisible();
    expect(fake.callsTo('POST', `/api/v1/stations/${BAR}/archive`)[0]?.body).toEqual({
      reason: 'Bar closed',
    });
  });
});
