import { z } from 'zod';
import { Id, IdempotencyKey, IsoDate, OrderItemState, PriceMode, Timestamp } from '../common.js';
import { MenuSnapshot } from '../menu.js';
import { INSTRUCTION_HARD_MAX_LENGTH, OrderLineRequest, RejectedLine } from '../order.js';
import { RecommendationTarget } from '../recommendations.js';
import { AccentColor } from '../restaurant.js';
import { ITEM_PREFERENCES_MAX, TimeOfDay, TimeWindow } from '../settings.js';

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
export type QrPhotoSize = z.infer<typeof QrPhotoSize>;

/** A menu photo in every size the site may pick from (`srcset`), smallest first. */
export const QrPhoto = z.strictObject({
  photoId: Id,
  sizes: z.array(QrPhotoSize).min(1).max(6),
});
export type QrPhoto = z.infer<typeof QrPhoto>;

/** A restaurant's rule as the QR page runs it (REC-002), already limited to the QR channel. */
export const QrRecommendationRule = z.strictObject({
  id: Id,
  priority: z.int().min(0).max(1_000),
  when: RecommendationTarget,
  suggest: RecommendationTarget,
  timeWindow: TimeWindow.nullable(),
  activeFrom: IsoDate.nullable(),
  activeUntil: IsoDate.nullable(),
  label: z.string().min(1).max(60).nullable(),
});
export type QrRecommendationRule = z.infer<typeof QrRecommendationRule>;

const Ranking = z.array(Id).max(50);

/**
 * What the QR page's suggestions run on (QR-004, REC-001): the same engine as every surface, fed
 * from the restaurant's rules, its best sellers by time of day (a ranking, not counts, so the menu
 * is not sent again after every order), learned pairings (P6-02) and the manager's pins.
 */
export const QrRecommendations = z.strictObject({
  rules: z.array(QrRecommendationRule).max(500),
  /** Best first, for each time of day and the whole day (REC-004). */
  bestSellers: z.strictObject({
    ALL_DAY: Ranking,
    BREAKFAST: Ranking,
    LUNCH: Ranking,
    EVENING: Ranking,
    DINNER: Ranking,
  }),
  dayparts: z.strictObject({
    BREAKFAST: TimeWindow,
    LUNCH: TimeWindow,
    EVENING: TimeWindow,
    DINNER: TimeWindow,
  }),
  /** For the rules' business dates (BRD §9.4). */
  businessDayCutoff: TimeOfDay,
  courseSequence: z.array(z.string().min(1).max(30)).max(12),
  preferences: z
    .record(Id, z.enum(['PIN', 'BOOST', 'BLOCK']))
    .refine((preferences) => Object.keys(preferences).length <= ITEM_PREFERENCES_MAX),
  learned: z
    .array(z.strictObject({ fromItemId: Id, toItemId: Id, score: z.number().nonnegative() }))
    .max(5_000),
});
export type QrRecommendations = z.infer<typeof QrRecommendations>;

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
  /** QR-004; absent from menus published before P5-05b. */
  recommendations: QrRecommendations.optional(),
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
  /** Photos load from `<photoBase>/<path>` (the relay's Storage, through its CDN, QR-012). */
  photoBase: z.string().nullable(),
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

/** One kind of change a local server listens for on Realtime (P5-03d). */
export const RelayRealtimeChange = z.object({
  event: z.literal('INSERT'),
  schema: z.literal('relay'),
  table: z.enum(['qr_orders', 'qr_service_requests']),
  filter: z.string(),
});
export type RelayRealtimeChange = z.infer<typeof RelayRealtimeChange>;

/**
 * A short-lived token for the relay's Realtime channel (QR-009): the role `relay_server` and the
 * restaurant, so the subscription sees only its own new orders and requests. With it come the
 * project's public API key (Realtime's socket asks for one) and the changes to listen for.
 */
