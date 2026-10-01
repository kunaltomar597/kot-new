import { describe, expect, it } from 'vitest';
import { grantOf, homeFor, isStationMode, modeOfPath, modesFor } from '../src/app/modes.js';
import { deviceSummary } from './fakes.js';

describe('[MGR-001] [KDS-001] console modes by role (BRD §4.2)', () => {
  it('opens the modes the permission matrix allows', () => {
    expect(modesFor({ role: 'OWNER' })).toEqual(['pos', 'kds', 'manage']);
    expect(modesFor({ role: 'MANAGER' })).toEqual(['pos', 'kds', 'manage']);
    expect(modesFor({ role: 'CASHIER' })).toEqual(['pos']);
    expect(modesFor({ role: 'WAITER' })).toEqual(['pos']);
    expect(modesFor({ role: 'KITCHEN' })).toEqual(['kds']);
  });

  it('lands managers in Manage, the kitchen in the KDS and everyone else in the POS', () => {
    expect(homeFor({ role: 'OWNER' })).toBe('manage');
    expect(homeFor({ role: 'MANAGER' })).toBe('manage');
    expect(homeFor({ role: 'CASHIER' })).toBe('pos');
    expect(homeFor({ role: 'WAITER' })).toBe('pos');
    expect(homeFor({ role: 'KITCHEN' })).toBe('kds');
  });

  it('runs kitchen screens in station mode', () => {
    expect(isStationMode(deviceSummary({ type: 'KDS' }))).toBe(true);
    expect(isStationMode(deviceSummary())).toBe(false);
    expect(isStationMode(undefined)).toBe(false);
  });

  it('reads the mode from the path', () => {
    expect(modeOfPath('/kds/station')).toBe('kds');
    expect(modeOfPath('/manage')).toBe('manage');
    expect(modeOfPath('/login')).toBeUndefined();
  });
});

describe('[AUTH-012] a custom role opens what it adds', () => {
  it('opens the dashboard for a waiter whose custom role edits the menu', () => {
    expect(modesFor({ role: 'WAITER', capabilities: ['MENU_MANAGE'] })).toEqual(['pos', 'manage']);
    expect(modesFor({ role: 'CASHIER', capabilities: ['ITEM_MARK_PREPARING_READY'] })).toEqual([
      'pos',
      'kds',
    ]);
    expect(
      grantOf({ role: 'WAITER', capabilities: ['TABLE_MOVE_MERGE'] }, 'TABLE_MOVE_MERGE'),
    ).toBe('ALLOW');
    // Never more than the rules allow, whatever the list says.
    expect(grantOf({ role: 'WAITER', capabilities: ['DATA_ADMIN'] }, 'DATA_ADMIN')).toBe('DENY');
  });
});
