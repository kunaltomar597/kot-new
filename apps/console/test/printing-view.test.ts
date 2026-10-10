import { describe, expect, it } from 'vitest';
import {
  activePrinters,
  activeStations,
  checkPrinter,
  checkStation,
  emptyPrinterForm,
  emptyStationForm,
  isOffline,
  type PrinterForm,
  printerFormOf,
  printerHealthOf,
  printerNameOf,
  printerOfStation,
  printerRequestOf,
  redirectTargets,
  type StationForm,
  stationFormOf,
  stationRequestOf,
  stationsPrintingOn,
} from '../src/manage/settings/printing-view.js';
import {
  BAR,
  BAR_ERROR,
  BAR_OFFLINE_SINCE,
  BAR_PRINTER,
  CURRY,
  KITCHEN_LAST_SEEN,
  KITCHEN_PRINTER,
  NEW_PRINTER,
  OLD_PRINTER,
  printer,
  printers,
  station,
  stations,
  TANDOOR,
} from './floor-fixture.js';

const byId = <T extends { readonly id: string }>(list: readonly T[], id: string): T =>
  list.find((entry) => entry.id === id)!;
const names = (list: readonly { readonly name: string }[]) => list.map((entry) => entry.name);

describe('[KDS-008] printers and stations as the page lists them', () => {
  it('lists the active printers and stations, by name', () => {
    expect(names(activePrinters(printers()))).toEqual(['Bar printer', 'Kitchen printer']);
    expect(names(activeStations(stations()))).toEqual(['Bar', 'Curry', 'Tandoor']);
  });

  it('says whether a printer prints, since when it does not and why, or that it was never tried', () => {
    expect(printerHealthOf(byId(printers(), KITCHEN_PRINTER))).toEqual({
      kind: 'READY',
      lastSeenAt: KITCHEN_LAST_SEEN,
    });
    expect(printerHealthOf(byId(printers(), BAR_PRINTER))).toEqual({
      kind: 'OFFLINE',
      since: BAR_OFFLINE_SINCE,
      error: BAR_ERROR,
    });
    expect(printerHealthOf(printer({ id: NEW_PRINTER, name: 'New printer' }))).toEqual({
      kind: 'UNTRIED',
    });
    expect(isOffline(byId(printers(), BAR_PRINTER))).toBe(true);
    expect(isOffline(byId(printers(), KITCHEN_PRINTER))).toBe(false);
    expect(isOffline(undefined)).toBe(false);
  });

  it('names the stations that print on a printer, leaving out screen-only and archived ones', () => {
    const list = [
      ...stations(),
      // Shows its tickets only; a printer it kept from before does not count.
      station({ id: NEW_PRINTER, name: 'Pass', mode: 'SCREEN', printerId: KITCHEN_PRINTER }),
      station({
        id: OLD_PRINTER,
        name: 'Grill',
        mode: 'PRINT',
        printerId: KITCHEN_PRINTER,
        archivedAt: '2026-09-25T04:00:00.000Z',
      }),
    ];
    expect(names(stationsPrintingOn(KITCHEN_PRINTER, list))).toEqual(['Tandoor']);
    expect(names(stationsPrintingOn(BAR_PRINTER, list))).toEqual(['Bar']);
    expect(stationsPrintingOn(OLD_PRINTER, list)).toEqual([]);
  });

  it('finds the printer a station prints on, and none for a screen-only station', () => {
    expect(printerOfStation(byId(stations(), TANDOOR), printers())?.name).toBe('Kitchen printer');
    expect(printerOfStation(byId(stations(), BAR), printers())?.name).toBe('Bar printer');
    expect(printerOfStation(byId(stations(), CURRY), printers())).toBeUndefined();
    expect(printerNameOf(printers(), KITCHEN_PRINTER)).toBe('Kitchen printer');
    expect(printerNameOf(printers(), null)).toBeUndefined();
  });

  it('sends a printer’s tickets only to another active printer that prints its own', () => {
    const list = [
      ...printers(),
      printer({ id: NEW_PRINTER, name: 'Pass printer', redirectToId: KITCHEN_PRINTER }),
    ];
    expect(names(redirectTargets(byId(list, BAR_PRINTER), list))).toEqual(['Kitchen printer']);
    expect(names(redirectTargets(byId(list, KITCHEN_PRINTER), list))).toEqual(['Bar printer']);
  });
});

