import type { NotificationEvent } from './notifications.js';

/**
 * Wrist pagers (P2-04, PGR-005 to PGR-008): the text a pager shows, how it vibrates, the MQTT
 * topics it may use and when the server counts it as offline. Pure; the server's broker applies it.
 */

/** PGR-001: at least 2 lines × 12 characters. */
export const PAGER_LINE_LENGTH = 12;

/** Splits text into the pager's two lines at word boundaries, cutting only a word longer than a line. */
export function pagerLines(text: string): [string, string] {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
  const lines: string[] = [''];
  for (const word of words) {
    const current = lines[lines.length - 1] ?? '';
    const joined = current === '' ? word : `${current} ${word}`;
    if (joined.length <= PAGER_LINE_LENGTH || current === '') {
      lines[lines.length - 1] = joined.slice(0, PAGER_LINE_LENGTH);
    } else if (lines.length < 2) {
      lines.push(word.slice(0, PAGER_LINE_LENGTH));
    } else {
      break;
    }
  }
  return [
    (lines[0] ?? '').slice(0, PAGER_LINE_LENGTH),
    (lines[1] ?? '').slice(0, PAGER_LINE_LENGTH),
  ];
}

/** PGR-006: a vibration pattern per alert type ⚙. */
export const VIBRATION_PATTERNS = ['ONE_LONG', 'TWO_SHORT', 'THREE', 'ONE_SHORT'] as const;
export type VibrationPattern = (typeof VIBRATION_PATTERNS)[number];

/** PGR-006 defaults: ready = one long, service request = two short, manager/escalation = three. */
export const DEFAULT_VIBRATION: Readonly<Record<NotificationEvent, VibrationPattern>> = {
  ORDER_PENDING_APPROVAL: 'TWO_SHORT',
  ITEM_READY: 'ONE_LONG',
  WATER_REQUEST: 'TWO_SHORT',
  WAITER_REQUEST: 'TWO_SHORT',
  BILL_REQUEST: 'TWO_SHORT',
  READY_NOT_COLLECTED: 'THREE',
  MANAGER_NUDGE: 'THREE',
  ORDER_CHANGED: 'ONE_SHORT',
  WAITER_UNREACHABLE: 'THREE',
  DEVICE_LOW_BATTERY_OR_OFFLINE: 'ONE_SHORT',
  PRINTER_OFFLINE: 'ONE_SHORT',
  DISK_OR_BACKUP: 'ONE_SHORT',
  LICENSE_STATE: 'ONE_SHORT',
};

/** An escalated alert always buzzes three times: it has come to the manager. */
export function vibrationFor(
  event: NotificationEvent,
  escalated: boolean,
  overrides: Readonly<Partial<Record<NotificationEvent, VibrationPattern>>> = {},
): VibrationPattern {
  if (escalated) return 'THREE';
  return overrides[event] ?? DEFAULT_VIBRATION[event];
}

export type PagerTopicKind = 'alerts' | 'ack' | 'heartbeat';

/**
 * Topics: `rp/<restaurant>/pagers/<device>/alerts` (server → pager, QoS 1),
 * `.../ack` and `.../heartbeat` (pager → server). Nothing else is allowed (PGR-005, SEC-012).
 */
export function pagerTopic(restaurantId: string, deviceId: string, kind: PagerTopicKind): string {
  return `rp/${restaurantId}/pagers/${deviceId}/${kind}`;
}

/** Which of its own topics a pager may use, and how. */
export function pagerMayPublish(topic: string, restaurantId: string, deviceId: string): boolean {
  return (
    topic === pagerTopic(restaurantId, deviceId, 'ack') ||
    topic === pagerTopic(restaurantId, deviceId, 'heartbeat')
  );
}

export function pagerMaySubscribe(topic: string, restaurantId: string, deviceId: string): boolean {
  return topic === pagerTopic(restaurantId, deviceId, 'alerts');
}

/** PGR-007: offline after 3 missed heartbeats. */
export function pagerIsOffline(
  lastSeenAt: Date | null,
  now: Date,
  heartbeatSeconds: number,
): boolean {
  if (lastSeenAt === null) return true;
  return now.getTime() - lastSeenAt.getTime() > 3 * heartbeatSeconds * 1000;
}
