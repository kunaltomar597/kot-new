import {
  BROWSER_ID_HEADER,
  BrowserId,
  QrServiceRequestBody,
  QrServiceRequestQuery,
  type QrServiceRequestResponse,
  type QrServiceRequestStatus,
  type QrServiceRequestType,
  type QrServiceRequestView,
} from '@rp/contracts/relay';
import { isoUtc, type Tx } from './db.js';
import { openTable, publishedMenu, restaurantState, tableTokenOf } from './diner.js';
import {
  DINER_BODY_MAX_BYTES,
  type FunctionContext,
  HttpError,
  json,
  readBody,
  serveRoutes,
  sqlStateOf,
} from './http.js';

export const REQUEST_COLUMNS = `id, type, status,
  (status = 'SUBMITTED' AND expires_at < now()) AS overdue,
  ${isoUtc('submitted_at')} AS submitted_at, ${isoUtc('expires_at')} AS expires_at,
  rejection_reason`;

export interface RequestRow {
  id: string;
  type: QrServiceRequestType;
  status: QrServiceRequestStatus;
  overdue: boolean;
  submitted_at: string;
  expires_at: string;
  rejection_reason: string | null;
}

/** A request as its diner sees it; one past its pickup time reads EXPIRED at once. */
export function requestView(row: RequestRow): QrServiceRequestView {
  return {
    id: row.id,
    type: row.type,
    status: row.overdue ? 'EXPIRED' : row.status,
    submittedAt: row.submitted_at,
    expiresAt: row.expires_at,
    rejectionReason: row.rejection_reason,
  };
}

async function find(tx: Tx, where: string, params: unknown[]): Promise<RequestRow | undefined> {
  const [row] = await tx.query<RequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM relay.qr_service_requests WHERE ${where}`,
    params,
  );
  return row;
}

/**
 * POST service-request (QR-011): call a waiter or ask for the bill, once per kind at a time, and
 * within the relay's limits per table and per browser (RELAY-D2).
 */
async function raise(request: Request, context: FunctionContext): Promise<Response> {
  const browser = BrowserId.safeParse(request.headers.get(BROWSER_ID_HEADER));
  if (!browser.success) {
    throw new HttpError(400, 'VALIDATION_FAILED', `Send the browser's id in ${BROWSER_ID_HEADER}.`);
  }
  // The headers first: a call without a token of the right form sends no body that is read.
  tableTokenOf(request);
  const body = await readBody(request, QrServiceRequestBody, DINER_BODY_MAX_BYTES);
  const answer = await context.db.transaction(async (tx): Promise<QrServiceRequestResponse> => {
    const scope = await openTable(tx, request);
    const state = await restaurantState(tx, scope);
    const { document } = publishedMenu(state);
    if (!document.serviceRequests) {
      throw new HttpError(
        409,
        'SERVICE_REQUESTS_OFF',
        'Please call a waiter at the table; this restaurant takes requests in person.',
      );
    }
    if (state.readOnly) {
      throw new HttpError(
        503,
        'RESTAURANT_OFFLINE',
        "We couldn't reach the restaurant right now. Please call a waiter.",
      );
    }
    const same = await find(tx, 'idempotency_key = $1', [body.idempotencyKey]);
    if (same !== undefined) {
      if (same.type !== body.type) {
        throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used.');
      }
      return { existing: true, request: requestView(same) };
    }
    const open = async () =>
      find(
        tx,
        "type = $1 AND status IN ('SUBMITTED', 'RECEIVED', 'ACKNOWLEDGED') AND NOT (status = 'SUBMITTED' AND expires_at < now())",
        [body.type],
      );
    const already = await open();
    if (already !== undefined) return { existing: true, request: requestView(already) };
    // Waits for the table's and the browser's locks, so two presses at once are counted in turn.
    const [limit] = await tx.query<{ wait: number }>(
      'SELECT relay.service_request_wait($1) AS wait',
      [browser.data],
    );
    const wait = limit?.wait ?? 0;
    if (wait > 0) {
      // Another phone at the table may have raised the same kind while this one waited.
      const opened = await open();
      if (opened !== undefined) return { existing: true, request: requestView(opened) };
      throw new HttpError(
        429,
        'RATE_LIMITED',
        'Too many requests just now. Please wait a moment or call a waiter.',
        { retryAfterSeconds: wait },
        { 'retry-after': String(wait) },
      );
    }
    try {
      const [row] = await tx.savepoint((inner) =>
        inner.query<RequestRow>(
          `INSERT INTO relay.qr_service_requests (tenant_id, table_id, idempotency_key, browser_id, type)
           VALUES ($1, $2, $3, $4, $5) RETURNING ${REQUEST_COLUMNS}`,
          [scope.tenantId, scope.tableId, body.idempotencyKey, browser.data, body.type],
        ),
      );
      if (row === undefined) throw new Error('The request was not stored');
      return { existing: false, request: requestView(row) };
    } catch (error) {
      // Pressed at the same moment at another phone at the table: the open one wins.
      if (sqlStateOf(error) !== '23505') throw error;
      const winner =
        (await open()) ?? (await find(tx, 'idempotency_key = $1', [body.idempotencyKey]));
      if (winner === undefined) throw error;
      return { existing: true, request: requestView(winner) };
    }
  });
  return json(200, answer);
}

/** GET service-request?id= (QR-011): a request of the token's table, as its diner sees it. */
async function status(request: Request, context: FunctionContext): Promise<Response> {
  const query = QrServiceRequestQuery.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!query.success)
    throw new HttpError(400, 'VALIDATION_FAILED', 'Give the request as ?id=<id>.');
  const row = await context.db.transaction(async (tx) => {
    await openTable(tx, request);
    // Row-Level Security limits this to the token's own table.
    return find(tx, 'id = $1', [query.data.id]);
  });
  if (row === undefined)
    throw new HttpError(404, 'REQUEST_NOT_FOUND', 'We could not find that request.');
  return json(200, requestView(row));
}

export const serviceRequest = serveRoutes([
  { method: 'POST', path: /\/service-request$/, handler: raise },
  { method: 'GET', path: /\/service-request$/, handler: status },
]);