describe('[KDS-008] [ONB-004] the printer form', () => {
  const form = (overrides: Partial<PrinterForm> = {}): PrinterForm => ({
    ...emptyPrinterForm(),
    name: 'Pass printer',
    host: '192.168.1.70',
    ...overrides,
  });

  it('starts as a network printer on port 9100 with 80 mm paper', () => {
    expect(emptyPrinterForm()).toEqual({
      name: '',
      connection: 'NETWORK',
      host: '',
      port: '9100',
      paperWidthMm: 80,
    });
  });

  it('fills the form from a printer; a USB printer keeps the usual port for a switch to network', () => {
    expect(printerFormOf(byId(printers(), KITCHEN_PRINTER))).toEqual({
      name: 'Kitchen printer',
      connection: 'NETWORK',
      host: '192.168.1.50',
      port: '9100',
      paperWidthMm: 80,
    });
    expect(printerFormOf(byId(printers(), BAR_PRINTER))).toEqual({
      name: 'Bar printer',
      connection: 'USB',
      host: 'BarPrinter',
      port: '9100',
      paperWidthMm: 58,
    });
  });

  it('asks for a name no other active printer has', () => {
    const name = (text: string, selfId?: string) =>
      checkPrinter(form({ name: text }), printers(), selfId).name;
    expect(name('Pass printer')).toBeUndefined();
    expect(name('  ')).toBe('nameRequired');
    expect(name('x'.repeat(41))).toBe('nameRequired');
    expect(name(' KITCHEN PRINTER ')).toBe('nameTaken');
    expect(name('Kitchen printer', KITCHEN_PRINTER)).toBeUndefined();
    // An archived printer's name is free.
    expect(name('Old printer')).toBeUndefined();
  });

  it('asks a network printer for an address and a port from 1 to 65,535', () => {
    const check = (overrides: Partial<PrinterForm>) => checkPrinter(form(overrides), [], undefined);
    expect(check({ host: 'kitchen-printer.local' })).toEqual({});
    expect(check({ host: '' })).toEqual({ host: 'host' });
    expect(check({ host: 'http://192.168.1.70' })).toEqual({ host: 'host' });
    expect(check({ host: 'kitchen printer' })).toEqual({ host: 'host' });
    expect(check({ port: '0' })).toEqual({ port: 'port' });
    expect(check({ port: '65536' })).toEqual({ port: 'port' });
    expect(check({ port: 'raw' })).toEqual({ port: 'port' });
    expect(check({ port: ' 9101 ' })).toEqual({});
  });

  it('asks a USB printer for its share name, and no port', () => {
    const check = (overrides: Partial<PrinterForm>) =>
      checkPrinter(form({ connection: 'USB', port: '', ...overrides }), [], undefined);
    expect(check({ host: 'Bar Printer_2' })).toEqual({});
    expect(check({ host: '/dev/usb/lp0' })).toEqual({});
    expect(check({ host: '' })).toEqual({ host: 'share' });
    expect(check({ host: '\\\\PC\\BarPrinter' })).toEqual({ host: 'share' });
  });

  it('sends the form trimmed, with the port only for a network printer', () => {
    expect(
      printerRequestOf(form({ name: ' Pass printer ', host: ' 10.0.0.9 ', port: '9101' })),
    ).toEqual({
      name: 'Pass printer',
      connection: 'NETWORK',
      host: '10.0.0.9',
      port: 9101,
      paperWidthMm: 80,
    });
    expect(
      printerRequestOf(form({ connection: 'USB', host: 'BarPrinter', paperWidthMm: 58 })),
    ).toEqual({
      name: 'Pass printer',
      connection: 'USB',
      host: 'BarPrinter',
      port: null,
      paperWidthMm: 58,
    });
  });
});

describe('[KDS-008] the station form', () => {
  const form = (overrides: Partial<StationForm> = {}): StationForm => ({
    name: 'Grill',
    mode: 'BOTH',
    printerId: KITCHEN_PRINTER,
    ...overrides,
  });

  it('shows and prints a new station’s tickets on the only printer, and asks when there are several', () => {
    expect(emptyStationForm([])).toEqual({ name: '', mode: 'SCREEN', printerId: '' });
    const one = printers().filter((entry) => entry.id !== BAR_PRINTER);
    expect(emptyStationForm(one)).toEqual({ name: '', mode: 'BOTH', printerId: KITCHEN_PRINTER });
    expect(emptyStationForm(printers())).toEqual({ name: '', mode: 'BOTH', printerId: '' });
    // Archived printers do not count.
    expect(emptyStationForm([byId(printers(), OLD_PRINTER)])).toMatchObject({ mode: 'SCREEN' });
  });

  it('asks for a name no other active station has, and a printer when it prints', () => {
    const check = (overrides: Partial<StationForm>, selfId?: string) =>
      checkStation(form(overrides), stations(), printers(), selfId);
    expect(check({})).toEqual({});
    expect(check({ name: ' ' })).toEqual({ name: 'nameRequired' });
    expect(check({ name: 'tandoor' })).toEqual({ name: 'nameTaken' });
    expect(check({ name: 'Tandoor' }, TANDOOR)).toEqual({});
    // An archived station's name is free.
    expect(check({ name: 'Grill' })).toEqual({});
    expect(check({ printerId: '' })).toEqual({ printerId: 'printerMissing' });
    expect(check({ mode: 'PRINT', printerId: OLD_PRINTER })).toEqual({
      printerId: 'printerMissing',
    });
    expect(check({ mode: 'SCREEN', printerId: '' })).toEqual({});
  });

  it('fills the form from a station and drops the printer of a screen-only one', () => {
    expect(stationFormOf(byId(stations(), CURRY))).toEqual({
      name: 'Curry',
      mode: 'SCREEN',
      printerId: '',
    });
    expect(stationFormOf(byId(stations(), BAR))).toEqual({
      name: 'Bar',
      mode: 'PRINT',
      printerId: BAR_PRINTER,
    });
    expect(stationRequestOf(form({ name: ' Grill ' }))).toEqual({
      name: 'Grill',
      mode: 'BOTH',
      printerId: KITCHEN_PRINTER,
    });
    expect(stationRequestOf(form({ mode: 'SCREEN' }))).toEqual({
      name: 'Grill',
      mode: 'SCREEN',
      printerId: null,
    });
  });
});
