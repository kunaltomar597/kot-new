/**
 * The relay functions' database access (ADR-0015). Each request is one transaction on the edge
 * functions' own login (`relay_edge`), which can do nothing until it takes the role of whoever
 * it acts for: `relay_diner` for a browser whose table token resolved, with the tenant and table
 * in the claims, so Row-Level Security scopes every statement after that.
 */

/**
 * One transaction. Parameters are `$1`, `$2`...; never build SQL from input (SEC-004). JSON goes
 * in as a string cast `::text::jsonb`: postgres.js (Deno) would encode a string again for a
 * parameter it sees as jsonb, and node-postgres (tests) would turn an array into a SQL array.
 */
export interface Tx {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<Row[]>;
}

export interface RelayDatabase {
  /** Runs `work` in one transaction; it commits when `work` resolves and rolls back otherwise. */
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
}

/** A table a QR token opened (QR-001). */
export interface TableScope {
  readonly tenantId: string;
  readonly tableId: string;
  readonly label: string;
}

/** The table a QR token opens, if it is in service and its restaurant is not suspended. */
export async function resolveTable(tx: Tx, token: string): Promise<TableScope | undefined> {
  const [row] = await tx.query<{ tenant_id: string; table_id: string; label: string }>(
    'SELECT tenant_id, table_id, label FROM relay.resolve_table_token($1)',
    [token],
  );
  return row === undefined
    ? undefined
    : { tenantId: row.tenant_id, tableId: row.table_id, label: row.label };
}

/** From here on the transaction acts for the diner at `scope`'s table, and nothing else. */
export async function actAsDiner(tx: Tx, scope: TableScope): Promise<void> {
  await tx.query('SET LOCAL ROLE relay_diner');
  await tx.query("SELECT set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ role: 'relay_diner', tenant_id: scope.tenantId, table_id: scope.tableId }),
  ]);
}

/** A timestamp column as the contracts' ISO form, the same from every driver. */
export const isoUtc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
