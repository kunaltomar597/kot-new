import type { PrinterView, StationView } from '@rp/contracts';

export const KITCHEN_PRINTER = '0199a0e0-0000-7000-8000-0000000000b1';
export const BAR_PRINTER = '0199a0e0-0000-7000-8000-0000000000b2';
export const OLD_PRINTER = '0199a0e0-0000-7000-8000-0000000000b3';
export const KITCHEN = '0199a0e0-0000-7000-8000-0000000000c1';
export const BAR = '0199a0e0-0000-7000-8000-0000000000c2';

/** A printer as the server lists it (P1-07): a network printer that printed this morning. */
export function printerView(overrides: Partial<PrinterView> = {}): PrinterView {
  return {
    id: KITCHEN_PRINTER,
    name: 'Kitchen printer',
    connection: 'NETWORK',
    host: '192.168.1.50',
    port: 9100,
    paperWidthMm: 80,
    lastSeenAt: '2026-10-01T04:30:00.000Z',
    offlineSince: null,
    lastError: null,
    redirectToId: null,
    archivedAt: null,
    ...overrides,
  };
}

export function stationView(overrides: Partial<StationView> = {}): StationView {
  return {
    id: KITCHEN,
    name: 'Kitchen',
    mode: 'BOTH',
    printerId: KITCHEN_PRINTER,
    archivedAt: null,
    ...overrides,
  };
}

/** A kitchen printer that prints, a bar printer on USB not yet tested, and an archived one. */
export function printers(): PrinterView[] {
  return [
    printerView(),
    printerView({
      id: BAR_PRINTER,
      name: 'Bar printer',
      connection: 'USB',
      host: 'BarPrinter',
      port: null,
      paperWidthMm: 58,
      lastSeenAt: null,
    }),
    printerView({ id: OLD_PRINTER, name: 'Old printer', archivedAt: '2026-09-01T10:00:00.000Z' }),
  ];
}

export function stations(): StationView[] {
  return [stationView(), stationView({ id: BAR, name: 'Bar', mode: 'SCREEN', printerId: null })];
}
