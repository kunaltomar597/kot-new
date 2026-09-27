import type { MenuSnapshot, OrderView } from '@rp/contracts';
import type { OrderItemState } from '@rp/domain';
import type { Translator } from '@rp/i18n';

type Item = OrderView['items'][number];

/** How far along the kitchen and floor an item is; ended states are not steps. */
const PROGRESS: Partial<Record<OrderItemState, number>> = {
  PENDING_APPROVAL: 0,
  SENT: 1,
  PREPARING: 2,
  READY: 3,
  PICKED_UP: 4,
  SERVED: 5,
};

/**
 * The state to show for a line (ORD-010). The kitchen moves a combo's parts, which are what its
 * tickets list, so a combo line shows how far its parts that are still going have got, as the
 * server moves the line: in preparation once any part is started, then at its least advanced part
 * (ready when every part is ready). A line without parts shows its own state.
 */
export function displayState(item: Item, items: readonly Item[]): OrderItemState {
  const parts = items.filter(
    (part) => part.parentOrderItemId === item.id && PROGRESS[part.state] !== undefined,
  );
  if (parts.length === 0 || PROGRESS[item.state] === undefined) return item.state;
  const least = parts.reduce((first, part) =>
    (PROGRESS[part.state] ?? 0) < (PROGRESS[first.state] ?? 0) ? part : first,
  ).state;
  const started = parts.some((part) => (PROGRESS[part.state] ?? 0) > (PROGRESS.SENT ?? 0));
  return started && (PROGRESS[least] ?? 0) < (PROGRESS.PREPARING ?? 0) ? 'PREPARING' : least;
}

type Kot = OrderView['kots'][number];

/** Whether a kitchen ticket reached the kitchen (WTR-012), for the waiter who sent it. */
export interface KotDelivery {
  /** The ticket is on the station's kitchen screen. */
  readonly onScreen: boolean;
  /** Its printing, when the station prints tickets; null when it does not. */
  readonly print: 'PENDING' | 'PRINTED' | 'FAILED' | null;
  /** The kitchen has it: on a screen or on paper. */
  readonly reached: boolean;
}

/**
 * Where a ticket is: on the kitchen screen, printed, still printing, or held by a printer problem.
 * A station that shows tickets on a screen and also prints them has the ticket on its screen
 * whatever the printer does; a station missing from the menu counts as print-only.
 */
export function kotDelivery(kot: Kot, stations: MenuSnapshot['stations']): KotDelivery {
  const mode = stations.find((station) => station.id === kot.stationId)?.mode;
  const print = kot.printStatus === 'NOT_REQUIRED' ? null : kot.printStatus;
  const onScreen = print === null || mode === 'SCREEN' || mode === 'BOTH';
  return { onScreen, print, reached: onScreen || print === 'PRINTED' };
}

/** "On the kitchen screen · Printed", "Printing", "Not printed: printer problem". */
export function kotDeliveryText(delivery: KotDelivery, t: Translator): string {
  const parts: string[] = [];
  if (delivery.onScreen) parts.push(t('pos.kot.onScreen'));
  if (delivery.print === 'PENDING') parts.push(t('pos.kot.printing'));
  if (delivery.print === 'PRINTED') parts.push(t('pos.kot.printed'));
  if (delivery.print === 'FAILED') parts.push(t('pos.kot.failed'));
  return parts.join(' · ');
}
