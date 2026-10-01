import { lineTaxShares } from '@rp/domain';

/**
 * Each invoice line's dish and its share of its tax group's tax (P4-05c, RPT-002), set when the
 * line is issued so item-wise reports over a year only add them up. The tax of each group is
 * spread over the lines by taxable value (`@rp/domain` `lineTaxShares`); the shares of an invoice
 * add up to its tax exactly.
 */
export function withLineShares<
  Line extends { orderItemId: string | null; taxGroupId: string; taxableValue: number },
>(
  lines: readonly Line[],
  taxLines: readonly { taxGroupId: string; amount: number }[],
  itemIdOf: (orderItemId: string) => string | undefined,
): (Line & { itemId: string | null; taxShare: number })[] {
  const shares = lineTaxShares(
    lines.map((line, index) => ({
      lineId: String(index),
      taxGroupId: line.taxGroupId,
      taxableValue: line.taxableValue,
    })),
    taxLines,
  );
  return lines.map((line, index) => ({
    ...line,
    itemId: line.orderItemId === null ? null : (itemIdOf(line.orderItemId) ?? null),
    taxShare: shares.get(String(index)) ?? 0,
  }));
}
