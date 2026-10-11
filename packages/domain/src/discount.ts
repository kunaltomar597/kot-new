import { DomainError } from './errors.js';
import {
  applyRate,
  assertBasisPoints,
  assertPaise,
  BASIS_POINTS_PER_WHOLE,
  DEFAULT_ROUNDING,
  divideRounded,
  type BasisPoints,
  type Paise,
  type RoundingMode,
} from './money.js';
import type { Role } from './permissions.js';

/** An item-level or bill-level discount: a percentage or a flat amount (BILL-005). */
export type DiscountValue =
  | { readonly kind: 'PERCENT'; readonly rateBp: BasisPoints }
  | { readonly kind: 'FLAT'; readonly amount: Paise };

/** Discount in paise for a base amount. Never more than the base. */
export function discountAmount(
  base: Paise,
  discount: DiscountValue,
  rounding: RoundingMode = DEFAULT_ROUNDING,
): Paise {
  assertPaise(base, 'discount base');
  if (discount.kind === 'PERCENT') {
    assertBasisPoints(discount.rateBp, 'discount rate', BASIS_POINTS_PER_WHOLE);
    return applyRate(base, discount.rateBp, rounding);
  }
  assertPaise(discount.amount, 'discount amount');
  if (discount.amount > base) {
    throw new DomainError(
      'DISCOUNT_EXCEEDS_AMOUNT',
      'A flat discount cannot exceed the amount it applies to',
      {
        base,
        discount: discount.amount,
      },
    );
  }
  return discount.amount;
}

/**
 * The discount expressed as a percentage of its base, rounded UP so a flat discount can
 * never slip under a role's percentage limit through rounding.
 */
export function effectiveDiscountRateBp(base: Paise, discount: DiscountValue): BasisPoints {
  if (discount.kind === 'PERCENT') return discount.rateBp;
  if (base === 0) return discount.amount === 0 ? 0 : BASIS_POINTS_PER_WHOLE;
  return divideRounded(discountAmount(base, discount) * BASIS_POINTS_PER_WHOLE, base, 'UP');
}

/** Per-role discount limit in basis points, e.g. `{ CASHIER: 1000 }` = cashier up to 10 % (BILL-005 ⚙). */
export type DiscountLimits = Readonly<Partial<Record<Role, BasisPoints>>>;

export const DEFAULT_DISCOUNT_LIMITS: DiscountLimits = { CASHIER: 1000 };

export type DiscountDecision = 'ALLOWED' | 'REQUIRES_MANAGER_OVERRIDE' | 'DENIED';

/**
 * Applies the discount rules from §4.2 and BILL-005:
 * - Owner and Manager may give any discount, including complimentary items.
 * - Cashier may discount up to their limit; above it, or complimentary, needs a manager PIN.
 * - Waiter and Kitchen cannot discount.
 */
export function decideDiscount(
  role: Role,
  requestedRateBp: BasisPoints,
  limits: DiscountLimits = DEFAULT_DISCOUNT_LIMITS,
): DiscountDecision {
  assertBasisPoints(requestedRateBp, 'requested discount', BASIS_POINTS_PER_WHOLE);
  switch (role) {
    case 'OWNER':
    case 'MANAGER':
      return 'ALLOWED';
    case 'CASHIER': {
      const limit = limits.CASHIER ?? 0;
      const complimentary = requestedRateBp >= BASIS_POINTS_PER_WHOLE;
      return !complimentary && requestedRateBp <= limit ? 'ALLOWED' : 'REQUIRES_MANAGER_OVERRIDE';
    }
    case 'WAITER':
    case 'KITCHEN':
      return 'DENIED';
  }
}