export const RelaySessionResponse = z.object({
  tenantId: Id,
  token: z.string().min(1),
  expiresAt: Timestamp,
  realtime: z.object({
    apiKey: z.string().min(1),
    changes: z.array(RelayRealtimeChange).min(1),
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

// ---------------------------------------------------------------- call waiter / request bill (P5-05c)

/** What a diner can ask for from the QR page (QR-011): the tablet's buttons. */
export const QrServiceRequestType = z.enum(['WATER', 'WAITER', 'BILL']);
export type QrServiceRequestType = z.infer<typeof QrServiceRequestType>;

/**
 * Where a diner's request is: SUBMITTED "Sending...", RECEIVED "Waiter notified", ACKNOWLEDGED
 * "Waiter is on the way", DONE, REJECTED (with the reason) or EXPIRED (not picked up in time).
 */
export const QrServiceRequestStatus = z.enum([
  'SUBMITTED',
  'RECEIVED',
  'ACKNOWLEDGED',
  'DONE',
  'REJECTED',
  'EXPIRED',
]);
export type QrServiceRequestStatus = z.infer<typeof QrServiceRequestStatus>;

export const QrServiceRequestView = z.object({
  id: Id,
  type: QrServiceRequestType,
  status: QrServiceRequestStatus,
  submittedAt: Timestamp,
  expiresAt: Timestamp,
  rejectionReason: z.string().nullable(),
});
export type QrServiceRequestView = z.infer<typeof QrServiceRequestView>;

/** QR-011: call a waiter or ask for the bill. Again while one is open finds the open one. */
export const QrServiceRequestBody = z.strictObject({
  type: QrServiceRequestType,
  idempotencyKey: IdempotencyKey,
});
export type QrServiceRequestBody = z.infer<typeof QrServiceRequestBody>;

export const QrServiceRequestResponse = z.object({
  /** The request was already open (pressed again, or sent again). */
  existing: z.boolean(),
  request: QrServiceRequestView,
});
export type QrServiceRequestResponse = z.infer<typeof QrServiceRequestResponse>;

export const QrServiceRequestQuery = z.strictObject({ id: Id });
export type QrServiceRequestQuery = z.infer<typeof QrServiceRequestQuery>;

/** A diner's request as the local server picks it up. */
export const QrPickupServiceRequest = z.object({
  id: Id,
  tableId: Id,
  type: QrServiceRequestType,
  submittedAt: Timestamp,
  expiresAt: Timestamp,
});
export type QrPickupServiceRequest = z.infer<typeof QrPickupServiceRequest>;

export const QrServiceRequestPickupResponse = z.object({
  requests: z.array(QrPickupServiceRequest),
});
export type QrServiceRequestPickupResponse = z.infer<typeof QrServiceRequestPickupResponse>;

export const QrServiceRequestParams = z.strictObject({ requestId: Id });
export type QrServiceRequestParams = z.infer<typeof QrServiceRequestParams>;

export const UpdateQrServiceRequest = z.strictObject({
  status: z.enum(['RECEIVED', 'ACKNOWLEDGED', 'DONE', 'REJECTED', 'EXPIRED']),
  rejectionReason: z.string().min(1).max(200).optional(),
});
export type UpdateQrServiceRequest = z.infer<typeof UpdateQrServiceRequest>;

export const UpdateQrServiceRequestResponse = z.object({ id: Id, status: QrServiceRequestStatus });
export type UpdateQrServiceRequestResponse = z.infer<typeof UpdateQrServiceRequestResponse>;

// ---------------------------------------------------------------- menu photos (P5-03c)

/** Photo sizes the relay stores: the local server's WebP renditions (P1-04). */
export const QrPhotoWidth = z.union([z.literal(160), z.literal(480), z.literal(960)]);
export type QrPhotoWidth = z.infer<typeof QrPhotoWidth>;

export const RelayPhotoParams = z.strictObject({
  photoId: Id,
  width: z.coerce.number().pipe(QrPhotoWidth),
});
export type RelayPhotoParams = z.infer<typeof RelayPhotoParams>;

/** Where the relay put one size of a photo, for the QR menu document. */
export const RelayPhotoUploadResponse = z.object({ path: z.string().min(1).max(300) });
export type RelayPhotoUploadResponse = z.infer<typeof RelayPhotoUploadResponse>;

/**
 * The photos the QR menu shows now (MENU-008). The others are marked removed and their files are
 * deleted 90 days after (BRD §9.3).
 */
export const RelayPhotoSweepRequest = z.strictObject({ inUse: z.array(Id).max(5_000) });
export type RelayPhotoSweepRequest = z.infer<typeof RelayPhotoSweepRequest>;

export const RelayPhotoSweepResponse = z.object({
  removed: z.int().nonnegative(),
  restored: z.int().nonnegative(),
  purged: z.int().nonnegative(),
  /** Photos in use whose files the relay does not have (never sent, or swept): send them again. */
  missing: z.array(Id),
});
export type RelayPhotoSweepResponse = z.infer<typeof RelayPhotoSweepResponse>;
