import { z } from 'zod';
import { NotificationEventType } from './alerts.js';
import { Id, Timestamp } from './common.js';

/**
 * Wrist pagers over MQTT (P2-04, PGR-005 to PGR-008, PGR-012, SEC-012): the messages on the
 * broker and the manager's pager administration. Topics: `rp/<restaurant>/pagers/<device>/alerts`
 * (server → pager, QoS 1), `.../ack` and `.../heartbeat` (pager → server).
 */

export const VibrationPattern = z.enum(['ONE_LONG', 'TWO_SHORT', 'THREE', 'ONE_SHORT']);
export type VibrationPattern = z.infer<typeof VibrationPattern>;

/**
 * Server → pager (QoS 1). The pager shows each `alertId` once and buzzes again only for a higher
 * `seq` (a repeat); `ACKNOWLEDGED` or `CLEARED` removes it from the queue (PGR-006, PGR-008).
 */
export const PagerAlertMessage = z.object({
  alertId: Id,
  seq: z.int().nonnegative(),
  state: z.enum(['ALERT', 'ACKNOWLEDGED', 'CLEARED']),
  type: NotificationEventType,
  lines: z.tuple([z.string().max(12), z.string().max(12)]),
  vibration: VibrationPattern,
  sentAt: Timestamp,
});
export type PagerAlertMessage = z.infer<typeof PagerAlertMessage>;

/** Pager → server: the wearer pressed the button on this alert (NTF-004). */
export const PagerAckMessage = z.strictObject({ alertId: Id });
export type PagerAckMessage = z.infer<typeof PagerAckMessage>;

/** Pager → server every 30 s ⚙ (PGR-007). */
export const PagerHeartbeat = z.strictObject({
  battery: z.int().min(0).max(100),
  rssi: z.int().min(-127).max(0),
  firmware: z.string().min(1).max(32),
});
export type PagerHeartbeat = z.infer<typeof PagerHeartbeat>;

/** PGR-012: register a pager from its serial (the QR on its back) and optionally assign it. */
export const CreatePagerRequest = z.strictObject({
  serial: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{4,32}$/),
  name: z.string().trim().min(1).max(60),
  staffId: Id.nullable(),
});
export type CreatePagerRequest = z.infer<typeof CreatePagerRequest>;

/** What is written into the pager when it is set up; the password is shown only now. */
export const PagerCredentialResponse = z.object({
  deviceId: Id,
  mqttUsername: z.string(),
  mqttPassword: z.string(),
  alertsTopic: z.string(),
  ackTopic: z.string(),
  heartbeatTopic: z.string(),
  mqttPort: z.int().positive(),
});
export type PagerCredentialResponse = z.infer<typeof PagerCredentialResponse>;

/** PGR-012, PGR-014: give the pager to a waiter or a manager, or take it back (null). */
export const AssignPagerRequest = z.strictObject({ staffId: Id.nullable() });
export type AssignPagerRequest = z.infer<typeof AssignPagerRequest>;

export const PagerParams = z.strictObject({ deviceId: Id });
export type PagerParams = z.infer<typeof PagerParams>;

export const PagerView = z.object({
  deviceId: Id,
  name: z.string(),
  serial: z.string().nullable(),
  staffId: Id.nullable(),
  online: z.boolean(),
  batteryPercent: z.int().nullable(),
  rssi: z.int().nullable(),
  firmwareVersion: z.string().nullable(),
  lastSeenAt: Timestamp.nullable(),
});
export type PagerView = z.infer<typeof PagerView>;

export const PagerListResponse = z.object({ pagers: z.array(PagerView) });
export type PagerListResponse = z.infer<typeof PagerListResponse>;
