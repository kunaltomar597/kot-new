/**
 * A financial year's business records (DATA-008, P7-06b), table by table in the order they are
 * deleted (children before parents). Installation-wide: an archive and a purge cover every
 * restaurant on the PC.
 *
 * Orders, invoices, bills and shifts belong to the year of their business date. What hangs off
 * them goes with them, whatever its own date: an item added after the cut-off, a payment taken
 * the next morning, a cash movement late in the shift. So the year's records are always complete
 * in the archive, and no required link from a later record can block the purge.
 */
export interface YearTable {
  readonly table: string;
  /**
   * Which rows belong to the year. YEAR clauses use `$1` and `$2`, the year's first and last
   * business dates; the CHAIN clause uses `$1`, the last audit entry archived.
   */
  readonly where: string;
  readonly params: 'YEAR' | 'CHAIN';
}

const IN_YEAR = 'business_date BETWEEN $1::date AND $2::date';
const ORDERS = `SELECT id FROM orders WHERE ${IN_YEAR}`;
const INVOICES = `SELECT id FROM invoices WHERE ${IN_YEAR}`;

const year = (table: string, where: string = IN_YEAR): YearTable => ({
  table,
  where,
  params: 'YEAR',
});

export const YEAR_TABLES: readonly YearTable[] = [
  year('payments', `invoice_id IN (${INVOICES})`),
  year('tax_lines', `invoice_id IN (${INVOICES})`),
  year('invoice_lines', `invoice_id IN (${INVOICES})`),
  year('discounts', `invoice_id IN (${INVOICES}) OR (invoice_id IS NULL AND ${IN_YEAR})`),
  year('invoices'),
  year('bills'),
  year('cash_movements', `shift_id IN (SELECT id FROM shifts WHERE ${IN_YEAR})`),
  year('kot_lines', `kot_id IN (SELECT id FROM kots WHERE order_id IN (${ORDERS}))`),
  year('kots', `order_id IN (${ORDERS})`),
  year('order_events', `order_id IN (${ORDERS})`),
  year(
    'order_item_modifiers',
    `order_item_id IN (SELECT id FROM order_items WHERE order_id IN (${ORDERS}))`,
  ),
  year('relay_orders', `order_id IN (${ORDERS})`),
  // Derived report data: the suggestions' outcomes (REC-010).
  year('recommendation_events'),
  year('order_items', `order_id IN (${ORDERS})`),
  year('orders'),
  year('approvals'),
  year('shifts'),
  year('day_ends'),
  year('business_days'),
  // The start of the audit chain up to the year's last entry, so what stays is its tail.
  { table: 'audit_log', where: 'chain_seq <= $1::bigint', params: 'CHAIN' },
];

/** The parameters a table's clause takes. */
export function paramsFor(
  entry: YearTable,
  range: { readonly startDate: string; readonly endDate: string },
  auditTo: number | null,
): unknown[] {
  return entry.params === 'CHAIN' ? [String(auditTo ?? 0)] : [range.startDate, range.endDate];
}
