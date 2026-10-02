import {
  type DeviceLimits,
  type LicenceChangeRequest,
  type LicenceState,
  type VendorLicenceView,
} from '@rp/contracts/control-plane';
import { allowedEvents, licenseMachine, transition } from '@rp/domain';

export const DEVICE_KINDS = ['TABLE_TABLET', 'PAGER', 'WAITER_PHONE', 'KDS'] as const;

/** The states a licence may move to from `state` (LIC-005), the current one first. */
export function licenceTargets(state: LicenceState): LicenceState[] {
  const targets = allowedEvents(licenseMachine, state).map(
    (event) => transition(licenseMachine, state, event).to,
  );
  return [state, ...new Set(targets.filter((target) => target !== state))];
}

export interface LicenceDraft {
  readonly state: LicenceState;
  readonly plan: string;
  readonly deviceLimits: Readonly<Record<keyof DeviceLimits, string>>;
  readonly validityDays: string;
  readonly graceDays: string;
  readonly reason: string;
}

export function licenceDraftOf(licence: VendorLicenceView): LicenceDraft {
  return {
    state: licence.state,
    plan: licence.plan,
    deviceLimits: {
      TABLE_TABLET: String(licence.deviceLimits.TABLE_TABLET),
      PAGER: String(licence.deviceLimits.PAGER),
      WAITER_PHONE: String(licence.deviceLimits.WAITER_PHONE),
      KDS: String(licence.deviceLimits.KDS),
    },
    validityDays: String(licence.validityDays),
    graceDays: String(licence.graceDays),
    reason: '',
  };
}

const whole = (text: string): number => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN);

/**
 * Only what changed, with the reason (VCP-003): an unchanged form asks for nothing. Numbers that
 * are not whole are sent as they are and refused by the contract with a message per field.
 */
export function licenceChangeOf(
  licence: VendorLicenceView,
  draft: LicenceDraft,
): LicenceChangeRequest | undefined {
  const limits = {
    TABLE_TABLET: whole(draft.deviceLimits.TABLE_TABLET),
    PAGER: whole(draft.deviceLimits.PAGER),
    WAITER_PHONE: whole(draft.deviceLimits.WAITER_PHONE),
    KDS: whole(draft.deviceLimits.KDS),
  };
  const limitsChanged = DEVICE_KINDS.some((kind) => limits[kind] !== licence.deviceLimits[kind]);
  const validityDays = whole(draft.validityDays);
  const graceDays = whole(draft.graceDays);
  const plan = draft.plan.trim();
  const change: LicenceChangeRequest = {
    ...(draft.state !== licence.state && { state: draft.state }),
    ...(plan !== licence.plan && { plan }),
    ...(limitsChanged && { deviceLimits: limits }),
    ...(validityDays !== licence.validityDays && { validityDays }),
    ...(graceDays !== licence.graceDays && { graceDays }),
    reason: draft.reason.trim(),
  };
  return Object.keys(change).length === 1 ? undefined : change;
}
