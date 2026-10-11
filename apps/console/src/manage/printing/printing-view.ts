import {
  NETWORK_HOST,
  PrinterRequest,
  type PrinterView,
  StationRequest,
  type StationMode,
  type StationView,
  USB_DEVICE,
  USB_SHARE,
} from '@rp/contracts';

/**
 * Stations and printers (P4-03d, KDS-008, ONB-004 step 6): what the forms hold while a printer or a
 * station is edited, the requests they become, and how a printer is doing.
 */

export const STATION_MODES = ['SCREEN', 'PRINT', 'BOTH'] as const satisfies readonly StationMode[];
export const PAPER_WIDTHS = ['80', '58'] as const;
export const DEFAULT_PORT = '9100';

export type Connection = PrinterRequest['connection'];

export interface PrinterDraft {
  readonly name: string;
  readonly connection: Connection;
  /** An IP address or host name, or the share name of a USB printer on the server PC. */
  readonly host: string;
  readonly port: string;
  readonly paperWidthMm: (typeof PAPER_WIDTHS)[number];
}

export function printerDraftOf(
  printer?: PrinterView,
  found?: { readonly name: string; readonly host: string; readonly port: number },
): PrinterDraft {
  if (printer === undefined) {
    return {
      name: found?.name ?? '',
      connection: 'NETWORK',
      host: found?.host ?? '',
      port: found === undefined ? DEFAULT_PORT : String(found.port),
      paperWidthMm: '80',
    };
  }
  return {
    name: printer.name,
    connection: printer.connection,
    host: printer.host ?? '',
    port: printer.port === null ? DEFAULT_PORT : String(printer.port),
    paperWidthMm: printer.paperWidthMm === 58 ? '58' : '80',
  };
}

export const PRINTER_PROBLEMS = ['NAME_REQUIRED', 'HOST_INVALID', 'PORT_INVALID'] as const;
export type PrinterProblem = (typeof PRINTER_PROBLEMS)[number];

export function checkPrinterDraft(draft: PrinterDraft): PrinterProblem[] {
  const problems: PrinterProblem[] = [];
  if (draft.name.trim() === '') problems.push('NAME_REQUIRED');
  const host = draft.host.trim();
  const hostOk =
    draft.connection === 'NETWORK'
      ? NETWORK_HOST.test(host)
      : USB_SHARE.test(host) || USB_DEVICE.test(host);
  if (!hostOk) problems.push('HOST_INVALID');
  if (draft.connection === 'NETWORK') {
    const port = draft.port.trim();
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
      problems.push('PORT_INVALID');
    }
  }
  return problems;
}

export function printerRequestOf(draft: PrinterDraft): PrinterRequest | undefined {
  if (checkPrinterDraft(draft).length > 0) return undefined;
  const parsed = PrinterRequest.safeParse({
    name: draft.name.trim(),
    connection: draft.connection,
    host: draft.host.trim(),
    port: draft.connection === 'NETWORK' ? Number(draft.port.trim()) : null,
    paperWidthMm: Number(draft.paperWidthMm),
  });
  return parsed.success ? parsed.data : undefined;
}

export interface StationDraft {
  readonly name: string;
  readonly mode: StationMode;
  /** Empty for none. */
  readonly printerId: string;
}

export function stationDraftOf(station?: StationView): StationDraft {
  return station === undefined
    ? { name: '', mode: 'SCREEN', printerId: '' }
    : { name: station.name, mode: station.mode, printerId: station.printerId ?? '' };
}

export const STATION_PROBLEMS = ['NAME_REQUIRED', 'PRINTER_REQUIRED'] as const;
export type StationProblem = (typeof STATION_PROBLEMS)[number];

export function checkStationDraft(draft: StationDraft): StationProblem[] {
  const problems: StationProblem[] = [];
  if (draft.name.trim() === '') problems.push('NAME_REQUIRED');
  if (draft.mode !== 'SCREEN' && draft.printerId === '') problems.push('PRINTER_REQUIRED');
  return problems;
}

export function stationRequestOf(draft: StationDraft): StationRequest | undefined {
  if (checkStationDraft(draft).length > 0) return undefined;
  const parsed = StationRequest.safeParse({
    name: draft.name.trim(),
    mode: draft.mode,
    // A station on screen only may keep a printer for reprints and later printing.
    printerId: draft.printerId === '' ? null : draft.printerId,
  });
  return parsed.success ? parsed.data : undefined;
}

// ---------------------------------------------------------------- how a printer is doing

/** OFFLINE: jobs fail; ONLINE: it took the last one; UNTESTED: nothing sent to it yet. */
export type PrinterState = 'OFFLINE' | 'ONLINE' | 'UNTESTED';

export function printerState(printer: PrinterView): PrinterState {
  if (printer.offlineSince !== null) return 'OFFLINE';
  return printer.lastSeenAt === null ? 'UNTESTED' : 'ONLINE';
}

/** "192.168.1.50:9100", or the share name of a USB printer. */
export function printerAddress(printer: PrinterView): string {
  const host = printer.host ?? '';
  return printer.connection === 'NETWORK' && printer.port !== null
    ? `${host}:${String(printer.port)}`
    : host;
}

const byName = <T extends { readonly name: string }>(a: T, b: T) =>
  a.name.localeCompare(b.name, 'en-IN');

export function activePrinters(printers: readonly PrinterView[]): PrinterView[] {
  return printers.filter((printer) => printer.archivedAt === null).sort(byName);
}

export function activeStations(stations: readonly StationView[]): StationView[] {
  return stations.filter((station) => station.archivedAt === null).sort(byName);
}

/** The active stations that print on a printer, by name. */
export function stationsOn(printerId: string, stations: readonly StationView[]): string[] {
  return activeStations(stations)
    .filter((station) => station.printerId === printerId)
    .map((station) => station.name);
}

/** Where a printer's tickets may go while it is broken: another active one not itself redirected. */
export function redirectTargets(
  printer: PrinterView,
  printers: readonly PrinterView[],
): PrinterView[] {
  return activePrinters(printers).filter(
    (other) => other.id !== printer.id && other.redirectToId === null,
  );
}
