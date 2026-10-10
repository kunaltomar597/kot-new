import type { PrinterView, StationView } from '@rp/contracts';
import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeResponse, FakeServer } from './fake-server.js';
import {
  BAR,
  BAR_ERROR,
  BAR_PRINTER,
  CURRY,
  KITCHEN_PRINTER,
  NEW_PRINTER,
  NEW_STATION,
  printer,
  printers,
  printerStatusChanged,
  station,
  stations,
  TANDOOR,
} from './floor-fixture.js';
import { expectNoAxeViolations, renderConsole, server, signsInAs, t } from './harness.js';
import { changed } from './sections-fixture.js';

const PATH = '/manage/settings/printing';
const PRINTERS = '/api/v1/printers';
const STATIONS = '/api/v1/stations';
/** 11:30 in the restaurant (IST) on 27 September, the day the fixture printers last printed. */
const NOW = '2026-09-27T06:00:00.000Z';
const PASS_ERROR =
  'No printer answers at 192.168.1.70 port 9100. Check that it is on and connected.';

/** Answers the printers and the stations with each list in turn, then the last one from then on. */
function printingServer(
  options: { printers?: PrinterView[][]; stations?: StationView[][] } = {},
): FakeServer {
  const printerAnswers = (options.printers ?? [printers()]).map((list) => (): FakeResponse => ({
    status: 200,
    body: { printers: list },
  }));
  const stationAnswers = (options.stations ?? [stations()]).map((list) => (): FakeResponse => ({
    status: 200,
    body: { stations: list },
  }));
  return signsInAs(server(), 'MANAGER')
    .on('GET', PRINTERS, ...printerAnswers)
    .on('GET', STATIONS, ...stationAnswers);
}

const refusal = (status: number, code: string, message: string): FakeResponse => ({
  status,
  body: { code, message },
});

const printerActions = (name: string) =>
  screen.findByRole('group', { name: t('printing.printers.actionsFor', { name }) });
const stationActions = (name: string) =>
  screen.findByRole('group', { name: t('printing.stations.actionsFor', { name }) });
const rowOf = async (group: Promise<HTMLElement>) => (await group).closest('li') as HTMLElement;
const buttonsOf = async (group: Promise<HTMLElement>) =>
  within(await group)
    .getAllByRole('button')
    .map((button) => button.textContent);
const clickIn = async (group: Promise<HTMLElement>, name: string) => {
  const button = within(await group).getByRole('button', { name });
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
};
const headingsIn = (list: HTMLElement) =>
  within(list)
    .getAllByRole('heading', { level: 4 })
    .map((heading) => heading.textContent);
const sectionNamed = (name: string) =>
  screen.getByRole('heading', { level: 3, name }).closest('section')!;
