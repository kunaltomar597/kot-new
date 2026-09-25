import { DomainError } from './errors.js';

/**
 * An amount of money in paise (1 rupee = 100 paise).
 *
 * Money is always a safe integer and never a floating-point rupee value (BRD §9.4).
 * Negative values are allowed only where stated (for example a round-off adjustment).
 */
export type Paise = number;

/**
 * A rate in basis points: 1 % = 100 bp, 2.5 % = 250 bp, 100 % = 10 000 bp.
 * Rates are integers so percentage maths stays exact.
 */
export type BasisPoints = number;

export const BASIS_POINTS_PER_WHOLE = 10_000;
export const PAISE_PER_RUPEE = 100;

/**
 * How a fractional result is turned into whole paise.
 * - HALF_UP: nearest, ties away from zero (the usual commercial rounding).
 * - HALF_EVEN: nearest, ties to the even neighbour (banker's rounding).
 * - DOWN: towards zero (truncate).
 * - UP: away from zero.
 */
export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP';

export const DEFAULT_ROUNDING: RoundingMode = 'HALF_UP';

export function isPaise(value: unknown): value is Paise {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Throws unless `value` is a safe integer amount. Set `allowNegative` for adjustments. */
export function assertPaise(value: number, label = 'amount', allowNegative = false): void {
  if (!Number.isSafeInteger(value)) {
    throw new DomainError('INVALID_AMOUNT', `${label} must be an integer number of paise`, {
      label,
      value,
    });
  }
  if (!allowNegative && value < 0) {
    throw new DomainError('INVALID_AMOUNT', `${label} must not be negative`, { label, value });
  }
}

/** Throws unless `value` is a non-negative integer rate in basis points (optionally capped). */
export function assertBasisPoints(value: number, label = 'rate', max?: BasisPoints): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError(
      'INVALID_RATE',
      `${label} must be a non-negative integer (basis points)`,
      {
        label,
        value,
      },
    );
  }
  if (max !== undefined && value > max) {
    throw new DomainError('INVALID_RATE', `${label} must not exceed ${max} basis points`, {
      label,
      value,
      max,
    });
  }
}

function assertSafeProduct(value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new DomainError('INVALID_AMOUNT', 'Intermediate amount exceeds the safe integer range', {
      value,
    });
  }
}

/**
 * Exact integer division with explicit rounding. Both inputs must be safe integers and
 * the denominator must be positive.
 */
export function divideRounded(
  numerator: number,
  denominator: number,
  mode: RoundingMode = DEFAULT_ROUNDING,
): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'divideRounded needs safe integers and a positive denominator',
      {
        numerator,
        denominator,
      },
    );
  }
  const sign = numerator < 0 ? -1 : 1;
  const absolute = Math.abs(numerator);
  const remainder = absolute % denominator;
  const quotient = (absolute - remainder) / denominator;
  if (remainder === 0) return sign * quotient;

  let roundAway: boolean;
  switch (mode) {
    case 'DOWN':
      roundAway = false;
      break;
    case 'UP':
      roundAway = true;
      break;
    case 'HALF_UP':
      roundAway = remainder * 2 >= denominator;
      break;
    case 'HALF_EVEN': {
      const twice = remainder * 2;
      roundAway = twice > denominator || (twice === denominator && quotient % 2 === 1);
      break;
    }
  }
  return sign * (roundAway ? quotient + 1 : quotient);
}

/** `amount × rate`, rounded to whole paise. */
export function applyRate(
  amount: Paise,
  rateBp: BasisPoints,
  mode: RoundingMode = DEFAULT_ROUNDING,
): Paise {
  assertPaise(amount, 'amount', true);
  assertBasisPoints(rateBp);
  const product = amount * rateBp;
  assertSafeProduct(product);
  return divideRounded(product, BASIS_POINTS_PER_WHOLE, mode);
}

/** Multiplies a unit amount by an integer quantity, guarding against overflow. */
export function multiply(amount: Paise, quantity: number): Paise {
  assertPaise(amount, 'amount', true);
  if (!Number.isSafeInteger(quantity)) {
    throw new DomainError('INVALID_QUANTITY', 'quantity must be an integer', { quantity });
  }
  const product = amount * quantity;
  assertSafeProduct(product);
  return product;
}

export function sum(amounts: readonly Paise[]): Paise {
  let total = 0;
  for (const amount of amounts) {
    assertPaise(amount, 'amount', true);
    total += amount;
  }
  assertSafeProduct(total);
  return total;
}

