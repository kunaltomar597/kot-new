import {
  BILLING_CYCLES,
  type BillingCycle,
  LICENCE_MODULES,
  type LicenceModule,
  PlanRequest,
  type PlanView,
} from '@rp/contracts/control-plane';
import { paiseOf, rupeeText } from '../app/format.js';
import { DEVICE_KINDS } from '../tenants/licence-change.js';

export interface PlanDraft {
  readonly code: string;
  readonly name: string;
  readonly prices: Readonly<Record<BillingCycle, string>>;
  readonly deviceLimits: Readonly<Record<(typeof DEVICE_KINDS)[number], string>>;
  readonly modules: readonly LicenceModule[];
}

export const EMPTY_PLAN: PlanDraft = {
  code: '',
  name: '',
  prices: { MONTHLY: '', QUARTERLY: '', YEARLY: '' },
  deviceLimits: { TABLE_TABLET: '10', PAGER: '5', WAITER_PHONE: '5', KDS: '2' },
  modules: [...LICENCE_MODULES],
};

export function planDraftOf(plan: PlanView): PlanDraft {
  const price = (value: number | null) => (value === null ? '' : rupeeText(value));
  return {
    code: plan.code,
    name: plan.name,
    prices: {
      MONTHLY: price(plan.prices.MONTHLY),
      QUARTERLY: price(plan.prices.QUARTERLY),
      YEARLY: price(plan.prices.YEARLY),
    },
    deviceLimits: {
      TABLE_TABLET: String(plan.deviceLimits.TABLE_TABLET),
      PAGER: String(plan.deviceLimits.PAGER),
      WAITER_PHONE: String(plan.deviceLimits.WAITER_PHONE),
      KDS: String(plan.deviceLimits.KDS),
    },
    modules: plan.modules,
  };
}

const whole = (text: string): number => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN);

/**
 * The form as a plan request: prices typed in rupees become paise (an empty price means the cycle
 * is not offered), limits whole numbers. A price that is not an amount is sent as -1, so the
 * contract refuses it with a message on that field.
 */
export function planRequestOf(draft: PlanDraft) {
  const price = (text: string) => (text.trim() === '' ? null : (paiseOf(text) ?? -1));
  return PlanRequest.safeParse({
    code: draft.code.trim().toUpperCase(),
    name: draft.name.trim(),
    prices: Object.fromEntries(BILLING_CYCLES.map((cycle) => [cycle, price(draft.prices[cycle])])),
    deviceLimits: Object.fromEntries(
      DEVICE_KINDS.map((kind) => [kind, whole(draft.deviceLimits[kind])]),
    ),
    modules: draft.modules,
  });
}
