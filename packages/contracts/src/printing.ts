import { z } from 'zod';
import { Id, Timestamp } from './common.js';

/**
 * Kitchen stations and printers (P1-07, KDS-002, KDS-008, ONB-004 step 6). Each station shows its
 * tickets on screen, prints them, or both; printers are network (IP, raw port 9100) or USB, ESC/POS,
 * 80 or 58 mm paper.
 */

const Reason = z.string().trim().min(3).max(200);

export const StationMode = z.enum(['SCREEN', 'PRINT', 'BOTH']);
export type StationMode = z.infer<typeof StationMode>;

export const StationRequest = z
  .strictObject({
    name: z.string().trim().min(1).max(40),
    mode: StationMode,
    /** Needed when the station prints. */
    printerId: Id.nullable(),
  })
  .refine((station) => station.mode === 'SCREEN' || station.printerId !== null, {
    message: 'A station that prints needs a printer',
    path: ['printerId'],
  });
export type StationRequest = z.infer<typeof StationRequest>;

export const StationView = z.object({
  id: Id,
  name: z.string(),
  mode: StationMode,
  printerId: Id.nullable(),
  archivedAt: Timestamp.nullable(),
});
export type StationView = z.infer<typeof StationView>;

export const StationListResponse = z.object({ stations: z.array(StationView) });
export type StationListResponse = z.infer<typeof StationListResponse>;

export const PrinterConnection = z.enum(['NETWORK', 'USB']);

/** An IPv4 address or a LAN host name. */
export const NETWORK_HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,118}[A-Za-z0-9])?$/;
/** A USB printer shared on the server PC under this name (Windows raw printing). */
export const USB_SHARE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/;
/** A USB printer device on a Linux server (development and tests). */
export const USB_DEVICE = /^\/dev\/usb\/lp\d{1,2}$/;

export const PrinterRequest = z
  .strictObject({
    name: z.string().trim().min(1).max(40),
    connection: PrinterConnection,
    /** NETWORK: IPv4 address or host name; USB: the printer's share name on the server PC. */
    host: z.string().trim().min(1).max(120),
    /** NETWORK only; raw printing is usually 9100. */
    port: z.int().min(1).max(65_535).nullable(),
    paperWidthMm: z.union([z.literal(58), z.literal(80)]),
  })
  .refine((printer) => printer.connection === 'USB' || printer.port !== null, {
    message: 'A network printer needs a port (usually 9100)',
    path: ['port'],
  })
  .refine(
    (printer) =>
      printer.connection === 'NETWORK'
        ? NETWORK_HOST.test(printer.host)
        : USB_SHARE.test(printer.host) || USB_DEVICE.test(printer.host),
    {
      message:
        'Use an IP address or host name for a network printer, and the printer share name for a USB printer',
      path: ['host'],
    },
  );
export type PrinterRequest = z.infer<typeof PrinterRequest>;

export const PrinterView = z.object({
  id: Id,
  name: z.string(),
  connection: PrinterConnection,
  host: z.string().nullable(),
  port: z.int().nullable(),
  paperWidthMm: z.int(),
  /** Last time the printer took a job or a test page. */
  lastSeenAt: Timestamp.nullable(),
  /** Since when jobs fail; null while it prints (KDS-008). */
  offlineSince: Timestamp.nullable(),
  /** Why the last job failed, in plain words. */
  lastError: z.string().nullable(),
  /** The printer this one's jobs go to instead, set by a manager while it is broken. */
  redirectToId: Id.nullable(),
  archivedAt: Timestamp.nullable(),
});
export type PrinterView = z.infer<typeof PrinterView>;

export const PrinterListResponse = z.object({ printers: z.array(PrinterView) });
export type PrinterListResponse = z.infer<typeof PrinterListResponse>;

export const PrintingArchiveRequest = z.strictObject({ reason: Reason });
export type PrintingArchiveRequest = z.infer<typeof PrintingArchiveRequest>;

export const PrintingParams = z.strictObject({ id: Id });
export type PrintingParams = z.infer<typeof PrintingParams>;

export const TestPrintResponse = z.object({
  printed: z.boolean(),
  /** Why it failed, in plain words, when it did. */
  error: z.string().nullable(),
});
export type TestPrintResponse = z.infer<typeof TestPrintResponse>;

/** Send one printer's jobs to another until cleared (KDS-008); `toPrinterId: null` clears it. */
export const PrinterRedirectRequest = z.strictObject({
  toPrinterId: Id.nullable(),
  reason: Reason,
});
export type PrinterRedirectRequest = z.infer<typeof PrinterRedirectRequest>;

/** Print a kitchen ticket again (KDS-008), on its station's printer or on the one chosen. */
export const KotReprintRequest = z.strictObject({
  printerId: Id.nullable().default(null),
  reason: Reason,
});
export type KotReprintRequest = z.input<typeof KotReprintRequest>;

export const KotParams = z.strictObject({ id: Id });
export type KotParams = z.infer<typeof KotParams>;

/** A printer as the print queue sees it, for the POS "printer offline" banner. */
export const PrintQueuePrinter = z.object({
  printerId: Id,
  name: z.string(),
  online: z.boolean(),
  offlineSince: Timestamp.nullable(),
  lastError: z.string().nullable(),
  redirectToId: Id.nullable(),
  /** Tickets and notes waiting for this printer. */
  queued: z.int().min(0),
});
export type PrintQueuePrinter = z.infer<typeof PrintQueuePrinter>;

export const PrintQueueResponse = z.object({ printers: z.array(PrintQueuePrinter) });
export type PrintQueueResponse = z.infer<typeof PrintQueueResponse>;