/**
 * Splits `amount` into parts proportional to `weights` so the parts always add up to
 * exactly `amount` (largest-remainder method; ties go to the earlier index).
 *
 * Used to spread a bill-level discount over lines, split inclusive tax over components,
 * and split bills into equal parts (BILL-007).
 */
export function allocate(amount: Paise, weights: readonly number[]): Paise[] {
  assertPaise(amount);
  if (weights.length === 0) {
    if (amount === 0) return [];
    throw new DomainError('INVALID_ARGUMENT', 'Cannot allocate a non-zero amount over no weights');
  }
  let totalWeight = 0;
  for (const weight of weights) {
    if (!Number.isSafeInteger(weight) || weight < 0) {
      throw new DomainError('INVALID_ARGUMENT', 'Weights must be non-negative integers', {
        weight,
      });
    }
    totalWeight += weight;
  }
  assertSafeProduct(totalWeight);
  if (totalWeight === 0) {
    if (amount === 0) return weights.map(() => 0);
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Cannot allocate a non-zero amount when all weights are zero',
    );
  }

  const parts: Paise[] = [];
  const remainders: { index: number; remainder: number }[] = [];
  let allocated = 0;
  weights.forEach((weight, index) => {
    const product = amount * weight;
    assertSafeProduct(product);
    const remainder = product % totalWeight;
    const share = (product - remainder) / totalWeight;
    parts.push(share);
    remainders.push({ index, remainder });
    allocated += share;
  });

  let leftover = amount - allocated;
  remainders.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const entry of remainders) {
    if (leftover === 0) break;
    if (entry.remainder === 0) continue;
    parts[entry.index] = (parts[entry.index] ?? 0) + 1;
    leftover -= 1;
  }
  return parts;
}

/** Splits `amount` into `parts` near-equal shares that add up exactly (earlier shares get the extra paise). */
export function splitEvenly(amount: Paise, parts: number): Paise[] {
  if (!Number.isSafeInteger(parts) || parts < 1) {
    throw new DomainError('INVALID_ARGUMENT', 'parts must be a positive integer', { parts });
  }
  return allocate(amount, new Array<number>(parts).fill(1));
}

/** Rounds `amount` to the nearest multiple of `unit` paise (e.g. 100 = nearest rupee). */
export function roundToUnit(
  amount: Paise,
  unit: Paise,
  mode: RoundingMode = DEFAULT_ROUNDING,
): Paise {
  assertPaise(amount, 'amount', true);
  if (!Number.isSafeInteger(unit) || unit <= 0) {
    throw new DomainError('INVALID_ARGUMENT', 'unit must be a positive integer', { unit });
  }
  return divideRounded(amount, unit, mode) * unit;
}

const RUPEE_PATTERN = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parses a rupee string ("250", "250.5", "1,23,456.78") into paise.
 * Rejects more than two decimal places rather than silently rounding.
 */
export function parseRupees(input: string, options: { allowNegative?: boolean } = {}): Paise {
  const cleaned = input.trim().replace(/[₹,\s]/g, '');
  const match = RUPEE_PATTERN.exec(cleaned);
  if (!match) {
    throw new DomainError('INVALID_AMOUNT', `"${input}" is not a valid rupee amount`, { input });
  }
  const [, minus, whole = '0', fraction = ''] = match;
  const paise = Number(whole) * PAISE_PER_RUPEE + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(paise)) {
    throw new DomainError('INVALID_AMOUNT', `"${input}" is too large`, { input });
  }
  if (minus && !options.allowNegative) {
    throw new DomainError('INVALID_AMOUNT', 'Negative amounts are not allowed here', { input });
  }
  return minus ? -paise : paise;
}

/** Groups digits the Indian way: 1,00,00,000 (NFR-L03). */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const lastThree = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${lastThree}`;
}

/**
 * Formats paise as Indian rupees: "₹1,23,456.78" (NFR-L03).
 * Implemented without Intl so output is identical on every runtime (server, browser, Hermes).
 */
export function formatRupees(amount: Paise, options: { symbol?: boolean } = {}): string {
  assertPaise(amount, 'amount', true);
  const { symbol = true } = options;
  const negative = amount < 0;
  const absolute = Math.abs(amount);
  const rupees = Math.trunc(absolute / PAISE_PER_RUPEE);
  const paise = absolute % PAISE_PER_RUPEE;
  const text = `${groupIndian(String(rupees))}.${String(paise).padStart(2, '0')}`;
  return `${negative ? '-' : ''}${symbol ? '₹' : ''}${text}`;
}
