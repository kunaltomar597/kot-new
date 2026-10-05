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
import { grantOf, type PermissionHolder, type Role } from './permissions.js';

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

/**
 * Per-role discount limit in basis points, e.g. `{ CASHIER: 1000 }` = cashier up to 10 % (BILL-005 ⚙).
 * A role without a limit of its own that may discount within a limit (a custom role on another
 * base role, AUTH-012) has the cashier's.
 */
export type DiscountLimits = Readonly<Partial<Record<Role, BasisPoints>>>;

export const DEFAULT_DISCOUNT_LIMITS: DiscountLimits = { CASHIER: 1000 };

export type DiscountDecision = 'ALLOWED' | 'REQUIRES_MANAGER_OVERRIDE' | 'DENIED';

/**
 * Applies the discount rules from §4.2 and BILL-005 to `holder`'s grants, a custom role's
 * changes included (AUTH-012):
 * - Owner and Manager (DISCOUNT_ABOVE_LIMIT allowed) may give any discount, including
 *   complimentary items.
 * - Cashier (DISCOUNT_WITHIN_LIMIT) may discount up to their limit; above it, or complimentary,
 *   needs a manager PIN (DISCOUNT_ABOVE_LIMIT by override).
 * - Waiter and Kitchen cannot discount.
 */
export function decideDiscount(
  holder: Role | PermissionHolder,
  requestedRateBp: BasisPoints,
  limits: DiscountLimits = DEFAULT_DISCOUNT_LIMITS,
): DiscountDecision {
  assertBasisPoints(requestedRateBp, 'requested discount', BASIS_POINTS_PER_WHOLE);
  const who: PermissionHolder = typeof holder === 'string' ? { role: holder } : holder;
  const aboveLimit = grantOf(who, 'DISCOUNT_ABOVE_LIMIT');
  if (aboveLimit === 'ALLOW') return 'ALLOWED';
  const limit = limits[who.role] ?? limits.CASHIER ?? 0;
  const complimentary = requestedRateBp >= BASIS_POINTS_PER_WHOLE;
  if (
    grantOf(who, 'DISCOUNT_WITHIN_LIMIT') === 'ALLOW' &&
    !complimentary &&
    requestedRateBp <= limit
  ) {
    return 'ALLOWED';
  }
  return aboveLimit === 'OVERRIDE' ? 'REQUIRES_MANAGER_OVERRIDE' : 'DENIED';
}
