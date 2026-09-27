import type { AlertView } from '@rp/contracts';
import { RESTAURANT_ID, STAFF } from './fakes.js';

/** Alerts for the alert centre's tests (P2-06c). */

const uuid = (n: number) => `0199a0e0-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const NOW = '2026-09-27T10:00:00.000Z';
export const minutesAgo = (minutes: number) =>
  new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

export function alertView(n: number, overrides: Partial<AlertView> = {}): AlertView {
  return {
    id: uuid(700 + n),
    type: 'ITEM_READY',
    status: 'OPEN',
    tableId: uuid(800 + n),
    tableLabel: '5',
    tableSessionId: null,
    orderId: null,
    pagerText: 'T5 READY',
    payload: { items: ['Paneer Tikka'] },
    raisedByName: null,
    recipientIds: [STAFF.WAITER.staffId],
    channels: ['PAGER', 'WAITER_APP', 'TABLET'],
    repeatCount: 0,
    escalatedAt: null,
    escalatedTo: [],
    createdAt: minutesAgo(2),
    acknowledgedAt: null,
    acknowledgedById: null,
    clearedAt: null,
    ...overrides,
  };
}

/** The kitchen's "Notify manager" (KDS-006): for the managers on duty, on the POS and dashboard. */
export const kitchenFlag = alertView(1, {
  type: 'READY_NOT_COLLECTED',
  tableLabel: '4',
  pagerText: 'T4 FOOD WAITING',
  payload: { kotNumber: 12, items: ['Dal Makhani'] },
  recipientIds: [STAFF.MANAGER.staffId],
  channels: ['POS', 'DASHBOARD', 'PAGER'],
  createdAt: minutesAgo(3),
});

/** Ravi's food, not picked up in time: escalated to the manager (NTF-005). */
export const escalatedFood = alertView(2, {
  recipientIds: [STAFF.WAITER.staffId, STAFF.MANAGER.staffId],
  escalatedTo: [STAFF.MANAGER.staffId],
  escalatedAt: minutesAgo(1),
  repeatCount: 2,
  createdAt: minutesAgo(2),
});

/** Water for Ravi's table: his to answer; a manager only looks over it. */
export const waterForRavi = alertView(3, {
  type: 'WATER_REQUEST',
  tableLabel: '7',
  pagerText: 'T7 WATER',
  payload: {},
  channels: ['PAGER', 'WAITER_APP'],
  createdAt: minutesAgo(1),
});

/** A manager's nudge to Ravi (NTF-008). */
export const nudgeToRavi = alertView(4, {
  type: 'MANAGER_NUDGE',
  tableId: null,
  tableLabel: null,
  pagerText: 'MGR: Come to counter',
  payload: { message: 'Come to counter' },
  raisedByName: STAFF.MANAGER.displayName,
  channels: ['PAGER', 'WAITER_APP'],
  createdAt: minutesAgo(4),
});

/** The disk is filling up: for the Owner. */
export const diskForOwner = alertView(5, {
  type: 'DISK_OR_BACKUP',
  tableId: null,
  tableLabel: null,
  pagerText: null,
  payload: {},
  recipientIds: [STAFF.OWNER.staffId],
  channels: ['POS', 'DASHBOARD', 'CONTROL_PLANE'],
  createdAt: minutesAgo(30),
});

/** A bill asked for at table 7: for the cashier on the POS. */
export const billForCashier = alertView(6, {
  type: 'BILL_REQUEST',
  tableLabel: '7',
  pagerText: 'T7 BILL',
  payload: { requestedFrom: 'TABLE_TABLET' },
  recipientIds: [STAFF.WAITER.staffId, STAFF.CASHIER.staffId],
  channels: ['PAGER', 'WAITER_APP', 'POS'],
  createdAt: minutesAgo(0),
});

/** The live connection's message for an alert event. */
export function alertEvent(
  sequence: number,
  type: 'AlertRaised' | 'AlertAcknowledged' | 'AlertEscalated',
  alert: AlertView,
) {
  const base = {
    eventId: uuid(900 + sequence),
    version: 1,
    occurredAt: NOW,
    restaurantId: RESTAURANT_ID,
    businessDate: '2026-09-27',
  };
  if (type === 'AlertRaised') {
    return {
      sequence,
      event: {
        ...base,
        type,
        payload: {
          alertId: alert.id,
          eventType: alert.type,
          recipients: alert.recipientIds,
          pagerText: alert.pagerText,
          tableId: alert.tableId,
          repeat: alert.repeatCount,
          escalated: alert.escalatedAt !== null,
        },
      },
    };
  }
  if (type === 'AlertEscalated') {
    return {
      sequence,
      event: {
        ...base,
        type,
        payload: { alertId: alert.id, eventType: alert.type, escalatedTo: alert.escalatedTo },
      },
    };
  }
  return {
    sequence,
    event: {
      ...base,
      type,
      payload: { alertId: alert.id, acknowledgedBy: null, recipients: alert.recipientIds },
    },
  };
}
