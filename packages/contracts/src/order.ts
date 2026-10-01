import { z } from 'zod';
import { Pin } from './auth.js';
import { Id, IdempotencyKey, OrderItemState, OrderSource, OrderType, Timestamp } from './common.js';
import { RecommendationSource } from './recommendations.js';

/** Default maximum length of per-item instructions (ORD-015 ⚙); the server applies the configured value. */
export const DEFAULT_INSTRUCTION_MAX_LENGTH = 140;
/** Absolute cap enforced at the API boundary regardless of configuration. */
export const INSTRUCTION_HARD_MAX_LENGTH = 500;

const Instructions = z.string().trim().max(INSTRUCTION_HARD_MAX_LENGTH);

/**
 * One line of an order submission. Deliberately has no price fields: the server prices every
 * line from its own menu data and ignores anything a client claims (ORD-014). Strict objects make
 * the API reject unknown keys instead of silently accepting them.
 */
export const OrderLineRequest = z.strictObject({
  clientLineId: z.uuid(),
  itemId: Id,
  quantity: z.int().positive().max(99),
  variantId: Id.optional(),
  modifiers: z
    .array(z.strictObject({ groupId: Id, optionIds: z.array(Id).max(20) }))
    .max(20)
    .default([]),
  /** Chosen items for combo choice slots, in component order. */
  comboChoices: z.array(Id).max(20).optional(),
  instructions: Instructions.optional(),
  /** The suggestion the line was added from, counted as ORDERED for its layer (REC-008). */
  recommendation: RecommendationSource.optional(),
});
export type OrderLineRequest = z.infer<typeof OrderLineRequest>;

/** ORD-001, ORD-013: submit an order from any surface. */
export const SubmitOrderRequest = z
  .strictObject({
    idempotencyKey: IdempotencyKey,
    source: OrderSource,
    orderType: OrderType,
    /** Required for dine-in. For QR the relay resolves it from the table token. */
    tableSessionId: Id.optional(),
    /** Takeaway customer details (TBL-008), optional. */
    customerName: z.string().trim().max(60).optional(),
    customerPhone: z
      .string()
      .regex(/^[0-9+\- ]{6,16}$/)
      .optional(),
    lines: z.array(OrderLineRequest).min(1).max(100),
    orderNote: Instructions.optional(),
  })
  .refine(
    (order) =>
      order.orderType === 'TAKEAWAY' || order.tableSessionId !== undefined || order.source === 'QR',
    {
      message: 'Dine-in orders need a tableSessionId',
      path: ['tableSessionId'],
    },
  );
export type SubmitOrderRequest = z.infer<typeof SubmitOrderRequest>;

/** ORD-017: lines rejected because an item became unavailable, with a clear reason. */
export const RejectedLine = z.object({
  clientLineId: z.uuid(),
  code: z.enum([
    'OUT_OF_STOCK',
    'NOT_AVAILABLE_NOW',
    'NOT_ON_CHANNEL',
    'INVALID_SELECTION',
    'ARCHIVED',
  ]),
  message: z.string(),
});

export const SubmitOrderResponse = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ACCEPTED'),
    orderId: Id,
    orderNumber: z.int().positive(),
    /** True when this idempotency key was already processed and the original result is returned. */
    replayed: z.boolean(),
    itemState: OrderItemState,
  }),
  z.object({
    status: z.literal('PARTIALLY_REJECTED'),
    rejectedLines: z.array(RejectedLine).min(1),
  }),
]);
export type SubmitOrderResponse = z.infer<typeof SubmitOrderResponse>;

/**
 * Whether a ticket reached its station's printer (KDS-008, WTR-012): NOT_REQUIRED for a station
 * that only has a screen, PENDING until printed, FAILED while its printer is down (it stays queued
 * and prints on recovery or on another printer).
 */
export const KotPrintStatus = z.enum(['NOT_REQUIRED', 'PENDING', 'PRINTED', 'FAILED']);
export type KotPrintStatus = z.infer<typeof KotPrintStatus>;

