import { z } from 'zod';
import { Id, IdempotencyKey, OrderItemState, PriceMode, Timestamp } from '../common.js';
import { MenuSnapshot } from '../menu.js';
import { INSTRUCTION_HARD_MAX_LENGTH, OrderLineRequest, RejectedLine } from '../order.js';
import { AccentColor } from '../restaurant.js';

/**
 * The QR relay's API (C8, ADR-0015): what diners' browsers send through the relay's edge
 * functions and what the local server publishes to it. Shared by the relay, the QR site (P5-05)
 * and the local server's sync agent (P5-03).
 */

/** Request header with the table's QR token (QR-001), kept out of URLs and access logs. */
export const TABLE_TOKEN_HEADER = 'x-rp-table-token';
/** Request header with the browser's own random id, for the per-browser rate limit (QR-006). */
export const BROWSER_ID_HEADER = 'x-rp-browser';

/** A table's QR token: at least 128 random bits, base64url (QR-001, P5-04). */
export const TableToken = z.string().regex(/^[A-Za-z0-9_-]{22,128}$/);
/** A browser's anonymous id, made once and kept in its storage (QR-013: nothing that tracks). */
export const BrowserId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

/** One size of a menu photo in the relay's Storage, under the restaurant's folder (QR-012). */
export const QrPhotoSize = z.strictObject({
  width: z.int().positive().max(4096),
  height: z.int().positive().max(4096),
  path: z.string().min(1).max(300),
});

/** A menu photo in every size the site may pick from (`srcset`), smallest first. */
export const QrPhoto = z.strictObject({
  photoId: Id,
  sizes: z.array(QrPhotoSize).min(1).max(6),
});

/**
 * What a local server publishes for its QR menu (QR-002, QR-003, MENU-013): the menu the QR
 * channel offers, live availability included, and what the site needs to show and check it.
 */
export const QrMenuDocument = z.strictObject({
  restaurantName: z.string().min(1).max(120),
  accentColor: AccentColor.optional(),
  /** The restaurant's IANA time zone, for combos offered on some days or hours (MENU-005). */
  timeZone: z.string().min(1).max(60),
  /** ORD-015: the restaurant's limit on a line's instructions. */
  instructionMaxLength: z.int().min(0).max(INSTRUCTION_HARD_MAX_LENGTH),
  /** Whether menu prices include GST (BILL-004), for the cart's estimate. */
  priceMode: PriceMode,
  /** QR-011 (S): the page offers Call waiter and Request bill. */
  serviceRequests: z.boolean(),
  menu: MenuSnapshot,
  photos: z.array(QrPhoto).max(2000),
});
export type QrMenuDocument = z.infer<typeof QrMenuDocument>;

/** The menu as a diner's browser gets it, with the table and whether ordering is open. */
export const QrMenuResponse = z.object({
  table: z.object({ label: z.string() }),
  /** The relay's publication version; a submission is checked against the latest. */
  version: z.int().positive(),
  /** QR-008: the restaurant has not been heard from, so the menu is read-only. */
  readOnly: z.boolean(),
  /** QR-007: after this long without the restaurant picking it up, an order expires. */
  pickupTimeoutSeconds: z.int().positive(),
  /** The menu; null when the browser already has this version (`?known=`). */
  document: QrMenuDocument.nullable(),
});
export type QrMenuResponse = z.infer<typeof QrMenuResponse>;

/** The menu version the browser already has, so an unchanged menu is not sent again. */
export const QrMenuQuery = z.strictObject({ known: z.coerce.number().int().positive().optional() });
export type QrMenuQuery = z.infer<typeof QrMenuQuery>;

/** A diner's order (QR-005, QR-006): dine-in only, no payment, no prices (ORD-014). */
export const QrSubmitOrderRequest = z.strictObject({
  idempotencyKey: IdempotencyKey,
  lines: z.array(OrderLineRequest).min(1).max(100),
  orderNote: z.string().trim().max(INSTRUCTION_HARD_MAX_LENGTH).optional(),
  /** QR-005: optional. */
  customerName: z.string().trim().min(1).max(60).optional(),
});
export type QrSubmitOrderRequest = z.infer<typeof QrSubmitOrderRequest>;

