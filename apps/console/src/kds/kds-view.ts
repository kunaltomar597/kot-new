import type { KdsSettings, KdsTicket, KdsTicketLine } from '@rp/contracts';
import type { OrderItemState } from '@rp/domain';

/** How old a ticket looks (KDS-004): always shown with an icon and the minutes, not colour alone. */
export type AgeTone = 'fresh' | 'amber' | 'red';

/** Whole minutes between two instants, never negative. */
export function minutesBetween(from: string, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(from)) / 60_000));
}

export function ageTone(minutes: number, settings: KdsSettings): AgeTone {
  if (minutes >= settings.ageRedMinutes) return 'red';
  if (minutes >= settings.ageAmberMinutes) return 'amber';
  return 'fresh';
}

/** The next kitchen step for an item, or none when the kitchen is done with it (KDS-005/007). */
export type KitchenStep = 'START_PREPARING' | 'MARK_READY' | 'PICK_UP';

export function nextStep(state: OrderItemState): KitchenStep | undefined {
  switch (state) {
    case 'SENT':
      return 'START_PREPARING';
    case 'PREPARING':
      return 'MARK_READY';
    case 'READY':
      return 'PICK_UP';
    default:
      return undefined;
  }
}

/** Lines under their combo (KDS-003): standalone lines on their own, combo parts together. */
export interface LineGroup {
  readonly comboName: string | null;
  readonly lines: readonly KdsTicketLine[];
}

export function groupLines(lines: readonly KdsTicketLine[]): LineGroup[] {
  const groups: { comboName: string | null; lines: KdsTicketLine[] }[] = [];
  for (const line of lines) {
    const last = groups.at(-1);
    if (line.comboName !== null && last?.comboName === line.comboName) last.lines.push(line);
    else groups.push({ comboName: line.comboName, lines: [line] });
  }
  return groups;
}

/** A new ticket can be bumped once nothing on it is waiting or cooking; slips any time. */
export function canBump(ticket: KdsTicket): boolean {
  if (ticket.kind !== 'NEW') return true;
  return ticket.lines.every((line) => line.state !== 'SENT' && line.state !== 'PREPARING');
}

/** The ticket-wide step: everything waiting starts, else everything cooking is ready. */
export function ticketStep(ticket: KdsTicket): 'START_PREPARING' | 'MARK_READY' | undefined {
  if (ticket.kind !== 'NEW') return undefined;
  if (ticket.lines.some((line) => line.state === 'SENT')) return 'START_PREPARING';
  if (ticket.lines.some((line) => line.state === 'PREPARING')) return 'MARK_READY';
  return undefined;
}

/** The items a ticket-wide step moves. */
export function linesFor(ticket: KdsTicket, step: 'START_PREPARING' | 'MARK_READY') {
  const from: OrderItemState = step === 'START_PREPARING' ? 'SENT' : 'PREPARING';
  return ticket.lines.filter((line) => line.state === from);
}

/**
 * Ready items waiting at the pass longer than the setting (KDS-006): the ticket flashes and
 * offers "Notify manager".
 */
export function notCollected(ticket: KdsTicket, nowMs: number, settings: KdsSettings): boolean {
  return ticket.lines.some(
    (line) =>
      line.state === 'READY' &&
      line.readyAt !== null &&
      minutesBetween(line.readyAt, nowMs) >= settings.readyNotCollectedMinutes,
  );
}

/** KDS-010 (S): how many of each dish are still to cook across the open tickets. */
export function allDaySummary(tickets: readonly KdsTicket[]): { name: string; quantity: number }[] {
  const totals = new Map<string, number>();
  for (const ticket of tickets) {
    if (ticket.kind !== 'NEW') continue;
    for (const line of ticket.lines) {
      if (line.state !== 'SENT' && line.state !== 'PREPARING') continue;
      const name = line.variantName === null ? line.name : `${line.name} (${line.variantName})`;
      totals.set(name, (totals.get(name) ?? 0) + line.quantity);
    }
  }
  return [...totals]
    .map(([name, quantity]) => ({ name, quantity }))
    .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name));
}

/**
 * Tickets the screen had not seen before (neither open nor recently bumped), split into new
 * tickets and change or cancellation slips, for the chime and the distinct sound (KDS-009). The
 * first read makes no sound.
 */
export function arrivals(
  knownIds: ReadonlySet<string> | undefined,
  tickets: readonly KdsTicket[],
): { newTickets: number; changes: number } {
  if (knownIds === undefined) return { newTickets: 0, changes: 0 };
  const fresh = tickets.filter((ticket) => !knownIds.has(ticket.kotId));
  return {
    newTickets: fresh.filter((ticket) => ticket.kind === 'NEW').length,
    changes: fresh.filter((ticket) => ticket.kind !== 'NEW').length,
  };
}
