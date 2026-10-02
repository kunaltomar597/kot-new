import { describe, expect, it } from 'vitest';
import { licenceChangeOf, licenceDraftOf, licenceTargets } from '../src/tenants/licence-change.js';
import { tenantRequestOf } from '../src/tenants/TenantForm.js';
import { searchTenants } from '../src/tenants/TenantsScreen.js';
import { licence, tenantDetail } from './fixtures.js';

describe('the licence form', () => {
  it('[LIC-005] offers only the states the licence rules allow, the current one first', () => {
    expect(licenceTargets('ACTIVE')).toEqual([
      'ACTIVE',
      'PAYMENT_DUE',
      'GRACE',
      'RESTRICTED',
      'TERMINATED',
    ]);
    expect(licenceTargets('RESTRICTED')).toEqual(['RESTRICTED', 'ACTIVE', 'TERMINATED']);
    expect(licenceTargets('TERMINATED')).toEqual(['TERMINATED']);
  });

  it('[VCP-003] asks for nothing when nothing changed, and for only what changed', () => {
    const current = licence();
    const draft = licenceDraftOf(current);
    expect(licenceChangeOf(current, { ...draft, reason: 'Nothing' })).toBeUndefined();
    expect(
      licenceChangeOf(current, {
        ...draft,
        plan: ' Premium ',
        graceDays: '10',
        reason: ' Upgrade ',
      }),
    ).toEqual({ plan: 'Premium', graceDays: 10, reason: 'Upgrade' });
    expect(licenceChangeOf(current, { ...draft, validityDays: '1.5', reason: 'x' })).toMatchObject({
      validityDays: Number.NaN,
    });
  });
});

describe('the restaurant form and list', () => {
  const draft = {
    name: ' Dosa Corner ',
    legalName: '',
    gstin: '27aapfu0939f1zv',
    stateCode: '',
    contactName: 'Meera',
    contactEmail: ' MEERA@Example.com ',
    contactPhone: '',
  };

  it('[VCP-002] [BILL-002] treats empty fields as none and takes the state from the GSTIN', () => {
    const parsed = tenantRequestOf(draft);
    expect(parsed.success && parsed.data).toEqual({
      name: 'Dosa Corner',
      legalName: null,
      gstin: '27AAPFU0939F1ZV',
      stateCode: '27',
      contactName: 'Meera',
      contactEmail: 'meera@example.com',
      contactPhone: null,
    });
    const typed = tenantRequestOf({ ...draft, stateCode: '29' });
    expect(typed.success && typed.data.stateCode).toBe('29');
    expect(tenantRequestOf({ ...draft, gstin: '27AAPFU0939F1ZX' }).success).toBe(false);
  });

  it('finds restaurants by any word of their name, GSTIN or contact', () => {
    const one = tenantDetail();
    const two = tenantDetail({ id: 'b', name: 'Dosa Corner', gstin: null, contactName: 'Meera' });
    expect(searchTenants([one, two], '').map((tenant) => tenant.name)).toEqual([
      'Spice Route',
      'Dosa Corner',
    ]);
    expect(searchTenants([one, two], 'dosa meera').map((tenant) => tenant.name)).toEqual([
      'Dosa Corner',
    ]);
    expect(searchTenants([one, two], '27AAPF').map((tenant) => tenant.name)).toEqual([
      'Spice Route',
    ]);
  });
});
