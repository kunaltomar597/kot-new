import {
  QrMenuDocument,
  type QrOrderStatus,
  QrOrderStatusDetail,
  type QrOrderView,
  TABLE_TOKEN_HEADER,
  TableToken,
} from '@rp/contracts/relay';
import { actAsDiner, isoUtc, resolveTable, type TableScope, type Tx } from './db.js';
import { HttpError } from './http.js';

/**
 * What the diner-facing functions share (QR-001, QR-007, QR-008): opening the table from its QR
 * token, the restaurant's live state, and an order as its diner sees it.
 */

/**
 * The table's QR token from its header, of the right form. The functions that take a body check
 * it before reading the body (RELAY-D3).
 */
export function tableTokenOf(request: Request): string {
  const token = TableToken.safeParse(request.headers.get(TABLE_TOKEN_HEADER));
  if (!token.success) {
    throw new HttpError(
      400,
      'VALIDATION_FAILED',
      `Send the table's QR token in ${TABLE_TOKEN_HEADER}.`,
    );
  }
  return token.data;
}

/** Opens the token's table and acts for its diner; anything else is TABLE_NOT_FOUND. */
export async function openTable(tx: Tx, request: Request): Promise<TableScope> {
  const scope = await resolveTable(tx, tableTokenOf(request));
  if (scope === undefined) {
    throw new HttpError(
      404,
      'TABLE_NOT_FOUND',
      'This QR code is not in use. Please ask a waiter for help.',
    );
  }
  await actAsDiner(tx, scope);
  return scope;
}

export interface RestaurantState {
  /** The latest publication, if any; its document is null when it is the `known` version. */
  readonly menu: { readonly version: number; readonly document: unknown } | undefined;
  /** QR-008: not heard from within the read-only time. */
  readonly readOnly: boolean;
  readonly pickupTimeoutSeconds: number;
}

/**
 * The latest menu, whether the restaurant is present, and its pickup timeout. A browser that has
 * the latest version already (`known`) is asked about every few seconds (NFR-P05): the menu is
 * then not read at all.
 */
export async function restaurantState(
  tx: Tx,
  scope: TableScope,
  known?: number,
): Promise<RestaurantState> {
  const [row] = await tx.query<{
    version: number | null;
    menu: unknown;
    read_only: boolean;
    pickup: number;
  }>(
    `SELECT latest.version::int AS version,
            CASE WHEN latest.version = $2::bigint THEN NULL ELSE latest.menu END AS menu,
            (p.last_seen_at IS NULL
              OR p.last_seen_at < now() - make_interval(secs => s.read_only_after_seconds))
              AS read_only,
            s.pickup_timeout_seconds AS pickup
     FROM relay.tenant_settings AS s
     LEFT JOIN relay.presence AS p ON p.tenant_id = s.tenant_id
     LEFT JOIN LATERAL (
       SELECT m.version, m.menu FROM relay.menu_snapshots AS m
       WHERE m.tenant_id = s.tenant_id ORDER BY m.version DESC LIMIT 1
     ) AS latest ON true
     WHERE s.tenant_id = $1`,
    [scope.tenantId, known ?? null],
  );
  if (row === undefined) throw new HttpError(404, 'TABLE_NOT_FOUND', 'This QR code is not in use.');
  return {
    menu: row.version === null ? undefined : { version: row.version, document: row.menu },
    readOnly: row.read_only,
    pickupTimeoutSeconds: row.pickup,
  };
}

/** The published menu document; a restaurant without one cannot take orders yet. */
export function publishedMenu(state: RestaurantState): {
  version: number;
  document: QrMenuDocument;
} {
  if (state.menu === undefined) {
    throw new HttpError(
      503,
      'MENU_NOT_PUBLISHED',
      'The menu is not available yet. Please ask a waiter.',
    );
  }
  return { version: state.menu.version, document: QrMenuDocument.parse(state.menu.document) };
}

/** Columns of an order as its diner sees it. */
export const ORDER_COLUMNS = `id, status, (status = 'SUBMITTED' AND expires_at < now()) AS overdue,
  ${isoUtc('submitted_at')} AS submitted_at, ${isoUtc('expires_at')} AS expires_at,
  lines, instructions, customer_name, status_detail`;

export interface OrderRow {
  id: string;
  status: QrOrderStatus;
  overdue: boolean;
  submitted_at: string;
  expires_at: string;
  lines: QrOrderView['lines'];
  instructions: string | null;
  customer_name: string | null;
  status_detail: unknown;
}

/** QR-007: an order past its pickup time reads EXPIRED at once, before the expiry job runs. */
export function orderView(row: OrderRow): QrOrderView {
  const detail = QrOrderStatusDetail.safeParse(row.status_detail ?? {});
  return {
    id: row.id,
    status: row.overdue ? 'EXPIRED' : row.status,
    submittedAt: row.submitted_at,
    expiresAt: row.expires_at,
    lines: row.lines,
    orderNote: row.instructions,
    customerName: row.customer_name,
    detail: detail.success ? detail.data : {},
  };
}
