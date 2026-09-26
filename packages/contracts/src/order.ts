import { z } from 'zod';
import { Id, IdempotencyKey, OrderItemState, OrderSource, OrderType, Timestamp } from './common.js';

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
      variantName: z.string().nullable(),
      modifiers: z.array(z.object({ name: z.string(), priceDelta: z.int() })),
      quantity: z.int().positive(),
      unitPrice: z.int().nonnegative(),
      lineTotal: z.int().nonnegative(),
      stationId: Id,
      state: OrderItemState,
      instructions: z.string().nullable(),
    }),
  ),
  kots: z.array(
    z.object({
      id: Id,
      kotNumber: z.int().positive(),
      stationId: Id,
      kind: z.enum(['NEW', 'MODIFIED', 'CANCELLED']),
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
