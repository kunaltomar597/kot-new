import type { LicenceView } from '@rp/contracts';
import { createTranslator } from '@rp/i18n';
import { describe, expect, it } from 'vitest';
import { affectsLicence, licenceNotice } from '../src/licence-notice.js';

const t = createTranslator();
const capabilities = {
  openNewTableSessions: true,
  createOrders: true,
  sendKots: true,
  billOpenTables: true,
  print: true,
  viewReports: true,
  exportData: true,
  backups: true,
  showPaymentReminder: false,
  showGraceBanner: false,
};
const view = (overrides: Partial<LicenceView>): LicenceView => ({
  state: 'ACTIVE',
  recorded: 'ACTIVE',
  problem: null,
  restrictedFrom: null,
  daysLeft: null,
  validUntil: null,
  enforced: true,
  capabilities,
  details: null,
  ...overrides,
});
const POS = { paymentReminder: true };

describe('[LIC-005] [LIC-008] what staff screens say about the licence', () => {
  it('says nothing when active, or where the licence does not apply', () => {
    expect(licenceNotice(view({}), t, POS)).toBeUndefined();
    expect(licenceNotice(view({ state: 'RESTRICTED', enforced: false }), t, POS)).toBeUndefined();
  });

  it('reminds politely of a payment due, on the POS and dashboard only', () => {
    const due = view({ state: 'PAYMENT_DUE', recorded: 'PAYMENT_DUE' });
    expect(licenceNotice(due, t, POS)).toEqual({
      tone: 'info',
      message: t('licence.banner.paymentDue'),
      dismissible: true,
    });
    expect(licenceNotice(due, t, { paymentReminder: false })).toBeUndefined();
  });

  it('counts the days of grace, says when a restriction starts, and when it applies', () => {
    expect(licenceNotice(view({ state: 'GRACE', daysLeft: 4 }), t, POS)?.message).toBe(
      t('licence.banner.grace', { count: 4 }),
    );
    const pending = licenceNotice(
      view({ state: 'GRACE', recorded: 'RESTRICTED', restrictedFrom: '2026-10-10T22:30:00.000Z' }),
      t,
      POS,
    );
    expect(pending).toMatchObject({ tone: 'warning', dismissible: false });
    expect(pending?.message).toContain('04:00');
    expect(licenceNotice(view({ state: 'RESTRICTED' }), t, POS)).toMatchObject({
      tone: 'danger',
      message: t('licence.banner.restricted'),
    });
    expect(licenceNotice(view({ state: 'TERMINATED' }), t, POS)?.message).toBe(
      t('licence.banner.terminated'),
    );
    expect(affectsLicence('LicenceChanged')).toBe(true);
    expect(affectsLicence('OrderSubmitted')).toBe(false);
  });
});
