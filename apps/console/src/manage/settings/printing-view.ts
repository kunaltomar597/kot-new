import {
  NETWORK_HOST,
  PrinterRequest,
  type PrinterView,
  StationRequest,
  type StationView,
  USB_DEVICE,
  USB_SHARE,
} from '@rp/contracts';

/**
 * The Stations and printers page's logic (P4-03d, KDS-008, ONB-004 step 6), without React: how
 * each printer is doing, which stations print where, where a broken printer's tickets can go, and
 * the station and printer forms with the same checks as the server.
 */

export type StationMode = StationView['mode'];
export type PrinterConnection = PrinterView['connection'];
export type PaperWidth = 58 | 80;

export const STATION_MODES: readonly StationMode[] = ['SCREEN', 'PRINT', 'BOTH'];
export const CONNECTIONS: readonly PrinterConnection[] = ['NETWORK', 'USB'];
export const PAPER_WIDTHS: readonly PaperWidth[] = [80, 58];
/** Raw printing on almost every network printer. */
export const DEFAULT_PORT = 9100;
const PORT_MAX = 65_535;

const isActive = (entry: { readonly archivedAt: string | null }) => entry.archivedAt === null;
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The printers stations can use, by name (the server's order). */
export function activePrinters(printers: readonly PrinterView[]): PrinterView[] {
  return printers.filter(isActive);
}

/** The stations in use, by name (the server's order). */
export function activeStations(stations: readonly StationView[]): StationView[] {
  return stations.filter(isActive);
}

/** How a printer is doing (KDS-008): printing, not printing since a failure, or never tried. */
export type PrinterHealth =
  | { readonly kind: 'UNTRIED' }
  | { readonly kind: 'READY'; readonly lastSeenAt: string }
  | { readonly kind: 'OFFLINE'; readonly since: string; readonly error: string | null };

export function printerHealthOf(printer: PrinterView): PrinterHealth {
  if (printer.offlineSince !== null) {
    return { kind: 'OFFLINE', since: printer.offlineSince, error: printer.lastError };
  }
  return printer.lastSeenAt === null
    ? { kind: 'UNTRIED' }
    : { kind: 'READY', lastSeenAt: printer.lastSeenAt };
}

/** The active stations whose tickets print on a printer. */
export function stationsPrintingOn(
  printerId: string,
  stations: readonly StationView[],
): StationView[] {
  return activeStations(stations).filter(
    (station) => station.mode !== 'SCREEN' && station.printerId === printerId,
  );
}

/**
 * Where a printer's tickets can be sent instead (KDS-008): another active printer that prints its
 * own tickets. The server also refuses a printer whose own tickets others are sent to.
 */
export function redirectTargets(
  printer: PrinterView,
  printers: readonly PrinterView[],
): PrinterView[] {
  return activePrinters(printers).filter(
    (target) => target.id !== printer.id && target.redirectToId === null,
  );
}

export function printerNameOf(
  printers: readonly PrinterView[],
  printerId: string | null,
): string | undefined {
  return printerId === null ? undefined : printers.find((entry) => entry.id === printerId)?.name;
}

/** The printer a station prints on, when it prints; screen-only stations have none. */
export function printerOfStation(
  station: StationView,
  printers: readonly PrinterView[],
): PrinterView | undefined {
  if (station.mode === 'SCREEN') return undefined;
  return printers.find((printer) => printer.id === station.printerId);
}

/** Whether a printer has stopped printing (KDS-008). */
export function isOffline(printer: PrinterView | undefined): printer is PrinterView {
  return printer !== undefined && printer.offlineSince !== null;
}

// ---------------------------------------------------------------- printers

export interface PrinterForm {
  readonly name: string;
  readonly connection: PrinterConnection;
  /** NETWORK: an IP address or host name; USB: the printer's share name on the restaurant PC. */
  readonly host: string;
  /** NETWORK only. */
  readonly port: string;
  readonly paperWidthMm: PaperWidth;
}

export type PrinterField = 'name' | 'host' | 'port';
export type PrinterProblem = 'nameRequired' | 'nameTaken' | 'host' | 'share' | 'port';

export function emptyPrinterForm(): PrinterForm {
  return {
    name: '',
    connection: 'NETWORK',
    host: '',
    port: String(DEFAULT_PORT),
    paperWidthMm: 80,
  };
}

export function printerFormOf(printer: PrinterView): PrinterForm {
  return {
    name: printer.name,
    connection: printer.connection,
    host: printer.host ?? '',
    port: String(printer.port ?? DEFAULT_PORT),
    paperWidthMm: printer.paperWidthMm === 58 ? 58 : 80,
  };
}

function portOf(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const port = Number(trimmed);
  return port >= 1 && port <= PORT_MAX ? port : undefined;
}

/**
 * The server's checks: a name no other active printer has, then an IP address or host name and a
 * port for a network printer, or a share name (or a Linux USB device) for a USB one.
 */
export function checkPrinter(
  form: PrinterForm,
  printers: readonly PrinterView[],
  selfId: string | undefined,
): Partial<Record<PrinterField, PrinterProblem>> {
  const problems: Partial<Record<PrinterField, PrinterProblem>> = {};
  if (!PrinterRequest.shape.name.safeParse(form.name).success) {
    problems.name = 'nameRequired';
  } else if (
    activePrinters(printers).some(
      (printer) => printer.id !== selfId && sameName(printer.name, form.name),
    )
  ) {
    problems.name = 'nameTaken';
  }
  const host = form.host.trim();
  if (form.connection === 'NETWORK') {
    if (!NETWORK_HOST.test(host)) problems.host = 'host';
    if (portOf(form.port) === undefined) problems.port = 'port';
  } else if (!USB_SHARE.test(host) && !USB_DEVICE.test(host)) {
    problems.host = 'share';
  }
  return problems;
}

/** The request for a checked form; a USB printer has no port. */
export function printerRequestOf(form: PrinterForm): PrinterRequest {
  return {
    name: form.name.trim(),
    connection: form.connection,
    host: form.host.trim(),
    port: form.connection === 'NETWORK' ? (portOf(form.port) ?? DEFAULT_PORT) : null,
    paperWidthMm: form.paperWidthMm,
  };
}

// ---------------------------------------------------------------- stations

export interface StationForm {
  readonly name: string;
  readonly mode: StationMode;
  /** Empty until chosen; only for a station that prints. */
  readonly printerId: string;
}

export type StationField = 'name' | 'printerId';
export type StationProblem = 'nameRequired' | 'nameTaken' | 'printerMissing';

/**
 * A new station shows and prints its tickets on the only printer there is; with several the
 * manager chooses, and with none it shows them on a kitchen screen only.
 */
export function emptyStationForm(printers: readonly PrinterView[]): StationForm {
  const usable = activePrinters(printers);
  if (usable.length === 0) return { name: '', mode: 'SCREEN', printerId: '' };
  return { name: '', mode: 'BOTH', printerId: usable.length === 1 ? (usable[0]?.id ?? '') : '' };
}

export function stationFormOf(station: StationView): StationForm {
  return { name: station.name, mode: station.mode, printerId: station.printerId ?? '' };
}

/** The server's checks: a name no other active station has, and a printer when it prints. */
export function checkStation(
  form: StationForm,
  stations: readonly StationView[],
  printers: readonly PrinterView[],
  selfId: string | undefined,
): Partial<Record<StationField, StationProblem>> {
  const problems: Partial<Record<StationField, StationProblem>> = {};
  if (!StationRequest.shape.name.safeParse(form.name).success) {
    problems.name = 'nameRequired';
  } else if (
    activeStations(stations).some(
      (station) => station.id !== selfId && sameName(station.name, form.name),
    )
  ) {
    problems.name = 'nameTaken';
  }
  if (
    form.mode !== 'SCREEN' &&
    !activePrinters(printers).some((printer) => printer.id === form.printerId)
  ) {
    problems.printerId = 'printerMissing';
  }
  return problems;
}

/** The request for a checked form; a station that only shows its tickets keeps no printer. */
export function stationRequestOf(form: StationForm): StationRequest {
  return {
    name: form.name.trim(),
    mode: form.mode,
    printerId: form.mode === 'SCREEN' ? null : form.printerId,
  };
}
