import { defineStateMachine } from '../state-machine.js';

/** Diner service buttons on the table tablet (TAB-004) and QR page (QR-011). */
export const SERVICE_REQUEST_TYPES = ['WATER', 'WAITER', 'BILL'] as const;
export type ServiceRequestType = (typeof SERVICE_REQUEST_TYPES)[number];

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

export function isOpenServiceRequest(state: ServiceRequestState): boolean {
  return state === 'ACTIVE' || state === 'ESCALATED' || state === 'ACKNOWLEDGED';
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
