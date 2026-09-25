import { discountAmount, type DiscountValue } from './discount.js';
import { DomainError } from './errors.js';
import {
  allocate,
  applyRate,
  assertBasisPoints,
  assertPaise,
  DEFAULT_ROUNDING,
  multiply,
  roundToUnit,
  sum,
  type BasisPoints,
  type Paise,
  type RoundingMode,
} from './money.js';
import { computeGroupTax, type PriceMode, type TaxComponentAmount, type TaxGroup } from './tax.js';

/** One billable line. `unitPrice` already includes the variant price and modifier deltas. */
export interface BillLineInput {
  readonly id: string;
  readonly unitPrice: Paise;
  readonly quantity: number;
  readonly taxGroupId: string;
  readonly discount?: DiscountValue;
  /** A complimentary item is a 100 % item discount (BILL-005). */
  readonly complimentary?: boolean;
}

export interface ServiceChargeInput {
  readonly rateBp: BasisPoints;
  /** Tax group applied to the service charge, as configured with the restaurant's CA. */
  readonly taxGroupId: string;
}

/** Grand-total rounding: none, or to the nearest multiple of `unit` paise (100 = nearest rupee). */
export type RoundOffRule =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'NEAREST'; readonly unit: Paise; readonly mode?: RoundingMode };

export interface BillInput {
  readonly priceMode: PriceMode;
  readonly lines: readonly BillLineInput[];
  readonly taxGroups: readonly TaxGroup[];
  readonly billDiscount?: DiscountValue;
  /** Omit or set null when service charge is disabled (the default, BILL-006). */
  readonly serviceCharge?: ServiceChargeInput | null;
  readonly roundOff: RoundOffRule;
  readonly rounding?: RoundingMode;
}

export interface BillLineResult {
  readonly id: string;
  readonly quantity: number;
  readonly unitPrice: Paise;
  /** unitPrice × quantity, in the menu's price mode. */
  readonly grossAmount: Paise;
  readonly itemDiscount: Paise;
  /** This line's share of the bill-level discount. */
  readonly billDiscountShare: Paise;
  /** grossAmount − itemDiscount − billDiscountShare (still tax-inclusive in TAX_INCLUSIVE mode). */
  readonly netAmount: Paise;
  /** This line's share of its tax group's taxable value (for item-wise reports). */
  readonly taxableValue: Paise;
  readonly taxGroupId: string;
}

export interface TaxLineResult {
  readonly taxGroupId: string;
  readonly taxGroupName: string;
  readonly source: 'ITEMS' | 'SERVICE_CHARGE';
  readonly taxableValue: Paise;
  readonly components: readonly TaxComponentAmount[];
  readonly taxTotal: Paise;
}

export interface BillResult {
  readonly priceMode: PriceMode;
  readonly lines: readonly BillLineResult[];
  /** Sum of line gross amounts, before any discount. */
  readonly subtotal: Paise;
  readonly itemDiscountTotal: Paise;
  readonly billDiscountTotal: Paise;
  readonly discountTotal: Paise;
  readonly serviceCharge: Paise;
  /** Taxable value of items plus the service charge. */
  readonly taxableValueTotal: Paise;
  readonly taxLines: readonly TaxLineResult[];
  readonly taxTotal: Paise;
  readonly totalBeforeRoundOff: Paise;
  /** Adjustment added to reach the grand total; may be negative. */
  readonly roundOff: Paise;
  readonly grandTotal: Paise;
}

function validateInput(input: BillInput, groups: ReadonlyMap<string, TaxGroup>): void {
  const ids = new Set<string>();
  for (const line of input.lines) {
    if (ids.has(line.id)) {
      throw new DomainError('INVALID_ARGUMENT', `Duplicate bill line id "${line.id}"`, {
        lineId: line.id,
      });
    }
    ids.add(line.id);
    assertPaise(line.unitPrice, 'unit price');
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) {
      throw new DomainError('INVALID_QUANTITY', 'Line quantity must be a positive integer', {
        lineId: line.id,
        quantity: line.quantity,
      });
    }
    if (!groups.has(line.taxGroupId)) {
      throw new DomainError('UNKNOWN_TAX_GROUP', `Unknown tax group "${line.taxGroupId}"`, {
        lineId: line.id,
        taxGroupId: line.taxGroupId,
      });
    }
  }
  if (input.serviceCharge) {
    assertBasisPoints(input.serviceCharge.rateBp, 'service charge rate');
    if (!groups.has(input.serviceCharge.taxGroupId)) {
      throw new DomainError(
        'UNKNOWN_TAX_GROUP',
        `Unknown service charge tax group "${input.serviceCharge.taxGroupId}"`,
      );
    }
  }
}

function requireGroup(groups: ReadonlyMap<string, TaxGroup>, id: string): TaxGroup {
  const group = groups.get(id);
  if (!group)
    throw new DomainError('UNKNOWN_TAX_GROUP', `Unknown tax group "${id}"`, { taxGroupId: id });
  return group;
}

/**
 * Computes a complete GST bill (BILL-001, BILL-004 to BILL-006). Pure and deterministic:
 * the server calls it with its own prices and never trusts client totals (ORD-014).
 *
 * Order of operations (ADR-0003):
 * 1. line gross = unit price × quantity; item discounts (complimentary = 100 %);
 * 2. bill-level discount computed on the post-item-discount total and allocated over lines;
 * 3. tax computed once per tax group on the group's aggregate net amount;
 * 4. service charge = rate × taxable value of items, taxed with its own tax group (exclusive);
 * 5. round-off applied to the grand total.
 */
