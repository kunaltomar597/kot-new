import type { ServiceRequestView } from '@rp/contracts';
import { isOpenServiceRequest, SERVICE_REQUEST_TYPES, type ServiceRequestType } from '@rp/domain';

/** The cabin-call buttons in the order the tablet shows them (TAB-004). */
export const REQUEST_BUTTONS: readonly ServiceRequestType[] = SERVICE_REQUEST_TYPES;

/**
 * What a request button shows (TAB-004): its plain label while nothing is open; "Requested, waiter
 * notified" with the minutes since while it waits; "Waiter is on the way" once acknowledged.
 */
export type RequestButtonState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'requested'; readonly minutes: number }
  | { readonly kind: 'onTheWay'; readonly name: string | null };

/** The table's open requests, oldest first. */
export function openRequests(requests: readonly ServiceRequestView[]): ServiceRequestView[] {
  return requests
    .filter((request) => isOpenServiceRequest(request.state))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function requestButtonState(
  type: ServiceRequestType,
  requests: readonly ServiceRequestView[],
  now: number,
): RequestButtonState {
  const open = openRequests(requests).find((request) => request.type === type);
  if (open === undefined) return { kind: 'idle' };
  if (open.state === 'ACKNOWLEDGED') return { kind: 'onTheWay', name: open.acknowledgedByName };
  const minutes = Math.max(0, Math.floor((now - Date.parse(open.createdAt)) / 60_000));
  return { kind: 'requested', minutes };
}

/**
 * What Cancel does (TAB-004): nothing with no open request, clears the only one at once, and asks
 * which with several.
 */
export function cancelPlan(
  requests: readonly ServiceRequestView[],
):
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly request: ServiceRequestView }
  | { readonly kind: 'choose'; readonly requests: readonly ServiceRequestView[] } {
  const open = openRequests(requests);
  const [only] = open;
  if (only === undefined) return { kind: 'none' };
  if (open.length === 1) return { kind: 'one', request: only };
  return { kind: 'choose', requests: open };
}
