import {
  effectiveRule,
  type NotificationEvent,
  type NotificationRuleOverrides,
  type VibrationPattern,
} from './notifications.js';

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

/**
 * How a pager buzzes for an alert (PGR-006): the event's rule says, a restaurant's change included;
 * an escalated alert always buzzes three times, since it has come to the manager.
 */
export function vibrationFor(
  event: NotificationEvent,
  escalated: boolean,
  rules: NotificationRuleOverrides = {},
): VibrationPattern {
  if (escalated) return 'THREE';
  return effectiveRule(event, rules).vibration;
}

export type PagerTopicKind = 'alerts' | 'locate' | 'ack' | 'heartbeat';

/**
 * Topics: `rp/<restaurant>/pagers/<device>/alerts` (server → pager, QoS 1), `.../locate` (server →
 * pager, a manager looking for it, P4-02c), `.../ack` and `.../heartbeat` (pager → server). Nothing
 * else is allowed (PGR-005, SEC-012).
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
  return (
    topic === pagerTopic(restaurantId, deviceId, 'alerts') ||
    topic === pagerTopic(restaurantId, deviceId, 'locate')
  );
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

/** PGR-013: at or below the level ⚙ the battery counts as low. */
export function isLowBattery(batteryPercent: number | null, lowBatteryPercent: number): boolean {
  return batteryPercent !== null && batteryPercent <= lowBatteryPercent;
}

/**
 * The low-battery level ⚙ of a device type: pagers have their own (`pager.lowBatteryPercent`,
 * PGR-013); tablets and every other device share `devices.lowBatteryAlertPercent` (TAB-015).
 */
export function lowBatteryLevelFor(
  deviceType: string,
  levels: { readonly pager: number; readonly other: number },
): number {
  return deviceType === 'PAGER' ? levels.pager : levels.other;
}

/**
 * What the waiter app warns its wearer about (WTR-014): a pager that is not connected, else a low
 * battery. Not connected comes first: alerts then reach only the phone (NTF-007).
 */
export function pagerWarning(
  pager: { readonly online: boolean; readonly batteryPercent: number | null },
  lowBatteryPercent: number,
): 'OFFLINE' | 'LOW_BATTERY' | undefined {
  if (!pager.online) return 'OFFLINE';
  if (isLowBattery(pager.batteryPercent, lowBatteryPercent)) return 'LOW_BATTERY';
  return undefined;
}
