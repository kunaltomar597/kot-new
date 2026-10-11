import { actorGrant } from '@rp/domain';
import type { Principal } from '../auth/principal.js';
import type { SettingsSnapshot } from '../settings/settings.service.js';

/** Whether the person prints bills by their role: the POS roles (BRD §4.2). */
export function printsBills(principal: Principal): boolean {
  return (
    actorGrant(
      { role: principal.role, extraCapabilities: principal.capabilities },
      'BILL_PRINT_AND_PAYMENT',
    ) !== 'DENY'
  );
}

/**
 * Whether the person may print a table's bill: by their role, or, for those who may ask for the
 * bill (waiters), when the restaurant allows them to print it from the app (WTR-008).
 */
export function mayPrintBill(principal: Principal, settings: SettingsSnapshot): boolean {
  return printsBills(principal) || settings.get('bills.waiterMayPrint');
}
