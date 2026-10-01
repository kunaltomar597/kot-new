import { z } from 'zod';
import { Id, IdempotencyKey, OrderItemState, Timestamp } from '../common.js';
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
  document: QrMenuDocument,
});
export type QrMenuResponse = z.infer<typeof QrMenuResponse>;

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