/**
 * Where a QR order is (QR-007). SUBMITTED: "Sending your order to the restaurant..."; RECEIVED:
 * "Received, waiting for waiter confirmation"; SENT_TO_KITCHEN: "Your order has been sent to the
 * kitchen"; EXPIRED: not picked up in time, "Please call a waiter"; REJECTED: with the reason.
 */
export const QrOrderStatus = z.enum([
  'SUBMITTED',
  'RECEIVED',
  'SENT_TO_KITCHEN',
  'REJECTED',
  'EXPIRED',
]);
export type QrOrderStatus = z.infer<typeof QrOrderStatus>;

/** What the local server tells the relay about an order beyond its status (P5-03). */
export const QrOrderStatusDetail = z.strictObject({
  /** Why the waiter rejected it, as the diner should read it (ORD-004). */
  rejectionReason: z.string().min(1).max(200).optional(),
  /** QR-007 (S): each line's state in the kitchen. */
  items: z
    .array(z.strictObject({ clientLineId: z.uuid(), state: OrderItemState }))
    .max(200)
    .optional(),
});
export type QrOrderStatusDetail = z.infer<typeof QrOrderStatusDetail>;

/** A QR order as its diner sees it. An order past its pickup time reads EXPIRED at once. */
export const QrOrderView = z.object({
  id: Id,
  status: QrOrderStatus,
  submittedAt: Timestamp,
  expiresAt: Timestamp,
  lines: z.array(OrderLineRequest),
  orderNote: z.string().nullable(),
  customerName: z.string().nullable(),
  detail: QrOrderStatusDetail,
});
export type QrOrderView = z.infer<typeof QrOrderView>;

/**
 * The answer to a submission: the order (`replayed` when the idempotency key was seen before at
 * this table, ORD-013), or the lines the latest menu cannot serve, with nothing stored (ORD-017).
 */
export const QrSubmitOrderResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ACCEPTED'), replayed: z.boolean(), order: QrOrderView }),
  z.object({
    status: z.literal('REJECTED'),
    rejectedLines: z.array(RejectedLine).min(1),
    /** The menu version the lines were checked against; the site reloads the menu. */
    version: z.int().positive(),
  }),
]);
export type QrSubmitOrderResponse = z.infer<typeof QrSubmitOrderResponse>;

export const QrOrderStatusQuery = z.strictObject({ id: Id });
export type QrOrderStatusQuery = z.infer<typeof QrOrderStatusQuery>;

// ---------------------------------------------------------------- the local server's side (P5-02b)

/**
 * A local server's credential for the relay (VCP-002): 256 random bits, base64url, sent as
 * `Authorization: Bearer <credential>`. The relay keeps only its SHA-256.
 */
export const RelayCredential = z.string().regex(/^[A-Za-z0-9_-]{43,200}$/);

/** A table token's SHA-256 over its UTF-8 bytes, in lower-case hex: all the relay keeps (QR-001). */
export const TokenHash = z.string().regex(/^[0-9a-f]{64}$/);

/** The QR settings the relay enforces (`qr.*`), with the registry's limits. */
export const QrRelaySettings = z.strictObject({
  submissionsPerWindow: z.int().min(1).max(50),
  rateLimitWindowMinutes: z.int().min(1).max(120),
  pickupTimeoutSeconds: z.int().min(15).max(600),
  presenceIntervalSeconds: z.int().min(5).max(300),
  readOnlyAfterSeconds: z.int().min(30).max(1_800),
});
export type QrRelaySettings = z.infer<typeof QrRelaySettings>;

/** QR-008: the local server's heartbeat, with the settings the relay should enforce. */
export const RelayPresenceRequest = z.strictObject({
  serverVersion: z.string().min(1).max(40),
  settings: QrRelaySettings,
});
export type RelayPresenceRequest = z.infer<typeof RelayPresenceRequest>;

