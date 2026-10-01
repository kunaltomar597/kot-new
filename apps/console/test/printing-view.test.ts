import { describe, expect, it } from 'vitest';
import {
  activePrinters,
  checkPrinterDraft,
  checkStationDraft,
  printerAddress,
  printerDraftOf,
  printerRequestOf,
  printerState,
  redirectTargets,
  stationDraftOf,
  stationRequestOf,
  stationsOn,
} from '../src/manage/printing/printing-view.js';
import {
  BAR_PRINTER,
  KITCHEN_PRINTER,
  printers,
  printerView,
  stations,
} from './printing-fixture.js';

describe('[KDS-008] [ONB-004] a printer as the form holds it', () => {
  it('starts as an 80 mm network printer on port 9100', () => {
    const draft = printerDraftOf();
    expect(draft).toMatchObject({ connection: 'NETWORK', port: '9100', paperWidthMm: '80' });
    expect(checkPrinterDraft(draft)).toEqual(['NAME_REQUIRED', 'HOST_INVALID']);
  });

  it('turns a printer into a draft and back into the same request', () => {
    expect(printerRequestOf(printerDraftOf(printerView()))).toEqual({
      name: 'Kitchen printer',
      connection: 'NETWORK',
      host: '192.168.1.50',
      port: 9100,
      paperWidthMm: 80,
    });
    const usb = printers()[1]!;
    expect(printerRequestOf(printerDraftOf(usb))).toEqual({
      name: 'Bar printer',
      connection: 'USB',
      host: 'BarPrinter',
      port: null,
      paperWidthMm: 58,
    });
  });

  it('checks the address and port like the server', () => {
    const base = printerDraftOf(printerView());
    expect(checkPrinterDraft({ ...base, host: 'http://printer' })).toEqual(['HOST_INVALID']);
    expect(checkPrinterDraft({ ...base, port: '70000' })).toEqual(['PORT_INVALID']);
    expect(checkPrinterDraft({ ...base, port: '0' })).toEqual(['PORT_INVALID']);
    // A USB printer has no port, and is named by its share.
    expect(checkPrinterDraft({ ...base, connection: 'USB', host: 'Kitchen 80', port: '' })).toEqual(
      [],
    );
    expect(checkPrinterDraft({ ...base, connection: 'USB', host: '\\\\pc\\share' })).toEqual([
      'HOST_INVALID',
    ]);
  });
});

describe('[KDS-002] [KDS-008] a station as the form holds it', () => {
  it('needs a printer to print, and keeps one on screen only for reprints', () => {
    expect(checkStationDraft({ name: 'Tandoor', mode: 'PRINT', printerId: '' })).toEqual([
      'PRINTER_REQUIRED',
    ]);
    expect(checkStationDraft({ name: ' ', mode: 'SCREEN', printerId: '' })).toEqual([
      'NAME_REQUIRED',
    ]);
    expect(stationRequestOf({ name: ' Tandoor ', mode: 'SCREEN', printerId: '' })).toEqual({
      name: 'Tandoor',
      mode: 'SCREEN',
      printerId: null,
    });
    expect(stationRequestOf(stationDraftOf(stations()[0]))).toEqual({
      name: 'Kitchen',
      mode: 'BOTH',
      printerId: KITCHEN_PRINTER,
    });
  });
});

describe('[KDS-008] how a printer is doing', () => {
  it('tells printing, offline and not tested apart, with its address', () => {
    const [kitchen, bar] = printers();
    expect(printerState(kitchen!)).toBe('ONLINE');
    expect(printerState(bar!)).toBe('UNTESTED');
    expect(printerState(printerView({ offlineSince: '2026-10-01T05:00:00.000Z' }))).toBe('OFFLINE');
    expect(printerAddress(kitchen!)).toBe('192.168.1.50:9100');
    expect(printerAddress(bar!)).toBe('BarPrinter');
  });

  it('lists active printers by name, the stations on each, and where tickets may go', () => {
    const all = printers();
    expect(activePrinters(all).map((printer) => printer.name)).toEqual([
      'Bar printer',
      'Kitchen printer',
    ]);
    expect(stationsOn(KITCHEN_PRINTER, stations())).toEqual(['Kitchen']);
    expect(stationsOn(BAR_PRINTER, stations())).toEqual([]);
    expect(redirectTargets(all[0]!, all).map((printer) => printer.id)).toEqual([BAR_PRINTER]);
    // A printer that is itself redirected cannot take another's tickets.
    const barAway = { ...all[1]!, redirectToId: KITCHEN_PRINTER };
    expect(redirectTargets(all[0]!, [all[0]!, barAway])).toEqual([]);
  });
});
