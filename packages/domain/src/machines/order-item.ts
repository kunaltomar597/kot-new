import { defineStateMachine } from '../state-machine.js';

/** Where an order came from (ORD-001). */
export const ORDER_SOURCES = ['POS', 'WAITER_APP', 'TABLE_TABLET', 'QR'] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

/** Customer-originated orders need waiter approval before the kitchen sees them (ORD-003). */
export function isCustomerSource(source: OrderSource): boolean {
  return source === 'TABLE_TABLET' || source === 'QR';
}

export const ORDER_ITEM_STATES = [
  'PENDING_APPROVAL',
  'SENT',
  'PREPARING',
  'READY',
  'PICKED_UP',
  'SERVED',
  'REJECTED',
  'CANCELLED',
  'VOIDED',
] as const;
export type OrderItemState = (typeof ORDER_ITEM_STATES)[number];

export const ORDER_ITEM_EVENTS = [
  'APPROVE',
  'REJECT',
  'START_PREPARING',
  'MARK_READY',
  'PICK_UP',
  'SERVE',
  'CANCEL',
  'VOID',
] as const;
export type OrderItemEvent = (typeof ORDER_ITEM_EVENTS)[number];

/**
 * Order item lifecycle (BRD Appendix B, ORD-010, ORD-011).
 *
 * Two shortcuts are allowed beyond the diagram, both recorded in docs/build/PROGRESS.md as
 * product decisions to confirm: the KDS may mark a SENT item READY in one tap, and a waiter may
 * mark a READY item SERVED directly. The server stores the implied intermediate timestamps.
 */
export const orderItemMachine = defineStateMachine<OrderItemState, OrderItemEvent>({
  name: 'OrderItem',
  states: ORDER_ITEM_STATES,
  terminal: ['REJECTED', 'CANCELLED', 'VOIDED'],
  transitions: [
    { event: 'APPROVE', from: ['PENDING_APPROVAL'], to: 'SENT' },
    { event: 'REJECT', from: ['PENDING_APPROVAL'], to: 'REJECTED', requiresReason: true },
    { event: 'START_PREPARING', from: ['SENT'], to: 'PREPARING' },
    { event: 'MARK_READY', from: ['SENT', 'PREPARING'], to: 'READY' },
    { event: 'PICK_UP', from: ['READY'], to: 'PICKED_UP' },
    { event: 'SERVE', from: ['READY', 'PICKED_UP'], to: 'SERVED' },
    // ORD-011: after Sent but before Preparing a waiter can cancel with a reason.
    { event: 'CANCEL', from: ['SENT'], to: 'CANCELLED', requiresReason: true },
    // ORD-011: after Preparing only a void is possible, with a manager PIN and a reason.
    {
      event: 'VOID',
      from: ['PREPARING', 'READY', 'PICKED_UP', 'SERVED'],
      to: 'VOIDED',
      requiresReason: true,
      requiresManagerOverride: true,
    },
  ],
});

/** First state of a newly submitted item (ORD-003, ORD-006). */
export function initialOrderItemState(source: OrderSource): OrderItemState {
  return isCustomerSource(source) ? 'PENDING_APPROVAL' : 'SENT';
}

const BILLABLE: ReadonlySet<OrderItemState> = new Set<OrderItemState>([
  'SENT',
  'PREPARING',
  'READY',
  'PICKED_UP',
  'SERVED',
]);

/** Items in these states appear on the bill. */
export function isBillable(state: OrderItemState): boolean {
  return BILLABLE.has(state);
}

/** Items the kitchen still has to act on. */
export function isKitchenActive(state: OrderItemState): boolean {
  return state === 'SENT' || state === 'PREPARING' || state === 'READY';
}