/** Kitchen ticket as shown on the KDS and printed (ORD-008, KDS-003). */
export const Kot = z.object({
  id: Id,
  kotNumber: z.int().positive(),
  businessDate: z.iso.date(),
  kind: z.enum(['NEW', 'MODIFIED', 'CANCELLED']),
  stationId: Id,
  orderId: Id,
  orderNumber: z.int().positive(),
  tableLabel: z.string().max(20).optional(),
  takeawayToken: z.int().positive().optional(),
  waiterName: z.string().max(60).optional(),
  source: OrderSource,
  createdAt: Timestamp,
  movedFrom: z.string().max(20).optional(),
  lines: z.array(
    z.object({
      orderItemId: Id,
      name: z.string(),
      quantity: z.int(),
      variantName: z.string().optional(),
      modifiers: z.array(z.string()),
      instructions: z.string().optional(),
      comboName: z.string().optional(),
      state: OrderItemState,
    }),
  ),
});
export type Kot = z.infer<typeof Kot>;

/** An order as staff screens show it (P1-06a). Prices are paise, as charged at order time. */
export const OrderView = z.object({
  id: Id,
  orderNumber: z.int().positive(),
  orderType: OrderType,
  source: OrderSource,
  status: z.enum(['OPEN', 'CLOSED', 'CANCELLED']),
  tableSessionId: Id.nullable(),
  tableId: Id.nullable(),
  takeawayToken: z.int().positive().nullable(),
  customerName: z.string().nullable(),
  businessDate: z.iso.date(),
  createdAt: Timestamp,
  note: z.string().nullable(),
  items: z.array(
    z.object({
      id: Id,
      itemId: Id,
      /** Set on the parts of a combo; the combo line carries the price. */
      parentOrderItemId: Id.nullable(),
      name: z.string(),
      /** The variant and options chosen, so the same item can be ordered again (NFR-U03). */
      variantId: Id.nullable(),
      variantName: z.string().nullable(),
      modifiers: z.array(z.object({ optionId: Id, name: z.string(), priceDelta: z.int() })),
      quantity: z.int().positive(),
      unitPrice: z.int().nonnegative(),
      lineTotal: z.int().nonnegative(),
      stationId: Id,
      state: OrderItemState,
      instructions: z.string().nullable(),
      /** Why a line was rejected, cancelled or voided: the diner sees a rejection's (ORD-003). */
      endReason: z.string().nullable().optional(),
    }),
  ),
  kots: z.array(
    z.object({
      id: Id,
      kotNumber: z.int().positive(),
      stationId: Id,
      stationName: z.string(),
      kind: z.enum(['NEW', 'MODIFIED', 'CANCELLED']),
      printStatus: KotPrintStatus,
    }),
  ),
});
export type OrderView = z.infer<typeof OrderView>;

/** Orders of a table session, or today's open takeaway orders, oldest first (TBL-007, TBL-008). */
export const OrderListResponse = z.object({ orders: z.array(OrderView) });
export type OrderListResponse = z.infer<typeof OrderListResponse>;

export const OrderParams = z.strictObject({ orderId: Id });
export type OrderParams = z.infer<typeof OrderParams>;

// ---------------------------------------------------------------- item changes (P1-06b)

export const OrderItemParams = z.strictObject({ orderItemId: Id });
export type OrderItemParams = z.infer<typeof OrderItemParams>;

/** ORD-010: the kitchen and floor move items along (`@rp/domain` `orderItemMachine`). */
export const OrderItemStatusRequest = z.strictObject({
  event: z.enum(['START_PREPARING', 'MARK_READY', 'PICK_UP', 'SERVE']),
});
export type OrderItemStatusRequest = z.infer<typeof OrderItemStatusRequest>;

/** ORD-011: cancel before preparation, or void after it (with a manager's approval). */
export const OrderItemEndRequest = z.strictObject({
  reason: z.string().trim().min(3).max(200),
});
export type OrderItemEndRequest = z.infer<typeof OrderItemEndRequest>;

/** ORD-012: change quantity or instructions while the kitchen has not started. */
export const ModifyOrderItemRequest = z
  .strictObject({
    quantity: z.int().min(1).max(99).optional(),
    instructions: z.string().trim().max(INSTRUCTION_HARD_MAX_LENGTH).nullable().optional(),
  })
  .refine((change) => change.quantity !== undefined || change.instructions !== undefined, {
    message: 'Change the quantity or the instructions',
  });
