import { describe, expect, it } from 'vitest';
import { alertsForMe, arrivals, groupAlerts, groupOf } from '../src/alerts/alert-view.js';
import {
  alertView,
  billForCashier,
  diskForOwner,
  escalatedFood,
  kitchenFlag,
  minutesAgo,
  nudgeToRavi,
  waterForRavi,
} from './alerts-fixture.js';
import { STAFF } from './fakes.js';

const MANAGER = STAFF.MANAGER.staffId;
const CASHIER = STAFF.CASHIER.staffId;

describe('[MGR-008] the alert centre’s groups', () => {
  it('puts what asks for the person first, then escalations, kitchen, tables, staff and system', () => {
    const escalatedForOthers = alertView(9, {
      escalatedAt: minutesAgo(1),
      escalatedTo: [STAFF.OWNER.staffId],
      recipientIds: [STAFF.WAITER.staffId, STAFF.OWNER.staffId],
    });
    const groups = groupAlerts(
      [diskForOwner, nudgeToRavi, waterForRavi, kitchenFlag, escalatedForOthers, escalatedFood],
      MANAGER,
    );
    expect(groups.map(({ group, alerts }) => [group, alerts.map((alert) => alert.id)])).toEqual([
      ['mine', [escalatedFood.id, kitchenFlag.id]],
      ['escalated', [escalatedForOthers.id]],
      ['tables', [waterForRavi.id]],
      ['staff', [nudgeToRavi.id]],
      ['system', [diskForOwner.id]],
    ]);
  });

  it('files the kitchen’s flag under the kitchen for someone it does not ask', () => {
    expect(groupOf(kitchenFlag, MANAGER)).toBe('mine');
    expect(groupOf(kitchenFlag, STAFF.OWNER.staffId)).toBe('kitchen');
    expect(groupOf(billForCashier, CASHIER)).toBe('mine');
    expect(groupOf(billForCashier, MANAGER)).toBe('tables');
  });

  it('[NTF-005] shows escalations first in a group, then the one that has waited longest', () => {
    const forCashier = { recipientIds: [CASHIER], channels: ['POS'] };
    const older = alertView(10, { ...forCashier, createdAt: minutesAgo(9) });
    const newer = alertView(11, { ...forCashier, createdAt: minutesAgo(1) });
    const escalated = alertView(12, {
      ...forCashier,
      createdAt: minutesAgo(0),
      escalatedAt: minutesAgo(0),
    });
    const groups = groupAlerts([newer, escalated, older], CASHIER);
    expect(groups.map(({ group }) => group)).toEqual(['mine']);
    expect(groups[0]?.alerts.map((alert) => alert.id)).toEqual([escalated.id, older.id, newer.id]);
  });

  it('counts only the alerts that ask for the person', () => {
    expect(alertsForMe([kitchenFlag, escalatedFood, waterForRavi], MANAGER)).toEqual([
      kitchenFlag,
      escalatedFood,
    ]);
    expect(alertsForMe([kitchenFlag, billForCashier], CASHIER)).toEqual([billForCashier]);
  });
});

describe('[MGR-008] [NTF-005] what pops up', () => {
  it('announces nothing on the first read', () => {
    const first = arrivals(undefined, [kitchenFlag, escalatedFood], MANAGER);
    expect(first.announce).toEqual([]);
    expect([...first.seen]).toEqual([
      [kitchenFlag.id, false],
      [escalatedFood.id, true],
    ]);
  });

  it('announces a new alert for the person and an escalation to them, once', () => {
    const food = alertView(20);
    const first = arrivals(undefined, [food, waterForRavi], MANAGER);
    const escalated = {
      ...food,
      escalatedAt: minutesAgo(0),
      escalatedTo: [MANAGER],
      recipientIds: [...food.recipientIds, MANAGER],
    };
    const second = arrivals(first.seen, [escalated, waterForRavi, kitchenFlag], MANAGER);
    expect(second.announce).toEqual([escalated, kitchenFlag]);
    const third = arrivals(second.seen, [escalated, waterForRavi, kitchenFlag], MANAGER);
    expect(third.announce).toEqual([]);
  });

  it('keeps quiet about alerts that do not ask for the person', () => {
    const first = arrivals(undefined, [], MANAGER);
    expect(
      arrivals(first.seen, [waterForRavi, nudgeToRavi, diskForOwner], MANAGER).announce,
    ).toEqual([]);
  });
});
