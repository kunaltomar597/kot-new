import { describe, expect, it } from 'vitest';
import {
  addMonths,
  billingLicenceState,
  billingPeriod,
  daysBetween,
  overdueStage,
} from '../src/subscription-billing.js';

describe('[VCP-003] billing periods', () => {
  it('adds months, keeping to the month’s last day', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-10-15', 3)).toBe('2027-01-15');
    expect(addMonths('2026-10-01', 12)).toBe('2027-10-01');
    expect(billingPeriod('2026-10-01', 1)).toEqual({ start: '2026-10-01', end: '2026-10-31' });
    expect(billingPeriod('2026-10-15', 3)).toEqual({ start: '2026-10-15', end: '2027-01-14' });
    expect(daysBetween('2026-10-01', '2026-10-15')).toBe(14);
    expect(daysBetween('2026-10-15', '2026-10-01')).toBe(-14);
  });
});

describe('[LIC-005] [VCP-003] what overdue invoices do to a licence', () => {
  it('finds the stage from the oldest unpaid invoice', () => {
    expect(overdueStage(undefined, '2026-10-20', 15)).toBe('NONE');
    expect(overdueStage('2026-10-20', '2026-10-20', 15)).toBe('NONE');
    expect(overdueStage('2026-10-01', '2026-10-16', 15)).toBe('DUE');
    expect(overdueStage('2026-10-01', '2026-10-17', 15)).toBe('GRACE');
  });

  it('moves along payment due, grace and restricted, and back once paid', () => {
    const next = (
      current: Parameters<typeof billingLicenceState>[0]['current'],
      stage: 'NONE' | 'DUE' | 'GRACE',
      setByBilling = true,
      graceOver = false,
    ) => billingLicenceState({ current, setByBilling, stage, graceOver });
    expect(next('ACTIVE', 'DUE', false)).toBe('PAYMENT_DUE');
    expect(next('ACTIVE', 'GRACE', false)).toBe('GRACE');
    expect(next('PAYMENT_DUE', 'DUE')).toBeUndefined();
    expect(next('PAYMENT_DUE', 'GRACE')).toBe('GRACE');
    expect(next('GRACE', 'GRACE')).toBeUndefined();
    expect(next('GRACE', 'GRACE', true, true)).toBe('RESTRICTED');
    expect(next('RESTRICTED', 'GRACE')).toBeUndefined();
    // The oldest invoice paid, a newer one just past due: back through active to payment due.
    expect(next('RESTRICTED', 'DUE')).toBe('ACTIVE');
    expect(next('GRACE', 'DUE')).toBe('ACTIVE');
    expect(next('ACTIVE', 'DUE')).toBe('PAYMENT_DUE');
    // Paid: back to active, but only from what billing did.
    expect(next('RESTRICTED', 'NONE')).toBe('ACTIVE');
    expect(next('GRACE', 'NONE', false)).toBeUndefined();
    expect(next('RESTRICTED', 'GRACE', false)).toBeUndefined();
    expect(next('ACTIVE', 'NONE')).toBeUndefined();
    expect(next('TERMINATED', 'NONE')).toBeUndefined();
    expect(next('TERMINATED', 'GRACE')).toBeUndefined();
  });
});
