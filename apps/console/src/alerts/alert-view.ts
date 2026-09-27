import type { AlertView, NotificationEventType } from '@rp/contracts';
import { reachesConsole } from '@rp/domain';

/** The events after which the console reads the alerts again (P2-06c). */
export const ALERT_EVENTS: ReadonlySet<string> = new Set([
  'AlertRaised',
  'AlertAcknowledged',
  'AlertCleared',
  'AlertEscalated',
]);

/**
 * The alert centre's groups in the order they show (MGR-008): what asks for the person first, then
 * what managers watch over: escalations, the kitchen's flags, the tables, the staff, and the
 * devices and system.
 */
export const ALERT_GROUPS = ['mine', 'escalated', 'kitchen', 'tables', 'staff', 'system'] as const;
export type AlertGroup = (typeof ALERT_GROUPS)[number];

const GROUP_OF_TYPE: Readonly<
  Record<NotificationEventType, Exclude<AlertGroup, 'mine' | 'escalated'>>
> = {
  ORDER_PENDING_APPROVAL: 'tables',
  ITEM_READY: 'tables',
  WATER_REQUEST: 'tables',
  WAITER_REQUEST: 'tables',
  BILL_REQUEST: 'tables',
  READY_NOT_COLLECTED: 'kitchen',
  ORDER_CHANGED: 'kitchen',
  MANAGER_NUDGE: 'staff',
  WAITER_UNREACHABLE: 'staff',
  DEVICE_LOW_BATTERY_OR_OFFLINE: 'system',
  PRINTER_OFFLINE: 'system',
  DISK_OR_BACKUP: 'system',
  LICENSE_STATE: 'system',
};

export function groupOf(alert: AlertView, staffId: string): AlertGroup {
  if (reachesConsole(alert, staffId)) return 'mine';
  if (alert.escalatedAt !== null) return 'escalated';
  return GROUP_OF_TYPE[alert.type];
}

export interface AlertGroupView {
  readonly group: AlertGroup;
  readonly alerts: readonly AlertView[];
}

/** Escalated first, then the one that has waited longest. */
function byUrgency(a: AlertView, b: AlertView): number {
  const escalated = Number(b.escalatedAt !== null) - Number(a.escalatedAt !== null);
  return escalated !== 0 ? escalated : Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

/** The open alerts in their groups, leaving out empty groups. */
export function groupAlerts(alerts: readonly AlertView[], staffId: string): AlertGroupView[] {
  const grouped = new Map<AlertGroup, AlertView[]>();
  for (const alert of alerts) {
    const group = groupOf(alert, staffId);
    grouped.set(group, [...(grouped.get(group) ?? []), alert]);
  }
  return ALERT_GROUPS.flatMap((group) => {
    const members = grouped.get(group);
    return members === undefined ? [] : [{ group, alerts: members.sort(byUrgency) }];
  });
}

/** The alerts that ask for the person, for the number on the header button. */
export function alertsForMe(alerts: readonly AlertView[], staffId: string): AlertView[] {
  return alerts.filter((alert) => reachesConsole(alert, staffId));
}

export interface Arrivals {
  /** What to announce: new alerts for the person, and alerts escalated to them since. */
  readonly announce: readonly AlertView[];
  /** Every alert now open, with whether it was escalated to the person: `previous` next time. */
  readonly seen: ReadonlyMap<string, boolean>;
}

/**
 * What changed for the person between two reads of the alerts. The first read (no `previous`)
 * announces nothing: the header button shows what was already open.
 */
export function arrivals(
  previous: ReadonlyMap<string, boolean> | undefined,
  alerts: readonly AlertView[],
  staffId: string,
): Arrivals {
  const seen = new Map<string, boolean>();
  const announce: AlertView[] = [];
  for (const alert of alerts) {
    const escalatedToMe = alert.escalatedTo.includes(staffId);
    seen.set(alert.id, escalatedToMe);
    if (previous === undefined || !reachesConsole(alert, staffId)) continue;
    const before = previous.get(alert.id);
    if (before === undefined || (escalatedToMe && !before)) announce.push(alert);
  }
  return { announce, seen };
}
