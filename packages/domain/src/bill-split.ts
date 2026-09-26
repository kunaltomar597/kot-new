import type { BillResult, TaxLineResult } from './bill.js';
import { DomainError } from './errors.js';
import { allocate, sum, type Paise } from './money.js';
import type { TaxComponentAmount } from './tax.js';

/** One line of a part: the line's share of each amount of the whole bill. */
export interface SplitLine {
  readonly lineId: string;
  /** The weight this part took of the line: a quantity when splitting by items. */
  readonly share: number;
  readonly grossAmount: Paise;
  /** Item discount plus bill-discount share. */
  readonly discount: Paise;
  readonly taxableValue: Paise;
  readonly taxGroupId: string;
}

export interface SplitTaxLine {
  readonly taxGroupId: string;
  readonly source: TaxLineResult['source'];
  readonly taxableValue: Paise;
  readonly components: readonly TaxComponentAmount[];
  readonly taxTotal: Paise;
}

/** One part of a split bill, with every amount its own invoice needs. */
export interface SplitPart {
  readonly lines: readonly SplitLine[];
  readonly taxLines: readonly SplitTaxLine[];
  readonly subtotal: Paise;
  readonly discountTotal: Paise;
  readonly serviceCharge: Paise;
  readonly taxTotal: Paise;
  readonly totalBeforeRoundOff: Paise;
  readonly roundOff: number;
  readonly grandTotal: Paise;
}

/** Allocates over weights, falling back to equal weights when they are all zero. */
function spread(amount: Paise, weights: readonly number[], fallback: readonly number[]): Paise[] {
  if (amount === 0) return weights.map(() => 0);
  const total = sum(weights);
  return allocate(amount, total > 0 ? weights : fallback);
}

/** Signed version of `spread`, for the round-off. */
function spreadSigned(
  amount: number,
  weights: readonly number[],
  fallback: readonly number[],
): number[] {
  const parts = spread(Math.abs(amount), weights, fallback);
  return amount < 0 ? parts.map((part) => -part) : parts;
}

/**
 * Splits a computed bill into parts (BILL-007) so that every amount of the parts adds up exactly
 * to the whole bill: gross, discounts, taxable values, each tax component, the service charge and
 * the round-off. Each part can then be its own GST invoice.
 *
 * `shares[p][i]` is part `p`'s weight of bill line `i`: the quantity it takes when splitting by
 * items, or 1 each when splitting into equal parts. Every line must be fully taken, and every part
 * must take something.
 *
 * Amounts are spread with the largest-remainder method (`allocate`), line by line; a part's tax
 * is its share of the bill's tax per component, in proportion to its taxable value in that group,
 * so a part's tax can differ by a paisa from its own taxable value × rate (PROGRESS decision 53).
 */
