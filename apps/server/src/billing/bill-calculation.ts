import {
  BASIS_POINTS_PER_WHOLE,
  type BillInput,
  type BillResult,
  computeBill,
  type DiscountValue,
  type PriceMode,
  type RoundOffRule,
  type TaxGroup,
} from '@rp/domain';

/** An order item as the bill needs it, from what was stored when it was ordered. */
export interface BillableItem {
  readonly id: string;
  readonly name: string;
  readonly variantName: string | null;
  readonly modifiers: readonly { readonly name: string; readonly quantity: number }[];
  readonly quantity: number;
  /** Variant price plus modifier deltas, in the menu's price mode. */
  readonly unitPrice: number;
  readonly taxGroupId: string;
  /** The group's rates when the item was ordered ({code, rateBp}[]). */
  readonly taxRates: unknown;
}

export interface ActiveDiscount {
  readonly id: string;
  readonly orderItemId: string | null;
  readonly kind: 'PERCENT' | 'FLAT';
  readonly rateBp: number | null;
  readonly amount: number;
}

export interface BillSettings {
  readonly priceMode: PriceMode;
  readonly roundingUnitPaise: number;
  readonly serviceChargeRateBp: number | null;
}

export interface CalculatedBill {
  readonly result: BillResult;
  /** Tax group key used in the calculation → the real tax group id. */
  readonly groupIdOf: ReadonlyMap<string, string>;
  /** The item discount on each line, if any. */
  readonly itemDiscountOf: ReadonlyMap<string, ActiveDiscount>;
  readonly billDiscount: ActiveDiscount | null;
}

interface StoredRate {
  readonly code: string;
  readonly rateBp: number;
}

function ratesOf(value: unknown): StoredRate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { code, rateBp } = entry as Record<string, unknown>;
    return typeof code === 'string' && typeof rateBp === 'number' ? [{ code, rateBp }] : [];
  });
}

/** "Paneer Tikka (Half) + Extra cheese x2": the line as the guest ordered it. */
export function describeItem(
  item: Pick<BillableItem, 'name' | 'variantName' | 'modifiers'>,
): string {
  const name = item.variantName === null ? item.name : `${item.name} (${item.variantName})`;
  const modifiers = item.modifiers.map((modifier) =>
    modifier.quantity === 1 ? modifier.name : `${modifier.name} x${String(modifier.quantity)}`,
  );
  return modifiers.length === 0 ? name : `${name} + ${modifiers.join(', ')}`;
}

export function discountValueOf(discount: ActiveDiscount): DiscountValue {
  return discount.kind === 'PERCENT'
    ? { kind: 'PERCENT', rateBp: discount.rateBp ?? 0 }
    : { kind: 'FLAT', amount: discount.amount };
}

export function isComplimentary(discount: ActiveDiscount | undefined): boolean {
  return discount?.kind === 'PERCENT' && discount.rateBp === BASIS_POINTS_PER_WHOLE;
}

/**
 * Prices a bill with `@rp/domain` `computeBill` (ADR-0003) from the items as ordered.
 *
 * Tax uses the rates stored on each item when it was ordered, so a tax change during a meal does
 * not change what was promised; items of one tax group with different stored rates are taxed
 * separately. The voluntary service charge is taxed with the tax group of the largest share of
 * the items' value (PROGRESS decision 42).
 */
export function calculateBill(
  items: readonly BillableItem[],
  discounts: readonly ActiveDiscount[],
  taxGroupNames: ReadonlyMap<string, string>,
  settings: BillSettings,
): CalculatedBill {
  const groups = new Map<string, TaxGroup>();
  const groupIdOf = new Map<string, string>();
  const keyOf = (item: BillableItem): string => {
    const rates = ratesOf(item.taxRates);
    const key = `${item.taxGroupId}|${rates.map((rate) => `${rate.code}:${String(rate.rateBp)}`).join(',')}`;
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        name: taxGroupNames.get(item.taxGroupId) ?? 'Tax',
        components: rates,
      });
      groupIdOf.set(key, item.taxGroupId);
    }
    return key;
  };

  const itemDiscountOf = new Map<string, ActiveDiscount>();
  let billDiscount: ActiveDiscount | null = null;
  for (const discount of discounts) {
    if (discount.orderItemId === null) billDiscount = discount;
    else itemDiscountOf.set(discount.orderItemId, discount);
  }

  const lines = items.map((item) => {
    const discount = itemDiscountOf.get(item.id);
    return {
      id: item.id,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      taxGroupId: keyOf(item),
      ...(discount !== undefined &&
        (isComplimentary(discount)
          ? { complimentary: true }
          : { discount: discountValueOf(discount) })),
    };
  });

  // Service charge follows the tax group carrying the most value on this bill.
  let serviceCharge: BillInput['serviceCharge'] = null;
  if (settings.serviceChargeRateBp !== null && lines.length > 0) {
    const valueByGroup = new Map<string, number>();
    for (const line of lines) {
      valueByGroup.set(
        line.taxGroupId,
        (valueByGroup.get(line.taxGroupId) ?? 0) + line.unitPrice * line.quantity,
      );
    }
    const [largest] = [...valueByGroup].sort((a, b) => b[1] - a[1]);
    if (largest !== undefined) {
      serviceCharge = { rateBp: settings.serviceChargeRateBp, taxGroupId: largest[0] };
    }
  }

  const roundOff: RoundOffRule =
    settings.roundingUnitPaise === 0
      ? { kind: 'NONE' }
      : { kind: 'NEAREST', unit: settings.roundingUnitPaise };
  const result = computeBill({
    priceMode: settings.priceMode,
    lines,
    taxGroups: [...groups.values()],
    ...(billDiscount !== null && { billDiscount: discountValueOf(billDiscount) }),
    serviceCharge,
    roundOff,
  });
  return { result, groupIdOf, itemDiscountOf, billDiscount };
}
