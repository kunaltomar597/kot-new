import type { QrOrderStatus, QrOrderStatusDetail } from '@rp/contracts/relay';
import type { OrderItemState } from '@rp/domain';

/**
 * What a diner's QR page should say about their order (QR-007), from the restaurant's own record
 * of it (P5-03b): the local server tells the relay this whenever it changes.
 */

/** How the restaurant dealt with a QR order it picked up. */
export type QrOutcome = 'CREATED' | 'REJECTED' | 'EXPIRED';

export interface QrOrderRecord {
  readonly outcome: QrOutcome;
  /** Why nothing was created (REJECTED): the lines the menu could not serve, say. */
  readonly rejectionReason: string | null;
  /** The order's lines (not combo parts), with the diner's line ids. */
  readonly lines: readonly {
    readonly clientLineId: string | null;
    readonly state: OrderItemState;
    readonly endReason: string | null;
  }[];
}

export interface QrStatusTarget {
  readonly status: Exclude<QrOrderStatus, 'SUBMITTED'>;
  readonly detail: QrOrderStatusDetail;
}

/** On their way to or through the kitchen. */
const SENT: ReadonlySet<OrderItemState> = new Set([
  'SENT',
  'PREPARING',
  'READY',
  'PICKED_UP',
  'SERVED',
  'CANCELLED',
  'VOIDED',
]);

/**
 * - EXPIRED: not picked up in time;
 * - REJECTED: nothing was created, or the waiter rejected every line (with the reason);
 * - SENT_TO_KITCHEN: approved, with each line's state (S);
 * - RECEIVED: waiting for the waiter.
 */
export function qrStatusOf(record: QrOrderRecord): QrStatusTarget {
  if (record.outcome === 'EXPIRED') return { status: 'EXPIRED', detail: {} };
  const reason = (text: string | null) =>
    text === null || text.trim() === '' ? {} : { rejectionReason: text.trim().slice(0, 200) };
  if (record.outcome === 'REJECTED') {
    return { status: 'REJECTED', detail: reason(record.rejectionReason) };
  }
  const lines = record.lines.filter(
    (line): line is typeof line & { clientLineId: string } => line.clientLineId !== null,
  );
  if (lines.some((line) => SENT.has(line.state))) {
    return {
      status: 'SENT_TO_KITCHEN',
      detail: {
        items: lines.map((line) => ({ clientLineId: line.clientLineId, state: line.state })),
      },
    };
  }
  if (lines.length > 0 && lines.every((line) => line.state === 'REJECTED')) {
    return { status: 'REJECTED', detail: reason(lines[0]?.endReason ?? null) };
  }
  return { status: 'RECEIVED', detail: {} };
}

/**
 * The steps the relay must take from what it was last told to `target`: it only moves forward
 * (SUBMITTED, then RECEIVED, then SENT_TO_KITCHEN or REJECTED), so an order first told now is
 * received on the way. Empty when there is nothing to tell.
 */
export function qrSteps(
  pushed: QrOrderStatus | null,
  target: QrStatusTarget['status'],
): QrStatusTarget['status'][] {
  const from = pushed ?? 'SUBMITTED';
  if (from === 'EXPIRED' || from === 'REJECTED') return [];
  if (target === 'EXPIRED') return from === 'SUBMITTED' ? ['EXPIRED'] : [];
  if (from === 'SENT_TO_KITCHEN') return target === 'SENT_TO_KITCHEN' ? ['SENT_TO_KITCHEN'] : [];
  if (target === 'RECEIVED') return ['RECEIVED'];
  return from === 'SUBMITTED' ? ['RECEIVED', target] : [target];
}

// ---------------------------------------------------------------- call waiter / request bill

/** How the restaurant dealt with a request it picked up (QR-011). */
export type QrRequestOutcome = 'RAISED' | 'REJECTED' | 'EXPIRED';

export type QrRequestTarget = 'RECEIVED' | 'ACKNOWLEDGED' | 'DONE' | 'REJECTED' | 'EXPIRED';

/**
 * What the diner's page should say about a request, from the restaurant's own (TAB-004): waiter
 * notified while it is active or escalated, on the way once acknowledged, done once cancelled or
 * resolved.
 */
export function qrRequestStatusOf(
  outcome: QrRequestOutcome,
  state: 'ACTIVE' | 'ESCALATED' | 'ACKNOWLEDGED' | 'CANCELLED' | 'RESOLVED' | null,
): QrRequestTarget {
  if (outcome === 'EXPIRED') return 'EXPIRED';
  if (outcome === 'REJECTED' || state === null) return 'REJECTED';
  if (state === 'ACKNOWLEDGED') return 'ACKNOWLEDGED';
  if (state === 'CANCELLED' || state === 'RESOLVED') return 'DONE';
  return 'RECEIVED';
}

const LADDER = ['SUBMITTED', 'RECEIVED', 'ACKNOWLEDGED', 'DONE'] as const;

/** The steps the relay accepts from what it was last told to `target`; it never goes back. */
export function qrRequestSteps(
  pushed: 'SUBMITTED' | QrRequestTarget | null,
  target: QrRequestTarget,
): QrRequestTarget[] {
  const from = pushed ?? 'SUBMITTED';
  if (from === 'DONE' || from === 'REJECTED' || from === 'EXPIRED') return [];
  if (target === 'EXPIRED') return from === 'SUBMITTED' ? ['EXPIRED'] : [];
  if (target === 'REJECTED') return from === 'ACKNOWLEDGED' ? [] : ['REJECTED'];
  const at = LADDER.indexOf(from);
  const to = LADDER.indexOf(target);
  return LADDER.slice(at + 1, to + 1) as QrRequestTarget[];
}
