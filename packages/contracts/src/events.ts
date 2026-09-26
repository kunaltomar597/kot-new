import { z } from 'zod';
import {
  DeviceType,
  Id,
  IsoDate,
  OrderItemState,
  OrderSource,
  Paise,
  ServiceRequestType,
  TableState,
  Timestamp,
} from './common.js';

/**
 * Domain event catalogue (INT-004). Events are how modules talk to each other and how the server
 * pushes live updates (Socket.io to apps, MQTT to pagers, outbox to the cloud). Every event has a
 * version so consumers can support N-1 (UPD-006).
 */

function event<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({
    eventId: z.uuid(),
    type: z.literal(type),
    version: z.literal(1),
    occurredAt: Timestamp,
    restaurantId: Id,
    businessDate: IsoDate,
    /** Correlates logs across devices, server and cloud (NFR-O01). */
    correlationId: z.string().max(64).optional(),
    payload,
  });
}

export const MenuPublished = event('MenuPublished', z.object({ menuVersion: z.int().positive() }));
export const ItemAvailabilityChanged = event(
  'ItemAvailabilityChanged',
  z.object({ itemId: Id, available: z.boolean(), stockCount: z.int().nonnegative().nullable() }),
);

export const TableOpened = event(
  'TableOpened',
  z.object({ tableId: Id, tableSessionId: Id, covers: z.int().positive(), waiterId: Id }),
);
export const TableMoved = event(
  'TableMoved',
  z.object({ tableSessionId: Id, fromTableId: Id, toTableId: Id }),
);
export const TableClosed = event('TableClosed', z.object({ tableId: Id, tableSessionId: Id }));
export const TableStateChanged = event(
  'TableStateChanged',
  z.object({ tableId: Id, state: TableState }),
);

export const OrderSubmitted = event(
  'OrderSubmitted',
  z.object({
    orderId: Id,
    orderNumber: z.int().positive(),
    source: OrderSource,
    tableSessionId: Id.optional(),
    needsApproval: z.boolean(),
  }),
);
export const OrderApproved = event('OrderApproved', z.object({ orderId: Id, approvedBy: Id }));
export const OrderRejected = event(
  'OrderRejected',
  z.object({ orderId: Id, rejectedBy: Id, reason: z.string().min(1).max(200) }),
);
export const KotCreated = event(
  'KotCreated',
  z.object({
    kotId: Id,
    kotNumber: z.int().positive(),
    stationId: Id,
    orderId: Id,
    kind: z.enum(['NEW', 'MODIFIED', 'CANCELLED']),
  }),
);
export const ItemStatusChanged = event(
  'ItemStatusChanged',
  z.object({
    orderId: Id,
    orderItemId: Id,
    from: OrderItemState,
    to: OrderItemState,
    actorId: Id.optional(),
    deviceId: Id.optional(),
  }),
);

export const ServiceRequestRaised = event(
  'ServiceRequestRaised',
  z.object({ serviceRequestId: Id, tableId: Id, type: ServiceRequestType }),
);
export const ServiceRequestAcknowledged = event(
  'ServiceRequestAcknowledged',
  z.object({ serviceRequestId: Id, acknowledgedBy: Id }),
);
export const ServiceRequestCancelled = event(
  'ServiceRequestCancelled',
  z.object({ serviceRequestId: Id, resolution: z.enum(['CANCELLED', 'RESOLVED']) }),
);

export const BillRequested = event(
  'BillRequested',
  z.object({
    tableSessionId: Id,
    requestedFrom: z.enum(['TABLE_TABLET', 'WAITER_APP', 'QR', 'POS']),
  }),
);
export const BillPrinted = event(
  'BillPrinted',
  z.object({
    invoiceId: Id,
    invoiceNumber: z.string().max(16),
    grandTotal: Paise,
    duplicate: z.boolean(),
  }),
);
export const BillSettled = event('BillSettled', z.object({ invoiceId: Id, grandTotal: Paise }));

export const AlertEscalated = event(
  'AlertEscalated',
  z.object({ alertId: Id, eventType: z.string(), escalatedTo: z.array(Id) }),
);
export const DeviceStatusChanged = event(
  'DeviceStatusChanged',
  z.object({
    deviceId: Id,
    deviceType: DeviceType,
    online: z.boolean(),
    batteryPercent: z.int().min(0).max(100).optional(),
  }),
);

/** A device was unpaired: its tokens stop working and its live connections close (AUTH-008). */
export const DeviceRevoked = event(
  'DeviceRevoked',
  z.object({ deviceId: Id, deviceType: DeviceType, reason: z.string().max(200) }),
);

/**
 * Settings changed (P1-01a, MGR-007, UPD-010). Only the keys: every screen may hear it, and each
 * reads the values it is allowed to see again.
 */
export const SettingsChanged = event(
  'SettingsChanged',
  z.object({ keys: z.array(z.string().max(80)).min(1) }),
);

/**
 * Part of the restaurant's setup changed (P1-01b): its profile, its invoice particulars, its tax
 * groups or its invoice series. Screens and bill templates read that part again.
 */
export const RestaurantChanged = event(
  'RestaurantChanged',
  z.object({ part: z.enum(['PROFILE', 'LEGAL', 'TAX_GROUPS', 'INVOICE_SERIES']) }),
);

export const DomainEvent = z.discriminatedUnion('type', [
  MenuPublished,
  ItemAvailabilityChanged,
  TableOpened,
  TableMoved,
  TableClosed,
  TableStateChanged,
  OrderSubmitted,
  OrderApproved,
  OrderRejected,
  KotCreated,
  ItemStatusChanged,
  ServiceRequestRaised,
  ServiceRequestAcknowledged,
  ServiceRequestCancelled,
  BillRequested,
  BillPrinted,
  BillSettled,
  AlertEscalated,
  DeviceStatusChanged,
  DeviceRevoked,
  SettingsChanged,
  RestaurantChanged,
]);
export type DomainEvent = z.infer<typeof DomainEvent>;
export type DomainEventType = DomainEvent['type'];
export type EventOfType<T extends DomainEventType> = Extract<DomainEvent, { type: T }>;

export const DOMAIN_EVENT_TYPES = DomainEvent.options.map((option) => option.shape.type.value);
