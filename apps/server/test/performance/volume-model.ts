/**
 * The five-year projection behind DATA-012 (P7-06d): what each table costs per order, from two
 * measurements, times the orders five years hold at design capacity (§7.2).
 *
 * - A service day through the real API (P1-14's scenario) says how many rows of each table an
 *   order writes, every table the app touches, with the average size of a row.
 * - A stretch of days at design capacity (`generate-year`) says what a row really costs on disk
 *   with its indexes, once a table holds hundreds of thousands of them.
 *
 * Each table takes the larger of the two counts per order, and the measured cost per row where the
 * bulk run has enough rows to tell; otherwise the row's own size with the median index overhead,
 * or failing that the bulk run's size per row however few rows it has.
 */

/** A table's growth in the bulk run: rows added, and bytes on disk (heap, TOAST, indexes). */
export interface BulkTable {
  readonly table: string;
  readonly rows: number;
  readonly totalBytes: number;
  readonly heapBytes: number;
}

/** A table's growth in the service day: rows added and the average size of a row. */
export interface FlowTable {
  readonly table: string;
  readonly rows: number;
  readonly averageRowBytes: number;
}

/** A table neither run writes, with what is assumed for it (and why, at the caller). */
export interface AssumedTable {
  readonly table: string;
  readonly rowsPerOrder: number;
  readonly bytesPerRow: number;
}

export interface VolumeInputs {
  readonly flow: { readonly orders: number; readonly tables: readonly FlowTable[] };
  readonly bulk: { readonly orders: number; readonly tables: readonly BulkTable[] };
  /** Used only for tables that neither run wrote. */
  readonly assumed?: readonly AssumedTable[];
  readonly ordersPerDay: number;
  readonly years: number;
  /** Tables the daily retention keeps to `retentionDays` (P7-06a). */
  readonly retained: ReadonlySet<string>;
  readonly retentionDays: number;
  /** What does not grow with orders: the schema, the menu, staff, tables; and the WAL. */
  readonly fixedBytes: number;
  /** For dead rows and free space that updates leave behind, on top of the measured sizes. */
  readonly allowance: number;
}

export interface TableProjection {
  readonly table: string;
  readonly rowsPerOrder: number;
  readonly bytesPerRow: number;
  readonly bytes: number;
  /**
   * MEASURED: the bulk run's cost per row; ESTIMATED: the row's size with index overhead (or a
   * small table's size per row); ASSUMED: a table neither run wrote.
   */
  readonly basis: 'MEASURED' | 'ESTIMATED' | 'ASSUMED';
}

export interface VolumeProjection {
  readonly days: number;
  readonly orders: number;
  /** Largest first. */
  readonly tables: readonly TableProjection[];
  readonly growingBytes: number;
  readonly totalBytes: number;
  /** Heap and TOAST times this is the table with its indexes, for the estimated tables. */
  readonly indexFactor: number;
}

/** Below this many rows, a table's size per row is mostly empty pages. */
export const MEASURABLE_ROWS = 1_000;
/** A row's header (23 bytes, aligned to 24) and its line pointer (4). */
const ROW_OVERHEAD = 28;

function median(values: readonly number[]): number | undefined {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function projectVolume(inputs: VolumeInputs): VolumeProjection {
  const days = Math.round(inputs.years * 365.25);
  const orders = days * inputs.ordersPerDay;
  const retainedOrders = Math.min(days, inputs.retentionDays) * inputs.ordersPerDay;
  const bulk = new Map(inputs.bulk.tables.map((entry) => [entry.table, entry]));
  const flow = new Map(inputs.flow.tables.map((entry) => [entry.table, entry]));
  const indexFactor =
    median(
      inputs.bulk.tables
        .filter((entry) => entry.rows >= MEASURABLE_ROWS && entry.heapBytes > 0)
        .map((entry) => entry.totalBytes / entry.heapBytes),
    ) ?? 2;

  const tables: TableProjection[] = [...new Set([...bulk.keys(), ...flow.keys()])]
    .map((table): TableProjection => {
      const inBulk = bulk.get(table);
      const inFlow = flow.get(table);
      const rowsPerOrder = Math.max(
        inFlow === undefined || inputs.flow.orders === 0 ? 0 : inFlow.rows / inputs.flow.orders,
        inBulk === undefined || inputs.bulk.orders === 0 ? 0 : inBulk.rows / inputs.bulk.orders,
      );
      const measured = inBulk !== undefined && inBulk.rows >= MEASURABLE_ROWS;
      let bytesPerRow = 0;
      if (measured) bytesPerRow = inBulk.totalBytes / inBulk.rows;
      else if (inFlow !== undefined && inFlow.averageRowBytes > 0)
        bytesPerRow = (inFlow.averageRowBytes + ROW_OVERHEAD) * indexFactor;
      // A few rows on mostly empty pages: too much per row, which errs on the safe side.
      else if (inBulk !== undefined && inBulk.rows > 0)
        bytesPerRow = inBulk.totalBytes / inBulk.rows;
      const held = inputs.retained.has(table) ? retainedOrders : orders;
      return {
        table,
        rowsPerOrder,
        bytesPerRow,
        bytes: rowsPerOrder * held * bytesPerRow,
        basis: measured ? 'MEASURED' : 'ESTIMATED',
      };
    })
    .filter((entry) => entry.bytes > 0);
  const known = new Set(tables.map((entry) => entry.table));
  for (const entry of inputs.assumed ?? []) {
    if (known.has(entry.table)) continue;
    const held = inputs.retained.has(entry.table) ? retainedOrders : orders;
    tables.push({
      ...entry,
      bytes: entry.rowsPerOrder * held * entry.bytesPerRow,
      basis: 'ASSUMED',
    });
  }
  tables.sort((a, b) => b.bytes - a.bytes);
  const growingBytes = tables.reduce((sum, entry) => sum + entry.bytes, 0);
  return {
    days,
    orders,
    tables,
    growingBytes,
    totalBytes: growingBytes * inputs.allowance + inputs.fixedBytes,
    indexFactor,
  };
}
