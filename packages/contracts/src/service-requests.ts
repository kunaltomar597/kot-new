import { z } from 'zod';
import { Id, ServiceRequestState, ServiceRequestType, Timestamp } from './common.js';

/**
 * Service requests (P2-06d, TAB-004, WTR-005): a diner's call for water, a waiter or the bill.
 * Like a flight-cabin call light it stays on until it is cancelled or resolved; its alert calls
 * the responsible waiter (and the cashier for the bill), repeats every R and escalates after N.
 */

/** Where a diner raised it: the table tablet, or the QR page later (QR-011). */
export const ServiceRequestSource = z.enum(['TABLE_TABLET', 'QR']);
export type ServiceRequestSource = z.infer<typeof ServiceRequestSource>;

export const ServiceRequestView = z.object({
  id: Id,
  type: ServiceRequestType,
  state: ServiceRequestState,
  source: ServiceRequestSource,
  /** Where the guests are now: the session's table, which a move changes. */
  tableId: Id,
  tableLabel: z.string(),
  tableSessionId: Id,
  createdAt: Timestamp,
  escalatedAt: Timestamp.nullable(),
  acknowledgedAt: Timestamp.nullable(),
  acknowledgedById: Id.nullable(),
  /** Who is on the way, for the inbox ("Ravi is on the way"). */
  acknowledgedByName: z.string().nullable(),
  /** When it was cancelled or resolved; null while open. */
  closedAt: Timestamp.nullable(),
});
export type ServiceRequestView = z.infer<typeof ServiceRequestView>;

/** The open requests of the restaurant, oldest first: the waiter's inbox (WTR-005). */
export const ServiceRequestListResponse = z.object({ requests: z.array(ServiceRequestView) });
export type ServiceRequestListResponse = z.infer<typeof ServiceRequestListResponse>;

export const ServiceRequestParams = z.strictObject({ requestId: Id });
export type ServiceRequestParams = z.infer<typeof ServiceRequestParams>;

/** A button on the table tablet (TAB-004). */
export const RaiseServiceRequest = z.strictObject({ type: ServiceRequestType });
export type RaiseServiceRequest = z.infer<typeof RaiseServiceRequest>;

/**
 * A table tablet's own requests (AUTH-009): those of the session open at its table, for "Requested,
 * waiter notified" with the time and "Waiter is on the way". No session: the table is not open.
 */
export const TableServiceRequestsResponse = z.object({
  tableSessionId: Id.nullable(),
  requests: z.array(ServiceRequestView),
});
export type TableServiceRequestsResponse = z.infer<typeof TableServiceRequestsResponse>;