const saveIn = (dialog: HTMLElement) =>
  within(dialog).getByRole('button', { name: t('settings.dialog.save') });

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('[KDS-008] the Stations and printers page', () => {
  it('lists the printers with whether they print, and the stations with how they get their tickets', async () => {
    const { container } = await renderConsole({
      fake: printingServer(),
      path: PATH,
      signedIn: 'MANAGER',
    });
    expect(
      await screen.findByRole('heading', { level: 2, name: t('printing.title') }),
    ).toBeVisible();
    const kitchen = await rowOf(printerActions('Kitchen printer'));
    expect(
      screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent),
    ).toEqual([t('printing.printers.title'), t('printing.stations.title')]);
    // Active printers only, by name.
    expect(headingsIn(sectionNamed(t('printing.printers.title')))).toEqual([
      'Bar printer',
      'Kitchen printer',
    ]);

    expect(
      within(kitchen).getByText(
        t('printing.printers.network', { host: '192.168.1.50', port: '9100' }),
      ),
    ).toBeVisible();
    expect(within(kitchen).getByText(t('printing.printers.paper', { width: 80 }))).toBeVisible();
    expect(within(kitchen).getByText(t('printing.printers.status.READY'))).toBeVisible();
    // 05:00 UTC is 10:30 in the restaurant, today.
    expect(
      within(kitchen).getByText(t('printing.printers.lastPrintedToday', { time: '10:30' })),
    ).toBeVisible();
    expect(
      within(kitchen).getByText(t('printing.printers.usedBy', { names: 'Tandoor' })),
    ).toBeVisible();
    expect(await buttonsOf(printerActions('Kitchen printer'))).toEqual([
      t('printing.printers.test'),
      t('printing.printers.edit'),
      t('printing.printers.redirect'),
      t('printing.printers.archive'),
    ]);

    // Not printing, in words and not by colour alone, since when and why.
    const bar = await rowOf(printerActions('Bar printer'));
    expect(within(bar).getByText(t('printing.printers.usb', { host: 'BarPrinter' }))).toBeVisible();
    expect(within(bar).getByText(t('printing.printers.paper', { width: 58 }))).toBeVisible();
    expect(within(bar).getByText(t('printing.printers.status.OFFLINE'))).toBeVisible();
    expect(
      within(bar).getByText(
        `${t('printing.printers.offlineToday', { time: '10:00' })} ${BAR_ERROR}`,
      ),
    ).toBeVisible();
    expect(within(bar).getByText(t('printing.printers.usedBy', { names: 'Bar' }))).toBeVisible();

    expect(headingsIn(sectionNamed(t('printing.stations.title')))).toEqual([
      'Bar',
      'Curry',
      'Tandoor',
    ]);
    const barStation = await rowOf(stationActions('Bar'));
    expect(within(barStation).getByText(t('printing.stations.mode.PRINT'))).toBeVisible();
    expect(
      within(barStation).getByText(t('printing.stations.printsOn', { name: 'Bar printer' })),
    ).toBeVisible();
    expect(
      within(barStation).getByText(t('printing.stations.printerDown', { name: 'Bar printer' })),
    ).toBeVisible();
    const curry = await rowOf(stationActions('Curry'));
    expect(within(curry).getByText(t('printing.stations.mode.SCREEN'))).toBeVisible();
    expect(within(curry).queryByText(/Prints on/)).toBeNull();
    const tandoor = await rowOf(stationActions('Tandoor'));
    expect(within(tandoor).getByText(t('printing.stations.mode.BOTH'))).toBeVisible();
    expect(
      within(tandoor).getByText(t('printing.stations.printsOn', { name: 'Kitchen printer' })),
    ).toBeVisible();
    expect(
      within(tandoor).queryByText(t('printing.stations.printerDown', { name: 'Kitchen printer' })),
    ).toBeNull();
    expect(await buttonsOf(stationActions('Tandoor'))).toEqual([
      t('printing.stations.edit'),
      t('printing.stations.archive'),
    ]);
    await expectNoAxeViolations(container);
  });

  it('says where a redirected printer’s tickets go, when it last printed before today, and when it was never tried', async () => {
    // The next day: the kitchen printer last printed yesterday.
    vi.setSystemTime(new Date('2026-09-28T06:00:00.000Z'));
    const list = [
      ...printers().map((entry) =>
        entry.id === BAR_PRINTER ? { ...entry, redirectToId: KITCHEN_PRINTER } : entry,
      ),
      printer({ id: NEW_PRINTER, name: 'Pass printer', host: '192.168.1.70' }),
    ];
    await renderConsole({
      fake: printingServer({ printers: [list] }),
      path: PATH,
      signedIn: 'MANAGER',
    });
    const bar = await rowOf(printerActions('Bar printer'));
    expect(within(bar).getByText(t('printing.printers.sentElsewhere'))).toBeVisible();
    expect(
      within(bar).getByText(t('printing.printers.redirected', { name: 'Kitchen printer' })),
    ).toBeVisible();
    expect(await buttonsOf(printerActions('Bar printer'))).toEqual([
      t('printing.printers.test'),
      t('printing.printers.edit'),
      t('printing.printers.unredirect'),
      t('printing.printers.archive'),
    ]);
    const kitchen = await rowOf(printerActions('Kitchen printer'));
    expect(
      within(kitchen).getByText(
        new RegExp(
          `^${t('printing.printers.lastPrintedEarlier', { date: '27 Sep.*', time: '10:30' })}`,
        ),
      ),
    ).toBeVisible();
    const pass = await rowOf(printerActions('Pass printer'));
    expect(within(pass).getByText(t('printing.printers.status.UNTRIED'))).toBeVisible();
    expect(within(pass).getByText(t('printing.printers.unused'))).toBeVisible();
    expect(within(pass).queryByText(/Last printed|Not printing since/)).toBeNull();
  });

  it('[ONB-004] adds a network printer, then prints a test page and says whether it printed', async () => {
    const pass = printer({
      id: NEW_PRINTER,
      name: 'Pass printer',
      host: '192.168.1.70',
      paperWidthMm: 58,
    });
    const fake = printingServer({ printers: [printers(), [...printers(), pass]] })
      .on('POST', PRINTERS, () => ({ status: 201, body: pass }))
      .on(
        'POST',
        `${PRINTERS}/${NEW_PRINTER}/test`,
        () => ({ status: 200, body: { printed: true, error: null } }),
        () => ({ status: 200, body: { printed: false, error: PASS_ERROR } }),
        () => refusal(404, 'PRINTER_NOT_FOUND', 'There is no such active printer.'),
      );
    const { container, user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await printerActions('Kitchen printer');
    await user.click(screen.getByRole('button', { name: t('printing.printers.add') }));
    const dialog = await screen.findByRole('dialog', {
      name: t('printing.printerDialog.addTitle'),
    });
    expect(
      within(dialog).getByRole('radio', {
        name: t('printing.printerDialog.connectionChoice.NETWORK'),
      }),
    ).toBeChecked();
    expect(
      within(dialog).getByRole('radio', { name: t('printing.printerDialog.paperChoice.80') }),
    ).toBeChecked();
    const port = within(dialog).getByRole('textbox', { name: t('printing.printerDialog.port') });
    expect(port).toHaveValue('9100');
    await expectNoAxeViolations(container);

    await user.click(saveIn(dialog));
    expect(
      within(dialog).getByText(t('printing.printerDialog.problems.nameRequired')),
    ).toBeVisible();
    expect(within(dialog).getByText(t('printing.printerDialog.problems.host'))).toBeVisible();
    await user.type(
      within(dialog).getByRole('textbox', { name: t('printing.printerDialog.name') }),
      'kitchen printer',
    );
    expect(within(dialog).getByText(t('printing.printerDialog.problems.nameTaken'))).toBeVisible();
    const name = within(dialog).getByRole('textbox', { name: t('printing.printerDialog.name') });
    await user.clear(name);
    await user.type(name, 'Pass printer');
    const host = within(dialog).getByRole('textbox', { name: t('printing.printerDialog.host') });
    await user.type(host, 'http://192.168.1.70');
    expect(within(dialog).getByText(t('printing.printerDialog.problems.host'))).toBeVisible();
    await user.clear(host);
    await user.type(host, '192.168.1.70');
    await user.clear(port);
    await user.type(port, '99999');
    expect(within(dialog).getByText(t('printing.printerDialog.problems.port'))).toBeVisible();
    await user.clear(port);
    await user.type(port, '9100');
    await user.click(
      within(dialog).getByRole('radio', { name: t('printing.printerDialog.paperChoice.58') }),
    );
    await user.click(saveIn(dialog));

    expect(
      await screen.findByText(t('printing.printerDialog.saved', { name: 'Pass printer' })),
    ).toBeVisible();
    expect(fake.callsTo('POST', PRINTERS).map((call) => call.body)).toEqual([
      {
        name: 'Pass printer',
        connection: 'NETWORK',
        host: '192.168.1.70',
        port: 9100,
        paperWidthMm: 58,
      },
    ]);
    const row = await rowOf(printerActions('Pass printer'));
    expect(within(row).getByText(t('printing.printers.status.UNTRIED'))).toBeVisible();

    // The test page: printed, then not (the printer's own answer), then the printer is gone.
    await clickIn(printerActions('Pass printer'), t('printing.printers.test'));
    expect(
      await screen.findByText(t('printing.printers.testPrinted', { name: 'Pass printer' })),
    ).toBeVisible();
    await clickIn(printerActions('Pass printer'), t('printing.printers.test'));
    expect(
      await screen.findByText(
        t('printing.printers.testFailed', { name: 'Pass printer', error: PASS_ERROR }),
      ),
    ).toBeVisible();
    await clickIn(printerActions('Pass printer'), t('printing.printers.test'));
    expect(await screen.findByText('There is no such active printer.')).toBeVisible();
    expect(fake.callsTo('POST', `${PRINTERS}/${NEW_PRINTER}/test`)).toHaveLength(3);
  });

  it('changes a USB printer, asking for its share name and no port', async () => {
    const fake = printingServer().on('PUT', `${PRINTERS}/${BAR_PRINTER}`, () => ({
      status: 200,
      body: printers()[0],
    }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await clickIn(printerActions('Bar printer'), t('printing.printers.edit'));
    const dialog = await screen.findByRole('dialog', {
      name: t('printing.printerDialog.editTitle', { name: 'Bar printer' }),
    });
    expect(
      within(dialog).getByRole('radio', { name: t('printing.printerDialog.connectionChoice.USB') }),
    ).toBeChecked();
    const share = within(dialog).getByRole('textbox', { name: t('printing.printerDialog.share') });
    expect(share).toHaveValue('BarPrinter');
    expect(
      within(dialog).queryByRole('textbox', { name: t('printing.printerDialog.port') }),
    ).toBeNull();
    await user.clear(share);
    await user.type(share, '\\\\PC\\BarPrinter');
    await user.click(saveIn(dialog));
    expect(within(dialog).getByText(t('printing.printerDialog.problems.share'))).toBeVisible();
    await user.clear(share);
    await user.type(share, 'Bar Printer 2');
    await user.click(saveIn(dialog));
    expect(
      await screen.findByText(t('printing.printerDialog.saved', { name: 'Bar printer' })),
    ).toBeVisible();
    expect(fake.callsTo('PUT', `${PRINTERS}/${BAR_PRINTER}`).map((call) => call.body)).toEqual([
      {
        name: 'Bar printer',
        connection: 'USB',
        host: 'Bar Printer 2',
        port: null,
        paperWidthMm: 58,
      },
    ]);
  });

  it('[AUD-001] sends a broken printer’s tickets to another printer with a reason, and back', async () => {
    const redirected = printers().map((entry) =>
      entry.id === BAR_PRINTER ? { ...entry, redirectToId: KITCHEN_PRINTER } : entry,
    );
    const fake = printingServer({ printers: [printers(), redirected, printers()] }).on(
      'POST',
      `${PRINTERS}/${BAR_PRINTER}/redirect`,
      () =>
        refusal(
          422,
          'REDIRECT_TARGET_INVALID',
          'Kitchen printer sends its own tickets elsewhere. Choose a printer that prints.',
        ),
      () => ({ status: 200, body: redirected[0] }),
      () => ({ status: 200, body: printers()[0] }),
    );
    const { container, user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await clickIn(printerActions('Bar printer'), t('printing.printers.redirect'));
    const dialog = await screen.findByRole('dialog', {
      name: t('printing.redirectDialog.title', { name: 'Bar printer' }),
    });
    // The only printer that prints its own tickets is chosen already.
    const to = within(dialog).getByRole('combobox', { name: t('printing.redirectDialog.to') });
    expect(to).toHaveValue(KITCHEN_PRINTER);
    expect(
      within(to)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Kitchen printer']);
    const confirm = within(dialog).getByRole('button', {
      name: t('printing.redirectDialog.confirm'),
    });
    await user.click(confirm);
    expect(within(dialog).getByText(t('printing.redirectDialog.reasonMissing'))).toBeVisible();
    await user.type(
      within(dialog).getByRole('textbox', { name: t('printing.redirectDialog.reason') }),
      'Paper jam',
    );
    await expectNoAxeViolations(container);
    await user.click(confirm);
    expect(
      await within(dialog).findByText(
        'Kitchen printer sends its own tickets elsewhere. Choose a printer that prints.',
      ),
    ).toBeVisible();
    await user.click(confirm);
    expect(
      await screen.findByText(
        t('printing.printers.redirectedToast', { name: 'Bar printer', to: 'Kitchen printer' }),
      ),
    ).toBeVisible();

    // Read again: sent elsewhere, until it prints here again.
    const bar = await rowOf(printerActions('Bar printer'));
    expect(await within(bar).findByText(t('printing.printers.sentElsewhere'))).toBeVisible();
    await clickIn(printerActions('Bar printer'), t('printing.printers.unredirect'));
    const back = await screen.findByRole('dialog', {
      name: t('printing.unredirectDialog.title', { name: 'Bar printer' }),
    });
    expect(
      within(back).getByText(
        t('printing.unredirectDialog.description', {
          name: 'Bar printer',
          to: 'Kitchen printer',
        }),
      ),
    ).toBeVisible();
    await user.type(
      within(back).getByRole('textbox', { name: t('printing.unredirectDialog.reason') }),
      'Paper changed',
    );
    await user.click(
      within(back).getByRole('button', { name: t('printing.unredirectDialog.confirm') }),
    );
    expect(
      await screen.findByText(t('printing.printers.unredirectedToast', { name: 'Bar printer' })),
    ).toBeVisible();
    expect(
      fake.callsTo('POST', `${PRINTERS}/${BAR_PRINTER}/redirect`).map((call) => call.body),
    ).toEqual([
      { toPrinterId: KITCHEN_PRINTER, reason: 'Paper jam' },
      { toPrinterId: KITCHEN_PRINTER, reason: 'Paper jam' },
      { toPrinterId: null, reason: 'Paper changed' },
    ]);
  });

  it('adds a station that prints, and turns another into a screen-only one', async () => {
    const grill = station({
      id: NEW_STATION,
      name: 'Grill',
      mode: 'BOTH',
      printerId: KITCHEN_PRINTER,
    });
    const fake = printingServer({ stations: [stations(), [...stations(), grill]] })
      .on('POST', STATIONS, () => ({ status: 201, body: grill }))
      .on('PUT', `${STATIONS}/${TANDOOR}`, () => ({
        status: 200,
        body: station({ id: TANDOOR, name: 'Tandoor' }),
      }));
    const { container, user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    await stationActions('Tandoor');
    await user.click(screen.getByRole('button', { name: t('printing.stations.add') }));
    const dialog = await screen.findByRole('dialog', {
      name: t('printing.stationDialog.addTitle'),
    });
    // Two printers: shown and printed, on the printer the manager chooses.
    expect(
      within(dialog).getByRole('radio', { name: t('printing.stationDialog.modeChoice.BOTH') }),
    ).toBeChecked();
    const printerChoice = within(dialog).getByRole('combobox', {
      name: t('printing.stationDialog.printer'),
    });
    expect(printerChoice).toHaveValue('');
    expect(
      within(printerChoice)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([t('printing.stationDialog.choosePrinter'), 'Bar printer', 'Kitchen printer']);
    await expectNoAxeViolations(container);

    const name = within(dialog).getByRole('textbox', { name: t('printing.stationDialog.name') });
    await user.type(name, 'tandoor');
    await user.click(saveIn(dialog));
    expect(within(dialog).getByText(t('printing.stationDialog.problems.nameTaken'))).toBeVisible();
    expect(
      within(dialog).getByText(t('printing.stationDialog.problems.printerMissing')),
    ).toBeVisible();
    await user.clear(name);
    // The archived grill's name is free again.
    await user.type(name, 'Grill');
    await user.selectOptions(printerChoice, KITCHEN_PRINTER);
    await user.click(saveIn(dialog));
    expect(
      await screen.findByText(t('printing.stationDialog.saved', { name: 'Grill' })),
    ).toBeVisible();
    expect(fake.callsTo('POST', STATIONS).map((call) => call.body)).toEqual([
      { name: 'Grill', mode: 'BOTH', printerId: KITCHEN_PRINTER },
    ]);
    expect(
      within(await rowOf(stationActions('Grill'))).getByText(
        t('printing.stations.printsOn', { name: 'Kitchen printer' }),
      ),
    ).toBeVisible();

    await clickIn(stationActions('Tandoor'), t('printing.stations.edit'));
    const edit = await screen.findByRole('dialog', {
      name: t('printing.stationDialog.editTitle', { name: 'Tandoor' }),
    });
    expect(
      within(edit).getByRole('combobox', { name: t('printing.stationDialog.printer') }),
    ).toHaveValue(KITCHEN_PRINTER);
    await user.click(
      within(edit).getByRole('radio', { name: t('printing.stationDialog.modeChoice.SCREEN') }),
    );
    expect(
      within(edit).queryByRole('combobox', { name: t('printing.stationDialog.printer') }),
    ).toBeNull();
    await user.click(saveIn(edit));
    expect(
      await screen.findByText(t('printing.stationDialog.saved', { name: 'Tandoor' })),
    ).toBeVisible();
    expect(fake.callsTo('PUT', `${STATIONS}/${TANDOOR}`).map((call) => call.body)).toEqual([
      { name: 'Tandoor', mode: 'SCREEN', printerId: null },
    ]);
  });

  it('[AUD-001] archives a station or a printer with a reason, and says why the server refuses', async () => {
    const fake = printingServer({
      stations: [stations(), stations().filter((entry) => entry.id !== CURRY)],
    })
      .on('POST', `${PRINTERS}/${KITCHEN_PRINTER}/archive`, () =>
        refusal(
          409,
          'PRINTER_IN_USE',
          'These still print on this printer: Tandoor. Give them another printer first.',
        ),
      )
      .on('POST', `${STATIONS}/${CURRY}/archive`, () => ({
        status: 200,
        body: station({ id: CURRY, name: 'Curry', archivedAt: NOW }),
      }));
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });

    await clickIn(printerActions('Kitchen printer'), t('printing.printers.archive'));
    const dialog = await screen.findByRole('dialog', {
      name: t('printing.archivePrinter.title', { name: 'Kitchen printer' }),
    });
    await user.type(
      within(dialog).getByRole('textbox', { name: t('printing.archivePrinter.reason') }),
      'Replaced',
    );
    await user.click(
      within(dialog).getByRole('button', { name: t('printing.archivePrinter.confirm') }),
    );
    expect(
      await within(dialog).findByText(
        'These still print on this printer: Tandoor. Give them another printer first.',
      ),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: t('ui.dialog.close') }));

    await clickIn(stationActions('Curry'), t('printing.stations.archive'));
    const archive = await screen.findByRole('dialog', {
      name: t('printing.archiveStation.title', { name: 'Curry' }),
    });
    await user.type(
      within(archive).getByRole('textbox', { name: t('printing.archiveStation.reason') }),
      'Menu changed',
    );
    await user.click(
      within(archive).getByRole('button', { name: t('printing.archiveStation.confirm') }),
    );
    expect(
      await screen.findByText(t('printing.stations.archived', { name: 'Curry' })),
    ).toBeVisible();
    expect(fake.callsTo('POST', `${STATIONS}/${CURRY}/archive`)[0]?.body).toEqual({
      reason: 'Menu changed',
    });
    // Read again: the curry station is gone.
    expect(headingsIn(sectionNamed(t('printing.stations.title')))).toEqual(['Bar', 'Tandoor']);
  });

  it('follows a printer stopping, and setup changes made on other screens', async () => {
    const stopped = printers().map((entry) =>
      entry.id === KITCHEN_PRINTER ? { ...entry, offlineSince: NOW, lastError: PASS_ERROR } : entry,
    );
    const renamed = stations().map((entry) =>
      entry.id === BAR ? { ...entry, name: 'Bar counter' } : entry,
    );
    const { sockets } = await renderConsole({
      fake: printingServer({ printers: [printers(), stopped], stations: [stations(), renamed] }),
      path: PATH,
      signedIn: 'MANAGER',
    });
    await stationActions('Tandoor');
    act(() => {
      sockets.sync(0);
      sockets.last.fire(
        'event',
        printerStatusChanged(1, { id: KITCHEN_PRINTER, name: 'Kitchen printer' }, PASS_ERROR),
      );
    });
    const tandoor = await rowOf(stationActions('Tandoor'));
    expect(
      await within(tandoor).findByText(
        t('printing.stations.printerDown', { name: 'Kitchen printer' }),
      ),
    ).toBeVisible();
    act(() => {
      sockets.last.fire('event', changed(2, 'STATIONS'));
    });
    expect(await stationActions('Bar counter')).toBeVisible();
  });

  it('without printers, lets a station show its tickets on a kitchen screen only', async () => {
    const { user } = await renderConsole({
      fake: printingServer({ printers: [[]] }),
      path: PATH,
      signedIn: 'MANAGER',
    });
    expect(await screen.findByText(t('printing.printers.none'))).toBeVisible();
    await user.click(screen.getByRole('button', { name: t('printing.stations.add') }));
    const dialog = await screen.findByRole('dialog', {
      name: t('printing.stationDialog.addTitle'),
    });
    expect(
      within(dialog).getByRole('radio', { name: t('printing.stationDialog.modeChoice.SCREEN') }),
    ).toBeChecked();
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    await user.click(
      within(dialog).getByRole('radio', { name: t('printing.stationDialog.modeChoice.PRINT') }),
    );
    expect(within(dialog).getByText(t('printing.stationDialog.noPrinters'))).toBeVisible();
  });

  it('says when the stations and printers cannot be read, and tries again', async () => {
    const fake = printingServer().on(
      'GET',
      PRINTERS,
      () => refusal(503, 'UNAVAILABLE', 'The server is busy.'),
      () => ({ status: 200, body: { printers: printers() } }),
    );
    const { user } = await renderConsole({ fake, path: PATH, signedIn: 'MANAGER' });
    expect(await screen.findByText(t('printing.loadFailed'))).toBeVisible();
    await user.click(screen.getByRole('button', { name: t('states.retry') }));
    expect(await printerActions('Kitchen printer')).toBeVisible();
  });
});
