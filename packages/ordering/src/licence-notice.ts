import type { LicenceView } from '@rp/contracts';
import { displayDateTime } from '@rp/domain';
import type { Translator } from '@rp/i18n';

export interface LicenceNotice {
  readonly tone: 'info' | 'warning' | 'danger';
  readonly message: string;
  /** The payment reminder can be put off until tomorrow; the others stay. */
  readonly dismissible: boolean;
}

/**
 * What staff screens say about the licence (LIC-005, LIC-008), the same on the POS, the dashboard,
 * the kitchen screens and the waiter app: a polite reminder when payment is due (the POS and the
 * dashboard only), a banner with the days left in grace or before a restriction, and a notice
 * while restricted. Nothing when active, or when the licence does not apply (development).
 */
export function licenceNotice(
  view: LicenceView,
  t: Translator,
  options: { readonly paymentReminder: boolean },
): LicenceNotice | undefined {
  if (!view.enforced) return undefined;
  if (view.state === 'TERMINATED') {
    return { tone: 'danger', message: t('licence.banner.terminated'), dismissible: false };
  }
  if (view.state === 'RESTRICTED') {
    return { tone: 'danger', message: t('licence.banner.restricted'), dismissible: false };
  }
  if (view.restrictedFrom !== null) {
    return {
      tone: 'warning',
      message: t('licence.banner.pending', displayDateTime(new Date(view.restrictedFrom))),
      dismissible: false,
    };
  }
  if (view.state === 'GRACE') {
    return {
      tone: 'warning',
      message: t('licence.banner.grace', { count: view.daysLeft ?? 0 }),
      dismissible: false,
    };
  }
  if (view.state === 'PAYMENT_DUE' && options.paymentReminder) {
    return { tone: 'info', message: t('licence.banner.paymentDue'), dismissible: true };
  }
  return undefined;
}

/** Screens read the licence again on these events. */
export function affectsLicence(eventType: string): boolean {
  return eventType === 'LicenceChanged';
}
