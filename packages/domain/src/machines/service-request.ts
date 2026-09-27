import type { NotificationEvent } from '../notifications.js';
import { defineStateMachine } from '../state-machine.js';

/** Diner service buttons on the table tablet (TAB-004) and QR page (QR-011). */
export const SERVICE_REQUEST_TYPES = ['WATER', 'WAITER', 'BILL'] as const;
export type ServiceRequestType = (typeof SERVICE_REQUEST_TYPES)[number];

/**
 * The alert each request raises (NTF-003, BRD Appendix C): the responsible waiter's pager and app,
 * and for the bill the cashier too (BILL-015). It repeats every R and escalates after N.
 */
export const SERVICE_REQUEST_ALERTS: Readonly<Record<ServiceRequestType, NotificationEvent>> = {
  WATER: 'WATER_REQUEST',
  WAITER: 'WAITER_REQUEST',
  BILL: 'BILL_REQUEST',
};

export const SERVICE_REQUEST_STATES = [
  'ACTIVE',
  'ESCALATED',
  'ACKNOWLEDGED',
  'CANCELLED',
  'RESOLVED',
] as const;
export type ServiceRequestState = (typeof SERVICE_REQUEST_STATES)[number];

export const SERVICE_REQUEST_EVENTS = ['ESCALATE', 'ACKNOWLEDGE', 'CANCEL', 'RESOLVE'] as const;
export type ServiceRequestEvent = (typeof SERVICE_REQUEST_EVENTS)[number];

/**
 * Service request lifecycle (BRD Appendix B, TAB-004, NTF-004, NTF-005). Works like a flight
 * cabin call light: it stays active until cancelled or resolved.
 *
 * Pressing Cancel on the tablet maps to CANCEL while the request is ACTIVE/ESCALATED (the diner
 * no longer needs it) and to RESOLVE once ACKNOWLEDGED (the waiter arrived).
 */
export const serviceRequestMachine = defineStateMachine<ServiceRequestState, ServiceRequestEvent>({
  name: 'ServiceRequest',
  states: SERVICE_REQUEST_STATES,
  terminal: ['CANCELLED', 'RESOLVED'],
  transitions: [
    { event: 'ESCALATE', from: ['ACTIVE'], to: 'ESCALATED' },
    { event: 'ACKNOWLEDGE', from: ['ACTIVE', 'ESCALATED'], to: 'ACKNOWLEDGED' },
    { event: 'CANCEL', from: ['ACTIVE', 'ESCALATED'], to: 'CANCELLED' },
    { event: 'RESOLVE', from: ['ACKNOWLEDGED'], to: 'RESOLVED' },
  ],
});

/** The event a tablet Cancel press produces for a request in `state`. */
export function cancelButtonEvent(state: ServiceRequestState): ServiceRequestEvent | undefined {
  if (state === 'ACTIVE' || state === 'ESCALATED') return 'CANCEL';
  if (state === 'ACKNOWLEDGED') return 'RESOLVE';
  return undefined;
}

/**
 * The events Resolve in the waiter app produces (WTR-005): it clears the request like Cancel on the
 * tablet, but the waiter handled it, so one not yet acknowledged is acknowledged first (the time
 * counts for reports, NTF-004) and then resolved. A closed request needs nothing.
 */
export function resolveEvents(state: ServiceRequestState): ServiceRequestEvent[] {
  if (state === 'ACTIVE' || state === 'ESCALATED') return ['ACKNOWLEDGE', 'RESOLVE'];
  if (state === 'ACKNOWLEDGED') return ['RESOLVE'];
  return [];
}

/** A request that still shows on the tablet and in the waiter's inbox: not cancelled or resolved. */
export const OPEN_SERVICE_REQUEST_STATES = [
  'ACTIVE',
  'ESCALATED',
  'ACKNOWLEDGED',
] as const satisfies readonly ServiceRequestState[];

export function isOpenServiceRequest(state: ServiceRequestState): boolean {
  return (OPEN_SERVICE_REQUEST_STATES as readonly ServiceRequestState[]).includes(state);
}

/** Anti-spam: the same type cannot be raised again while one is open for the table (TAB-004). */
export function canRaiseServiceRequest(
  type: ServiceRequestType,
  openRequests: readonly {
    readonly type: ServiceRequestType;
    readonly state: ServiceRequestState;
  }[],
): boolean {
  return !openRequests.some(
    (request) => request.type === type && isOpenServiceRequest(request.state),
  );
}
