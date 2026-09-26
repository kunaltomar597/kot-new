import { z } from 'zod';
import { Id, OrderItemState, OrderSource, Timestamp } from './common.js';

/**
 * The kitchen display (P1-09, KDS-001 to KDS-012). A kitchen screen in station mode sees its own
 * station; a signed-in person may choose a station or see them all.
 */

export const KdsTicketsQuery = z.strictObject({ stationId: Id.optional() });
export type KdsTicketsQuery = z.infer<typeof KdsTicketsQuery>;

export const KdsTicketParams = z.strictObject({ kotId: Id });
export type KdsTicketParams = z.infer<typeof KdsTicketParams>;

/** One line of a ticket as the kitchen cooks it (KDS-003). */
export const KdsTicketLine = z.object({
  orderItemId: Id,
  /** Negative on a MODIFIED ticket that reduces a line. */
  quantity: z.int(),
  name: z.string(),
  variantName: z.string().nullable(),
  modifiers: z.array(z.string()),
  instructions: z.string().nullable(),
  /** The combo the line belongs to, so its parts are grouped under it. */
  comboName: z.string().nullable(),
  /** The item's state now (it moves on after the ticket was raised). */
  state: OrderItemState,
  readyAt: Timestamp.nullable(),
});
export type KdsTicketLine = z.infer<typeof KdsTicketLine>;

export const KdsTicket = z.object({
  kotId: Id,
  kotNumber: z.int().positive(),
  kind: z.enum(['NEW', 'MODIFIED', 'CANCELLED']),
  stationId: Id,
  stationName: z.string(),
  orderId: Id,
  orderNumber: z.int().positive(),
  tableLabel: z.string().nullable(),
  takeawayToken: z.int().positive().nullable(),
  /** The table the guests moved from after the ticket was raised (TBL-005 "Moved" badge). */
  movedFrom: z.string().nullable(),
  waiterName: z.string().nullable(),
  source: OrderSource,
  createdAt: Timestamp,
  bumpedAt: Timestamp.nullable(),
  /** "Notify manager" was pressed for this ticket and the alert is still open (KDS-006). */
  managerNotified: z.boolean(),
  lines: z.array(KdsTicketLine),
});
export type KdsTicket = z.infer<typeof KdsTicket>;

/** The settings a kitchen screen needs (KDS-004, KDS-006, KDS-009). */
export const KdsSettings = z.object({
  ageAmberMinutes: z.int().positive(),
  ageRedMinutes: z.int().positive(),
  readyNotCollectedMinutes: z.int().positive(),
  soundVolumePercent: z.int().min(0).max(100),
});
export type KdsSettings = z.infer<typeof KdsSettings>;

export const KdsTicketsResponse = z.object({
  /** The station shown; null for all stations. */
  station: z.object({ id: Id, name: z.string() }).nullable(),
  /** Open tickets, oldest first. */
  tickets: z.array(KdsTicket),
  /** Tickets bumped in the last hour, newest first, for Recall (KDS-005). */
  recentlyBumped: z.array(KdsTicket),
  settings: KdsSettings,
  /** The server's clock, so ages are right even when the screen's clock drifts. */
  serverTime: Timestamp,
});
export type KdsTicketsResponse = z.infer<typeof KdsTicketsResponse>;

export const NotifyManagerResponse = z.object({ alertId: Id, alreadyOpen: z.boolean() });
export type NotifyManagerResponse = z.infer<typeof NotifyManagerResponse>;
