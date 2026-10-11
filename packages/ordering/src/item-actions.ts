import type { OrderView } from '@rp/contracts';
import {
  canTransition,
  type Capability,
  grantFor,
  type OrderItemEvent,
  orderItemMachine,
  type Role,
} from '@rp/domain';

type Line = OrderView['items'][number];

/** What a person may do with a sent line now (ORD-010, ORD-011, BRD §4.2). */
export interface LineActions {
  /** Mark it picked up from the pass (KDS-007). */
  readonly pickUp: boolean;
  /** Mark it served at the table (WTR-007). */
  readonly serve: boolean;
  /** Cancel it with a reason while the kitchen has not started it (ORD-011). */
  readonly cancel: boolean;
  /** Void it with a reason once the kitchen started it: outright, or with a manager's PIN. */
  readonly void: 'ALLOW' | 'OVERRIDE' | null;
}

const NONE: LineActions = { pickUp: false, serve: false, cancel: false, void: null };

/**
 * The steps a person may take on a line, from its own state (the server moves a combo line with
 * its parts) and their grants; `ownTable` says whether they are the table's waiter, for grants
 * held on their own tables only. Combo parts follow their combo and take no steps of their own.
 * The server checks again.
 */
export function lineActions(
  line: Pick<Line, 'state' | 'parentOrderItemId'>,
  role: Role,
  ownTable: boolean,
): LineActions {
  if (line.parentOrderItemId !== null) return NONE;
  const can = (event: OrderItemEvent) => canTransition(orderItemMachine, line.state, event);
  const may = (capability: Capability) => {
    const grant = grantFor(role, capability);
    return grant === 'ALLOW' || (grant === 'OWN' && ownTable);
  };
  const voiding = grantFor(role, 'ITEM_VOID_AFTER_PREP');
  return {
    pickUp: can('PICK_UP') && may('ITEM_MARK_PICKED_UP'),
    serve: can('SERVE') && may('ITEM_MARK_SERVED'),
    cancel: can('CANCEL') && may('ITEM_CANCEL_BEFORE_PREP'),
    void: can('VOID') && (voiding === 'ALLOW' || voiding === 'OVERRIDE') ? voiding : null,
  };
}

/** The lines of these orders the person may mark served now, in order (WTR-007). */
export function servableLines(orders: readonly OrderView[], role: Role, ownTable: boolean): Line[] {
  return orders.flatMap((order) =>
    order.items.filter((line) => lineActions(line, role, ownTable).serve),
  );
}
