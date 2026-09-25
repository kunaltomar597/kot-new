import { DomainError } from './errors.js';
import {
  allocate,
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

/**
 * One tax inside a tax group, e.g. CGST 2.5 %. Codes are free text because rates and
 * component names are set by the restaurant's CA, never hard-coded (BILL-004).
 */
export interface TaxComponent {
  readonly code: string;
  readonly rateBp: BasisPoints;
}

/** A named set of tax components, e.g. "GST 5 %" = CGST 2.5 % + SGST 2.5 % (ONB-004 step 2). */
export interface TaxGroup {
  readonly id: string;
  readonly name: string;
  readonly components: readonly TaxComponent[];
}

/** Whether menu prices already include tax (BILL-004, configurable per restaurant). */
export type PriceMode = 'TAX_EXCLUSIVE' | 'TAX_INCLUSIVE';

export interface TaxComponentAmount {
  readonly code: string;
  readonly rateBp: BasisPoints;
  readonly amount: Paise;
}

export interface GroupTaxResult {
  /** Value on which tax is charged (after discounts, before tax). */
  readonly taxableValue: Paise;
  readonly components: readonly TaxComponentAmount[];
  readonly taxTotal: Paise;
  /** taxableValue + taxTotal. */
  readonly grossTotal: Paise;
}

export function totalRateBp(group: TaxGroup): BasisPoints {
  return group.components.reduce((total, component) => total + component.rateBp, 0);
}

/** Returns a list of problems with a tax group definition (empty when valid). */
export function validateTaxGroup(group: TaxGroup): string[] {
  const problems: string[] = [];
  if (group.id.trim() === '') problems.push('Tax group id is required');
  if (group.name.trim() === '') problems.push('Tax group name is required');
  const seen = new Set<string>();
  for (const component of group.components) {
    if (component.code.trim() === '') problems.push('Tax component code is required');
    if (seen.has(component.code)) problems.push(`Duplicate tax component code "${component.code}"`);
    seen.add(component.code);
    if (!Number.isSafeInteger(component.rateBp) || component.rateBp < 0) {
      problems.push(`Tax component "${component.code}" must have a non-negative integer rate`);
    } else if (component.rateBp > BASIS_POINTS_PER_WHOLE) {
      problems.push(`Tax component "${component.code}" rate must not exceed 100 %`);
    }
  }
  return problems;
}

export function assertValidTaxGroup(group: TaxGroup): void {
  const problems = validateTaxGroup(group);
  if (problems.length > 0) {
    throw new DomainError('INVALID_TAX_GROUP', problems.join('; '), {
      groupId: group.id,
      problems,
    });
  }
}

/**
 * Computes tax for an amount that belongs to one tax group.
 *
 * - TAX_EXCLUSIVE: `amount` is the taxable value; each component is rounded separately and
 *   added on top.
 * - TAX_INCLUSIVE: `amount` already contains tax. The taxable value is backed out once
 *   (`amount × 10000 / (10000 + total rate)`), and the tax is the difference, split over the
 *   components in proportion to their rates so the parts add up exactly to `amount`.
 *
 * Billing calls this once per tax group on the group's aggregate amount (see ADR-0003), which
 * keeps the invoice tax summary exact and avoids per-line rounding drift.
 */
export function computeGroupTax(
  amount: Paise,
  group: TaxGroup,
  priceMode: PriceMode,
  rounding: RoundingMode = DEFAULT_ROUNDING,
): GroupTaxResult {
  assertPaise(amount);
  assertValidTaxGroup(group);
  for (const component of group.components) assertBasisPoints(component.rateBp, component.code);

  if (priceMode === 'TAX_EXCLUSIVE') {
    const components = group.components.map((component) => ({
      code: component.code,
      rateBp: component.rateBp,
      amount: applyRate(amount, component.rateBp, rounding),
    }));
    const taxTotal = components.reduce((total, component) => total + component.amount, 0);
    return { taxableValue: amount, components, taxTotal, grossTotal: amount + taxTotal };
  }

  const rate = totalRateBp(group);
  const taxableValue =
    rate === 0
      ? amount
      : divideRounded(amount * BASIS_POINTS_PER_WHOLE, BASIS_POINTS_PER_WHOLE + rate, rounding);
  const taxTotal = amount - taxableValue;
  const shares =
    rate === 0
      ? group.components.map(() => 0)
      : allocate(
          taxTotal,
          group.components.map((component) => component.rateBp),
        );
  const components = group.components.map((component, index) => ({
    code: component.code,
    rateBp: component.rateBp,
    amount: shares[index] ?? 0,
  }));
  return { taxableValue, components, taxTotal, grossTotal: amount };
}