export function computeBill(input: BillInput): BillResult {
  const rounding = input.rounding ?? DEFAULT_ROUNDING;
  const groups = new Map(input.taxGroups.map((group) => [group.id, group] as const));
  validateInput(input, groups);

  const gross = input.lines.map((line) => multiply(line.unitPrice, line.quantity));
  const itemDiscounts = input.lines.map((line, index) => {
    const base = gross[index] ?? 0;
    if (line.complimentary === true) return base;
    return line.discount ? discountAmount(base, line.discount, rounding) : 0;
  });
  const afterItem = gross.map((amount, index) => amount - (itemDiscounts[index] ?? 0));

  const afterItemTotal = sum(afterItem);
  const billDiscountTotal = input.billDiscount
    ? discountAmount(afterItemTotal, input.billDiscount, rounding)
    : 0;
  const billShares =
    afterItemTotal === 0 ? afterItem.map(() => 0) : allocate(billDiscountTotal, afterItem);
  const net = afterItem.map((amount, index) => amount - (billShares[index] ?? 0));

  // Tax per group, in first-appearance order so invoices are stable.
  const groupOrder: string[] = [];
  const groupLineIndexes = new Map<string, number[]>();
  input.lines.forEach((line, index) => {
    let indexes = groupLineIndexes.get(line.taxGroupId);
    if (!indexes) {
      indexes = [];
      groupLineIndexes.set(line.taxGroupId, indexes);
      groupOrder.push(line.taxGroupId);
    }
    indexes.push(index);
  });

  const lineTaxable = new Array<Paise>(input.lines.length).fill(0);
  const taxLines: TaxLineResult[] = [];
  let itemsGross = 0;
  let itemsTaxable = 0;
  for (const groupId of groupOrder) {
    const group = requireGroup(groups, groupId);
    const indexes = groupLineIndexes.get(groupId) ?? [];
    const groupNet = sum(indexes.map((index) => net[index] ?? 0));
    const result = computeGroupTax(groupNet, group, input.priceMode, rounding);
    itemsGross += result.grossTotal;
    itemsTaxable += result.taxableValue;
    const lineWeights = indexes.map((index) => net[index] ?? 0);
    const shares =
      groupNet === 0 ? lineWeights.map(() => 0) : allocate(result.taxableValue, lineWeights);
    indexes.forEach((lineIndex, position) => {
      lineTaxable[lineIndex] = shares[position] ?? 0;
    });
    taxLines.push({
      taxGroupId: group.id,
      taxGroupName: group.name,
      source: 'ITEMS',
      taxableValue: result.taxableValue,
      components: result.components,
      taxTotal: result.taxTotal,
    });
  }

  let serviceCharge = 0;
  let serviceChargeGross = 0;
  if (input.serviceCharge) {
    serviceCharge = applyRate(itemsTaxable, input.serviceCharge.rateBp, rounding);
    const group = requireGroup(groups, input.serviceCharge.taxGroupId);
    const result = computeGroupTax(serviceCharge, group, 'TAX_EXCLUSIVE', rounding);
    serviceChargeGross = result.grossTotal;
    taxLines.push({
      taxGroupId: group.id,
      taxGroupName: group.name,
      source: 'SERVICE_CHARGE',
      taxableValue: result.taxableValue,
      components: result.components,
      taxTotal: result.taxTotal,
    });
  }

  const totalBeforeRoundOff = itemsGross + serviceChargeGross;
  const grandTotal =
    input.roundOff.kind === 'NONE'
      ? totalBeforeRoundOff
      : roundToUnit(totalBeforeRoundOff, input.roundOff.unit, input.roundOff.mode ?? 'HALF_UP');

  const itemDiscountTotal = sum(itemDiscounts);
  return {
    priceMode: input.priceMode,
    lines: input.lines.map((line, index) => ({
      id: line.id,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      grossAmount: gross[index] ?? 0,
      itemDiscount: itemDiscounts[index] ?? 0,
      billDiscountShare: billShares[index] ?? 0,
      netAmount: net[index] ?? 0,
      taxableValue: lineTaxable[index] ?? 0,
      taxGroupId: line.taxGroupId,
    })),
    subtotal: sum(gross),
    itemDiscountTotal,
    billDiscountTotal,
    discountTotal: itemDiscountTotal + billDiscountTotal,
    serviceCharge,
    taxableValueTotal: itemsTaxable + serviceCharge,
    taxLines,
    taxTotal: sum(taxLines.map((line) => line.taxTotal)),
    totalBeforeRoundOff,
    roundOff: grandTotal - totalBeforeRoundOff,
    grandTotal,
  };
}

/** Totals per tax component code across a bill, e.g. { CGST: 1250, SGST: 1250 } (RPT-006). */
export function taxTotalsByComponent(taxLines: readonly TaxLineResult[]): Record<string, Paise> {
  const totals: Record<string, Paise> = {};
  for (const line of taxLines) {
    for (const component of line.components) {
      totals[component.code] = (totals[component.code] ?? 0) + component.amount;
    }
  }
  return totals;
}
