import { describe, expect, it } from 'vitest';
import { homeFor, isStationMode, modeOfPath, modesFor } from '../src/app/modes.js';
import { deviceSummary } from './fakes.js';

describe('[MGR-001] [KDS-001] console modes by role (BRD §4.2)', () => {
  it('opens the modes the permission matrix allows', () => {
    expect(modesFor('OWNER')).toEqual(['pos', 'kds', 'manage']);
    expect(modesFor('MANAGER')).toEqual(['pos', 'kds', 'manage']);
    expect(modesFor('CASHIER')).toEqual(['pos']);
    expect(modesFor('WAITER')).toEqual(['pos']);
    expect(modesFor('KITCHEN')).toEqual(['kds']);
  });

  it('lands managers in Manage, the kitchen in the KDS and everyone else in the POS', () => {
    expect(homeFor('OWNER')).toBe('manage');
    expect(homeFor('MANAGER')).toBe('manage');
    expect(homeFor('CASHIER')).toBe('pos');
    expect(homeFor('WAITER')).toBe('pos');
    expect(homeFor('KITCHEN')).toBe('kds');
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