export function splitBill(bill: BillResult, shares: readonly (readonly number[])[]): SplitPart[] {
  const partCount = shares.length;
  if (partCount < 2) {
    throw new DomainError('INVALID_ARGUMENT', 'A split needs at least two parts', { partCount });
  }
  for (const part of shares) {
    if (part.length !== bill.lines.length) {
      throw new DomainError('INVALID_ARGUMENT', 'Every part needs a weight for every line');
    }
    if (part.every((weight) => weight === 0)) {
      throw new DomainError('INVALID_ARGUMENT', 'Every part must take something from the bill');
    }
  }
  const equal = new Array<number>(partCount).fill(1);

  // Lines, one at a time.
  const partLines: SplitLine[][] = shares.map(() => []);
  bill.lines.forEach((line, index) => {
    const weights = shares.map((part) => part[index] ?? 0);
    if (sum(weights) === 0) {
      throw new DomainError('INVALID_ARGUMENT', 'Every line must go to a part', {
        lineId: line.id,
      });
    }
    const gross = allocate(line.grossAmount, weights);
    const discount = allocate(line.itemDiscount + line.billDiscountShare, weights);
    const taxable = allocate(line.taxableValue, weights);
    weights.forEach((weight, part) => {
      if (weight === 0) return;
      partLines[part]?.push({
        lineId: line.id,
        share: weight,
        grossAmount: gross[part] ?? 0,
        discount: discount[part] ?? 0,
        taxableValue: taxable[part] ?? 0,
        taxGroupId: line.taxGroupId,
      });
    });
  });

  const taxableIn = (part: number, groupId: string) =>
    sum(
      (partLines[part] ?? [])
        .filter((line) => line.taxGroupId === groupId)
        .map((line) => line.taxableValue),
    );
  const grossIn = (part: number, groupId: string) =>
    sum(
      (partLines[part] ?? [])
        .filter((line) => line.taxGroupId === groupId)
        .map((line) => line.grossAmount),
    );
  const itemsTaxable = shares.map((_, part) =>
    sum((partLines[part] ?? []).map((line) => line.taxableValue)),
  );
  const itemsGross = shares.map((_, part) =>
    sum((partLines[part] ?? []).map((line) => line.grossAmount)),
  );

  // The service charge follows each part's taxable value of items, as it was computed on it.
  const serviceCharge = spread(
    bill.serviceCharge,
    itemsTaxable,
    itemsGross.some((gross) => gross > 0) ? itemsGross : equal,
  );

  // Taxes: each component of each group, in proportion to the part's taxable value in it.
  const partTaxLines: SplitTaxLine[][] = shares.map(() => []);
  for (const taxLine of bill.taxLines) {
    let weights: number[];
    let fallback: number[];
    let taxable: number[];
    if (taxLine.source === 'SERVICE_CHARGE') {
      weights = serviceCharge;
      fallback = itemsTaxable.some((value) => value > 0) ? itemsTaxable : equal;
      taxable = spread(taxLine.taxableValue, weights, fallback);
    } else {
      taxable = shares.map((_, part) => taxableIn(part, taxLine.taxGroupId));
      weights = taxable;
      const gross = shares.map((_, part) => grossIn(part, taxLine.taxGroupId));
      fallback = gross.some((value) => value > 0) ? gross : equal;
    }
    const components = taxLine.components.map((component) => ({
      component,
      amounts: spread(component.amount, weights, fallback),
    }));
    shares.forEach((_, part) => {
      const partComponents = components.map(({ component, amounts }) => ({
        code: component.code,
        rateBp: component.rateBp,
        amount: amounts[part] ?? 0,
      }));
      const partTaxable = taxable[part] ?? 0;
      const partTax = sum(partComponents.map((component) => component.amount));
      if (partTaxable === 0 && partTax === 0) return;
      partTaxLines[part]?.push({
        taxGroupId: taxLine.taxGroupId,
        source: taxLine.source,
        taxableValue: partTaxable,
        components: partComponents,
        taxTotal: partTax,
      });
    });
  }

  // Before round-off each part is its taxable values plus its taxes (ADR-0003), so the parts add
  // up to the bill; the round-off is then shared in proportion.
  const before = shares.map((_, part) =>
    sum((partTaxLines[part] ?? []).map((line) => line.taxableValue + line.taxTotal)),
  );
  const roundOff = spreadSigned(bill.roundOff, before, equal);

  return shares.map((_, part) => {
    const lines = partLines[part] ?? [];
    const taxLines = partTaxLines[part] ?? [];
    const totalBeforeRoundOff = before[part] ?? 0;
    const partRoundOff = roundOff[part] ?? 0;
    return {
      lines,
      taxLines,
      subtotal: sum(lines.map((line) => line.grossAmount)),
      discountTotal: sum(lines.map((line) => line.discount)),
      serviceCharge: serviceCharge[part] ?? 0,
      taxTotal: sum(taxLines.map((line) => line.taxTotal)),
      totalBeforeRoundOff,
      roundOff: partRoundOff,
      grandTotal: totalBeforeRoundOff + partRoundOff,
    };
  });
}
