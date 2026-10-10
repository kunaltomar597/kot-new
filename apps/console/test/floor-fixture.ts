import type {
  FloorResponse,
  PrinterView,
  SectionView,
  StationView,
  TableView,
} from '@rp/contracts';
import { RESTAURANT_ID } from './fakes.js';

/** A floor, printers and stations for the Floor and the Stations and printers pages (P4-03d). */

const uuid = (n: number) => `0199a0e0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const UPDATED = '2026-09-27T04:00:00.000Z';
const ARCHIVED = '2026-09-25T04:00:00.000Z';

export const MAIN = uuid(1001);
export const TERRACE = uuid(1002);
/** Archived, with its one table. */
export const ROOF = uuid(1003);

export const TABLE_1 = uuid(1011);
export const TABLE_2 = uuid(1012);
/** Archived. */
export const TABLE_3 = uuid(1013);
export const TABLE_T1 = uuid(1021);
/** Archived, on the archived roof. */
export const TABLE_R1 = uuid(1031);
export const NEW_SECTION = uuid(1004);
export const NEW_TABLE = uuid(1041);
export const TABLET = uuid(1051);

export function table(overrides: Partial<TableView> & Pick<TableView, 'id' | 'label'>): TableView {
  return {
    capacity: 4,
    sectionId: MAIN,
    state: 'FREE',
    displayOrder: 1,
    tabletDeviceIds: [],
    archivedAt: null,
    updatedAt: UPDATED,
    ...overrides,
  };
}

export function section(
  overrides: Partial<SectionView> & Pick<SectionView, 'id' | 'name'>,
): SectionView {
  return { displayOrder: 1, archivedAt: null, tables: [], updatedAt: UPDATED, ...overrides };
}

/**
 * The Main Hall with table 1 (free, 4 seats), table 2 (6 seats, guests seated, a tablet paired)
 * and table 3 (archived); the Terrace with T1; and the archived Roof with its archived R1.
 */
export function floor(): FloorResponse {
  return {
    sections: [
      section({
        id: MAIN,
        name: 'Main Hall',
        displayOrder: 1,
        tables: [
          table({ id: TABLE_1, label: '1', displayOrder: 1 }),
          table({
            id: TABLE_2,
            label: '2',
            capacity: 6,
            state: 'OCCUPIED',
            displayOrder: 2,
            tabletDeviceIds: [TABLET],
          }),
          table({ id: TABLE_3, label: '3', capacity: 2, displayOrder: 3, archivedAt: ARCHIVED }),
        ],
      }),
      section({
        id: TERRACE,
        name: 'Terrace',
        displayOrder: 2,
        tables: [table({ id: TABLE_T1, label: 'T1', sectionId: TERRACE, displayOrder: 1 })],
      }),
      section({
        id: ROOF,
        name: 'Roof',
        displayOrder: 3,
        archivedAt: ARCHIVED,
        tables: [
          table({
            id: TABLE_R1,
            label: 'R1',
            sectionId: ROOF,
            displayOrder: 1,
            archivedAt: ARCHIVED,
          }),
        ],
      }),
    ],
  };
}

export const KITCHEN_PRINTER = uuid(1101);
export const BAR_PRINTER = uuid(1102);
/** Archived. */
export const OLD_PRINTER = uuid(1103);
export const NEW_PRINTER = uuid(1104);

export const TANDOOR = uuid(1201);
export const BAR = uuid(1202);
export const CURRY = uuid(1203);
/** Archived. */
export const GRILL = uuid(1204);
export const NEW_STATION = uuid(1205);

/** Last printed 27 Sep at 10:30 in the restaurant (IST). */
export const KITCHEN_LAST_SEEN = '2026-09-27T05:00:00.000Z';
/** Not printing since 27 Sep at 10:00 in the restaurant (IST). */
export const BAR_OFFLINE_SINCE = '2026-09-27T04:30:00.000Z';
export const BAR_ERROR =
  'No printer answers at the USB share "BarPrinter". Check that it is on, connected and shared.';

export function printer(
  overrides: Partial<PrinterView> & Pick<PrinterView, 'id' | 'name'>,
): PrinterView {
  return {
    connection: 'NETWORK',
    host: '192.168.1.50',
    port: 9100,
    paperWidthMm: 80,
    lastSeenAt: null,
    offlineSince: null,
    lastError: null,
    redirectToId: null,
    archivedAt: null,
    ...overrides,
  };
}

/**
 * The kitchen printer on the network (printing), the bar's USB printer on 58 mm paper (not
 * printing since 27 Sep), and an archived one, in the server's order (active ones by name).
 */
export function printers(): PrinterView[] {
  return [
    printer({
      id: BAR_PRINTER,
      name: 'Bar printer',
      connection: 'USB',
      host: 'BarPrinter',
      port: null,
      paperWidthMm: 58,
      lastSeenAt: '2026-09-27T03:00:00.000Z',
      offlineSince: BAR_OFFLINE_SINCE,
      lastError: BAR_ERROR,
    }),
    printer({ id: KITCHEN_PRINTER, name: 'Kitchen printer', lastSeenAt: KITCHEN_LAST_SEEN }),
    printer({ id: OLD_PRINTER, name: 'Old printer', host: '192.168.1.60', archivedAt: ARCHIVED }),
  ];
}

export function station(
  overrides: Partial<StationView> & Pick<StationView, 'id' | 'name'>,
): StationView {
  return { mode: 'SCREEN', printerId: null, archivedAt: null, ...overrides };
}

/** The bar prints only, the curry station shows its tickets only, the tandoor does both. */
export function stations(): StationView[] {
  return [
    station({ id: BAR, name: 'Bar', mode: 'PRINT', printerId: BAR_PRINTER }),
    station({ id: CURRY, name: 'Curry' }),
    station({ id: TANDOOR, name: 'Tandoor', mode: 'BOTH', printerId: KITCHEN_PRINTER }),
    station({ id: GRILL, name: 'Grill', archivedAt: ARCHIVED }),
  ];
}

/** A live `PrinterStatusChanged`: the printer stopped printing, with why, or prints again. */
export function printerStatusChanged(
  sequence: number,
  printer: Pick<PrinterView, 'id' | 'name'>,
  error: string | null,
) {
  return {
    sequence,
    event: {
      eventId: `0199a0e0-0000-7000-8000-0000000009${String(sequence).padStart(2, '0')}`,
      type: 'PrinterStatusChanged',
      version: 1,
      occurredAt: '2026-09-27T06:00:00.000Z',
      restaurantId: RESTAURANT_ID,
      businessDate: '2026-09-27',
      payload: {
        printerId: printer.id,
        printerName: printer.name,
        online: error === null,
        error,
        queued: error === null ? 0 : 2,
      },
    },
  };
}
