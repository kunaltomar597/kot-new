import { z } from 'zod';
import { Id, Timestamp } from './common.js';

/**
 * Alerts from the notification engine (P2-03, NTF-001 to NTF-007): what a person must act on,
 * whom it went to, and its acknowledgement and escalation.
 */

export const NotificationEventType = z.enum([
  'ORDER_PENDING_APPROVAL',
  'ITEM_READY',
  'WATER_REQUEST',
  'WAITER_REQUEST',
  'BILL_REQUEST',
  'READY_NOT_COLLECTED',
  'MANAGER_NUDGE',
  'ORDER_CHANGED',
  'WAITER_UNREACHABLE',
  'DEVICE_LOW_BATTERY_OR_OFFLINE',
  'PRINTER_OFFLINE',
  'DISK_OR_BACKUP',
  'LICENSE_STATE',
]);
export type NotificationEventType = z.infer<typeof NotificationEventType>;

export const AlertView = z.object({
  id: Id,
  type: NotificationEventType,
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'CLEARED']),
  tableId: Id.nullable(),
  tableSessionId: Id.nullable(),
  orderId: Id.nullable(),
  pagerText: z.string().nullable(),
  /** Details for the screen, e.g. the items waiting. */
  payload: z.record(z.string(), z.unknown()),
  recipientIds: z.array(Id),
  channels: z.array(z.string()),
  repeatCount: z.int().nonnegative(),
  escalatedAt: Timestamp.nullable(),
  escalatedTo: z.array(Id),
  createdAt: Timestamp,
  acknowledgedAt: Timestamp.nullable(),
  acknowledgedById: Id.nullable(),
  clearedAt: Timestamp.nullable(),
});
export type AlertView = z.infer<typeof AlertView>;

/** Open alerts for the signed-in person; managers and the Owner see every open alert. */
export const AlertListResponse = z.object({ alerts: z.array(AlertView) });
export type AlertListResponse = z.infer<typeof AlertListResponse>;

export const AlertParams = z.strictObject({ alertId: Id });
export type AlertParams = z.infer<typeof AlertParams>;

/** NTF-008: a manager nudges one or more waiters with a preset or a short text for the pager. */
export const NudgeRequest = z.strictObject({
  staffIds: z.array(Id).min(1).max(20),
  message: z.string().trim().min(1).max(40),
});
export type NudgeRequest = z.infer<typeof NudgeRequest>;

export const NudgeResponse = z.object({ alertIds: z.array(Id) });
export type NudgeResponse = z.infer<typeof NudgeResponse>;

/** NTF-009: "On break" for the signed-in person; their alerts go to the managers meanwhile. */
export const BreakRequest = z.strictObject({ onBreak: z.boolean() });
export type BreakRequest = z.infer<typeof BreakRequest>;

export const BreakView = z.object({
  staffId: Id,
  onBreak: z.boolean(),
  since: Timestamp.nullable(),
});
export type BreakView = z.infer<typeof BreakView>;
