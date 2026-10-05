import { describe, expect, it } from 'vitest';
import { homeFor, isStationMode, modeOfPath, modesFor } from '../src/app/modes.js';
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

  it('[AUTH-012] follows a custom role', () => {
    const headCashier = {
      role: 'CASHIER',
      customRole: { added: ['STAFF_MANAGE'], removed: [] },
    } as const;
    // The dashboard opens for its Staff page, but a cashier still starts at the POS.
    expect(modesFor(headCashier)).toEqual(['pos', 'manage']);
    expect(homeFor(headCashier)).toBe('pos');
    const expediter = {
      role: 'MANAGER',
      customRole: { added: [], removed: ['ORDER_CREATE'] },
    } as const;
    expect(modesFor(expediter)).toEqual(['kds', 'manage']);
    expect(homeFor(expediter)).toBe('manage');
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