export const RelayPresenceResponse = z.object({
  /** The relay's clock, so the local server can see a skew that would expire orders early. */
  serverTime: Timestamp,
});
export type RelayPresenceResponse = z.infer<typeof RelayPresenceResponse>;

/**
 * A short-lived token for the relay's Realtime channel (QR-009): the role `relay_server` and the
 * restaurant, so the subscription sees only its own new orders.
 */
export const RelaySessionResponse = z.object({
  tenantId: Id,
  token: z.string().min(1),
  expiresAt: Timestamp,
  realtime: z.object({
    schema: z.literal('relay'),
    table: z.literal('qr_orders'),
    filter: z.string(),
  }),
});
export type RelaySessionResponse = z.infer<typeof RelaySessionResponse>;

/** QR-003: a new publication of the QR menu; versions only grow. */
export const PublishQrMenuRequest = z.strictObject({
  version: z.int().positive(),
  document: QrMenuDocument,
});
export type PublishQrMenuRequest = z.infer<typeof PublishQrMenuRequest>;

export const PublishQrMenuResponse = z.object({
  version: z.int().positive(),
  /** This version was already published with the same document (an outbox retry). */
  replayed: z.boolean(),
});
export type PublishQrMenuResponse = z.infer<typeof PublishQrMenuResponse>;

/** One dining table as the relay knows it: no QR code when `tokenHash` is null (QR-001). */
export const RelayTable = z.strictObject({
  tableId: Id,
  label: z.string().min(1).max(40),
  tokenHash: TokenHash.nullable(),
  active: z.boolean(),
});
export type RelayTable = z.infer<typeof RelayTable>;

/** Every table of the restaurant; tables left out are taken out of service, never deleted. */
export const SyncRelayTablesRequest = z.strictObject({
  tables: z.array(RelayTable).max(500),
});
export type SyncRelayTablesRequest = z.infer<typeof SyncRelayTablesRequest>;

export const SyncRelayTablesResponse = z.object({
  /** Tables in service with a QR code. */
  withCode: z.int().nonnegative(),
  /** Tables taken out of service because the list left them out. */
  deactivated: z.int().nonnegative(),
});
export type SyncRelayTablesResponse = z.infer<typeof SyncRelayTablesResponse>;

/** A diner's order as the local server picks it up (QR-009): prices come from its own menu. */
export const QrPickupOrder = z.object({
  id: Id,
  tableId: Id,
  idempotencyKey: IdempotencyKey,
  lines: z.array(OrderLineRequest),
  orderNote: z.string().nullable(),
  customerName: z.string().nullable(),
  /** The publication the lines were checked against. */
  menuVersion: z.int().positive(),
  submittedAt: Timestamp,
  expiresAt: Timestamp,
});
export type QrPickupOrder = z.infer<typeof QrPickupOrder>;

/** Orders waiting to be picked up, oldest first: the polling fallback to Realtime. */
export const QrPickupResponse = z.object({ orders: z.array(QrPickupOrder) });
export type QrPickupResponse = z.infer<typeof QrPickupResponse>;

export const QrOrderParams = z.strictObject({ orderId: Id });
export type QrOrderParams = z.infer<typeof QrOrderParams>;

/**
 * What became of a diner's order (QR-007): received by the restaurant (with its local order),
 * sent to the kitchen, rejected with the reason, or expired; and the kitchen's item states (S).
 */
export const UpdateQrOrderRequest = z.strictObject({
  status: z.enum(['RECEIVED', 'SENT_TO_KITCHEN', 'REJECTED', 'EXPIRED']),
  detail: QrOrderStatusDetail.optional(),
  localOrderId: Id.optional(),
});
export type UpdateQrOrderRequest = z.infer<typeof UpdateQrOrderRequest>;

export const UpdateQrOrderResponse = z.object({ id: Id, status: QrOrderStatus });
export type UpdateQrOrderResponse = z.infer<typeof UpdateQrOrderResponse>;
