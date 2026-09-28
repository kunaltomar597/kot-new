import { describe, expect, it } from 'vitest';
import {
  isLowBattery,
  lowBatteryLevelFor,
  pagerIsOffline,
  pagerLines,
  pagerMayPublish,
  pagerMaySubscribe,
  pagerTopic,
  pagerWarning,
  vibrationFor,
} from '../src/index.js';

describe('[PGR-001] [PGR-006] what the pager shows and how it buzzes', () => {
  it('fits text on two lines of twelve at word boundaries', () => {
    expect(pagerLines('T7 READY')).toEqual(['T7 READY', '']);
    expect(pagerLines('T5 NEW ORDER')).toEqual(['T5 NEW ORDER', '']);
    expect(pagerLines('MGR: Come to counter')).toEqual(['MGR: Come to', 'counter']);
    expect(pagerLines('T12 FOOD WAITING NOW PLEASE')).toEqual(['T12 FOOD', 'WAITING NOW']);
    expect(pagerLines('Supercalifragilistic')).toEqual(['Supercalifra', '']);
    expect(pagerLines('')).toEqual(['', '']);
  });

  it('vibrates per type, three times when escalated, and follows the restaurant’s choice', () => {
    expect(vibrationFor('ITEM_READY', false)).toBe('ONE_LONG');
    expect(vibrationFor('WATER_REQUEST', false)).toBe('TWO_SHORT');
    expect(vibrationFor('MANAGER_NUDGE', false)).toBe('THREE');
    expect(vibrationFor('ITEM_READY', true)).toBe('THREE');
    expect(vibrationFor('ITEM_READY', false, { ITEM_READY: 'ONE_SHORT' })).toBe('ONE_SHORT');
  });
});

describe('[PGR-005] [SEC-012] topics', () => {
  const [r, a, b] = ['r1', 'pager-a', 'pager-b'];
  it('lets a pager read only its own alerts and write only its own ack and heartbeat', () => {
    expect(pagerTopic(r, a, 'alerts')).toBe('rp/r1/pagers/pager-a/alerts');
    expect(pagerMaySubscribe(pagerTopic(r, a, 'alerts'), r, a)).toBe(true);
    for (const topic of [pagerTopic(r, b, 'alerts'), 'rp/r1/pagers/+/alerts', 'rp/#', '#']) {
      expect(pagerMaySubscribe(topic, r, a)).toBe(false);
    }
    expect(pagerMayPublish(pagerTopic(r, a, 'ack'), r, a)).toBe(true);
    expect(pagerMayPublish(pagerTopic(r, a, 'heartbeat'), r, a)).toBe(true);
    expect(pagerMayPublish(pagerTopic(r, a, 'alerts'), r, a)).toBe(false);
    expect(pagerMayPublish(pagerTopic(r, b, 'ack'), r, a)).toBe(false);
  });

  it('[MGR-006] lets a pager hear a manager looking for it, and only for itself', () => {
    expect(pagerTopic(r, a, 'locate')).toBe('rp/r1/pagers/pager-a/locate');
    expect(pagerMaySubscribe(pagerTopic(r, a, 'locate'), r, a)).toBe(true);
    expect(pagerMaySubscribe(pagerTopic(r, b, 'locate'), r, a)).toBe(false);
    expect(pagerMaySubscribe('rp/r1/pagers/+/locate', r, a)).toBe(false);
    expect(pagerMayPublish(pagerTopic(r, a, 'locate'), r, a)).toBe(false);
  });
});

describe('[PGR-007] offline after three missed heartbeats', () => {
  it('counts from the last heartbeat', () => {
    const now = new Date('2026-09-26T12:00:00Z');
    const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
    expect(pagerIsOffline(ago(90), now, 30)).toBe(false);
    expect(pagerIsOffline(ago(91), now, 30)).toBe(true);
    expect(pagerIsOffline(null, now, 30)).toBe(true);
  });
});

describe('[WTR-014] [PGR-013] what the wearer is warned about', () => {
  it('warns about a pager that is not connected first, then about a low battery', () => {
    expect(pagerWarning({ online: false, batteryPercent: 10 }, 15)).toBe('OFFLINE');
    expect(pagerWarning({ online: true, batteryPercent: 15 }, 15)).toBe('LOW_BATTERY');
    expect(pagerWarning({ online: true, batteryPercent: 16 }, 15)).toBeUndefined();
    expect(pagerWarning({ online: true, batteryPercent: null }, 15)).toBeUndefined();
    expect(isLowBattery(null, 15)).toBe(false);
  });

  it('[TAB-015] [MGR-006] uses the pagers’ own low level for pagers and the shared one for others', () => {
    const levels = { pager: 15, other: 20 };
    expect(lowBatteryLevelFor('PAGER', levels)).toBe(15);
    expect(lowBatteryLevelFor('TABLE_TABLET', levels)).toBe(20);
    expect(lowBatteryLevelFor('KDS', levels)).toBe(20);
  });
});
