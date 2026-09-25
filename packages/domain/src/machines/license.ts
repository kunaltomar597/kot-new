import {
  nextBusinessDayStart,
  type BusinessDayConfig,
  DEFAULT_BUSINESS_DAY,
} from '../business-date.js';
import { defineStateMachine } from '../state-machine.js';

export const LICENSE_STATES = [
  'ACTIVE',
  'PAYMENT_DUE',
  'GRACE',
  'RESTRICTED',
  'TERMINATED',
] as const;
export type LicenseState = (typeof LICENSE_STATES)[number];

export const LICENSE_EVENTS = [
  'INVOICE_OVERDUE',
  'START_GRACE',
  'GRACE_ENDED',
  'INVALIDATED',
  'PAYMENT_RECORDED',
  'VALID_LICENSE_RESTORED',
  'CONTRACT_ENDED',
] as const;
export type LicenseEvent = (typeof LICENSE_EVENTS)[number];

/**
 * Staged licence enforcement (BRD Appendix B, LIC-005). INVALIDATED covers: licence expired
 * while offline, missing/unsigned/tampered licence, or vendor suspension.
 */
export const licenseMachine = defineStateMachine<LicenseState, LicenseEvent>({
  name: 'License',
  states: LICENSE_STATES,
  terminal: ['TERMINATED'],
  transitions: [
    { event: 'INVOICE_OVERDUE', from: ['ACTIVE'], to: 'PAYMENT_DUE' },
    { event: 'START_GRACE', from: ['ACTIVE', 'PAYMENT_DUE'], to: 'GRACE' },
    { event: 'GRACE_ENDED', from: ['GRACE'], to: 'RESTRICTED' },
    { event: 'INVALIDATED', from: ['ACTIVE', 'PAYMENT_DUE', 'GRACE'], to: 'RESTRICTED' },
    { event: 'PAYMENT_RECORDED', from: ['PAYMENT_DUE', 'GRACE', 'RESTRICTED'], to: 'ACTIVE' },
    { event: 'VALID_LICENSE_RESTORED', from: ['RESTRICTED'], to: 'ACTIVE' },
    {
      event: 'CONTRACT_ENDED',
      from: ['ACTIVE', 'PAYMENT_DUE', 'GRACE', 'RESTRICTED'],
      to: 'TERMINATED',
    },
  ],
});

/** What the restaurant can do in each licence state (LIC-005 table). */
export interface LicenseCapabilities {
  readonly openNewTableSessions: boolean;
  readonly createOrders: boolean;
  readonly sendKots: boolean;
  /** Finish and bill tables that are already open. */
  readonly billOpenTables: boolean;
  readonly print: boolean;
  readonly viewReports: boolean;
  readonly exportData: boolean;
  readonly backups: boolean;
  readonly showPaymentReminder: boolean;
  readonly showGraceBanner: boolean;
}

const FULL: LicenseCapabilities = {
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

const RESTRICTED: LicenseCapabilities = {
  ...FULL,
  openNewTableSessions: false,
  createOrders: false,
  sendKots: false,
};

export function licenseCapabilities(state: LicenseState): LicenseCapabilities {
  switch (state) {
    case 'ACTIVE':
      return FULL;
    case 'PAYMENT_DUE':
      return { ...FULL, showPaymentReminder: true };
    case 'GRACE':
      return { ...FULL, showPaymentReminder: true, showGraceBanner: true };
    case 'RESTRICTED':
    case 'TERMINATED':
      // The platform never deletes, encrypts or withholds the restaurant's data.
      return RESTRICTED;
  }
}

/**
 * A move into RESTRICTED takes effect only at the start of the next business day, never
 * in the middle of service (LIC-005). Returns when a restriction decided at `decidedAt` applies.
 */
export function restrictionEffectiveAt(
  decidedAt: Date,
  config: BusinessDayConfig = DEFAULT_BUSINESS_DAY,
): Date {
  return nextBusinessDayStart(decidedAt, config);
}

/**
 * The state the restaurant actually experiences: a pending restriction is not applied until
 * its effective time has passed.
 */
export function effectiveLicenseState(
  recorded: LicenseState,
  previous: LicenseState,
  restrictionEffectiveFrom: Date | undefined,
  now: Date,
): LicenseState {
  if (
    (recorded === 'RESTRICTED' || recorded === 'TERMINATED') &&
    restrictionEffectiveFrom !== undefined
  ) {
    return now.getTime() >= restrictionEffectiveFrom.getTime() ? recorded : previous;
  }
  return recorded;
}