export type ModifyOrderItemRequest = z.infer<typeof ModifyOrderItemRequest>;

// ---------------------------------------------------------------- diners' orders and approval (P3-03a)

/**
 * A diner's order from the table tablet (TAB-008, TAB-009): always for the tablet's own open table
 * (AUTH-009), and without prices: the server prices it (ORD-014). It waits for a waiter's approval
 * (ORD-003).
 */
export const TabletOrderRequest = z.strictObject({
  idempotencyKey: IdempotencyKey,
  lines: z.array(OrderLineRequest).min(1).max(100),
  orderNote: Instructions.optional(),
});
export type TabletOrderRequest = z.infer<typeof TabletOrderRequest>;

/**
 * The orders placed at a tablet's table in its open session (TAB-009, TAB-010): every line's
 * status, what will be billed so far, and what still waits for the waiter. No session: empty.
 */
export const TabletOrdersResponse = z.object({
  tableSessionId: Id.nullable(),
  orders: z.array(OrderView),
  /** Line totals of the lines on their way to the bill (sent or further), before tax. */
  runningTotal: z.int().nonnegative(),
  /** Line totals of the lines waiting for the waiter's approval. */
  pendingTotal: z.int().nonnegative(),
});
export type TabletOrdersResponse = z.infer<typeof TabletOrdersResponse>;

/** A line's new quantity before approval; 0 removes it (ORD-003). */
export const ApprovalChange = z.strictObject({
  orderItemId: Id,
  quantity: z.int().min(0).max(99),
});
export type ApprovalChange = z.infer<typeof ApprovalChange>;

const approvalChanges = {
  /** Quantities changed, or lines removed, before approving. */
  changes: z.array(ApprovalChange).max(100).default([]),
  /** Changes are made only with the diner's agreement (ORD-003). */
  dinerAgreed: z.boolean().default(false),
};

const agreed = (request: { changes: readonly unknown[]; dinerAgreed: boolean }) =>
  request.changes.length === 0 || request.dinerAgreed;
const agreedMessage = {
  message: 'Change an order only with the diner’s agreement',
  path: ['dinerAgreed'],
};

/**
 * ORD-003, ORD-004, WTR-004: a waiter (their own tables), the cashier or a manager sends a diner's
 * order to the kitchen, with any quantities changed or lines removed with the diner's agreement.
 */
export const ApproveOrderRequest = z.strictObject(approvalChanges).refine(agreed, agreedMessage);
export type ApproveOrderRequest = z.input<typeof ApproveOrderRequest>;

/** ORD-003: a diner's order refused, with a reason the diner sees. */
export const RejectOrderRequest = z.strictObject({ reason: z.string().trim().min(3).max(200) });
export type RejectOrderRequest = z.infer<typeof RejectOrderRequest>;

/**
 * "Approve at table" (ORD-004): the waiter enters their PIN on the tablet while talking to the
 * diner; the server checks it like a sign-in (lock-out included) and approves as that waiter.
 */
export const ApproveAtTableRequest = z
  .strictObject({ staffId: Id, pin: Pin, ...approvalChanges })
  .refine(agreed, agreedMessage);
export type ApproveAtTableRequest = z.input<typeof ApproveAtTableRequest>;

/** The approvals inbox (WTR-004): diners' orders waiting, oldest first, with their table. */
export const PendingApprovalsResponse = z.object({
  orders: z.array(
    z.object({
      order: OrderView,
      tableLabel: z.string().nullable(),
      /** The table's waiter, who is alerted (ORD-005). */
      waiterId: Id.nullable(),
    }),
  ),
});
export type PendingApprovalsResponse = z.infer<typeof PendingApprovalsResponse>;

/** The menu's bestsellers (TAB-005): the most ordered dishes lately, for the badge and filter. */
export const BestSellersResponse = z.object({ itemIds: z.array(Id) });
export type BestSellersResponse = z.infer<typeof BestSellersResponse>;
