import {
  BROWSER_ID_HEADER,
  BrowserId,
  QrSubmitOrderRequest,
  type QrSubmitOrderResponse,
} from '@rp/contracts/relay';
import { isRejectedLine, resolveOrderLine } from '@rp/ordering';
import type { Tx } from './db.js';
import {
  ORDER_COLUMNS,
  openTable,
  type OrderRow,
  orderView,
  publishedMenu,
  restaurantState,
} from './diner.js';
import { type Handler, HttpError, json, readBody, serveWith } from './http.js';

/** The order with this idempotency key at the diner's table, if one was stored (ORD-013). */
async function storedOrder(tx: Tx, idempotencyKey: string): Promise<OrderRow | undefined> {
  const [row] = await tx.query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM relay.qr_orders WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return row;
}

/**
 * POST submit-order (QR-006): checks the table token, every line against the latest menu with
 * the restaurant's own check, and the rate limits; then stores the order with its idempotency key
 * (ORD-013). Nothing about prices is taken from the browser (ORD-014): the restaurant prices the
 * order when it picks it up.
 */
export const submitOrder: Handler = serveWith('POST', async (request, context) => {
  const browser = BrowserId.safeParse(request.headers.get(BROWSER_ID_HEADER));
  if (!browser.success) {
    throw new HttpError(400, 'VALIDATION_FAILED', `Send the browser's id in ${BROWSER_ID_HEADER}.`);
  }
  const body = await readBody(request, QrSubmitOrderRequest);
  const answer = await context.db.transaction(async (tx): Promise<QrSubmitOrderResponse> => {
    const scope = await openTable(tx, request);
    const previous = await storedOrder(tx, body.idempotencyKey);
    if (previous !== undefined)
      return { status: 'ACCEPTED', replayed: true, order: orderView(previous) };

    const state = await restaurantState(tx, scope);
    const { version, document } = publishedMenu(state);
    if (state.readOnly) {
      throw new HttpError(
        503,
        'RESTAURANT_OFFLINE',
        "We couldn't reach the restaurant right now. Please call a waiter.",
      );
    }

    const now = context.now();
    const rejectedLines = body.lines.flatMap((line) => {
      const resolved = resolveOrderLine(document.menu, line, {
        channel: 'QR',
        instructionMaxLength: document.instructionMaxLength,
        now,
        timeZone: document.timeZone,
      });
      return isRejectedLine(resolved) ? [resolved] : [];
    });
    const [first, ...others] = rejectedLines;
    if (first !== undefined)
      return { status: 'REJECTED', rejectedLines: [first, ...others], version };

    const [limit] = await tx.query<{ wait: number }>('SELECT relay.rate_limit_wait($1) AS wait', [
      browser.data,
    ]);
    const wait = limit?.wait ?? 0;
    if (wait > 0) {
      // The same order may have been stored while this one waited for the table.
      const replay = await storedOrder(tx, body.idempotencyKey);
      if (replay !== undefined)
        return { status: 'ACCEPTED', replayed: true, order: orderView(replay) };
      throw new HttpError(
        429,
        'RATE_LIMITED',
        'Too many orders from this table just now. Please wait a moment or call a waiter.',
        { retryAfterSeconds: wait },
        { 'retry-after': String(wait) },
      );
    }

    const [inserted] = await tx.query<OrderRow>(
      `INSERT INTO relay.qr_orders (tenant_id, table_id, idempotency_key, browser_id,
         snapshot_version, lines, instructions, customer_name)
       VALUES ($1, $2, $3, $4, $5::bigint, $6::text::jsonb, $7, $8)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING ${ORDER_COLUMNS}`,
      [
        scope.tenantId,
        scope.tableId,
        body.idempotencyKey,
        browser.data,
        version,
        JSON.stringify(body.lines),
        body.orderNote ?? null,
        body.customerName ?? null,
      ],
    );
    if (inserted !== undefined)
      return { status: 'ACCEPTED', replayed: false, order: orderView(inserted) };
    // The same key arrived at the same moment (the table lock let it finish first), or it was
    // used at another table, which this diner may not see.
    const concurrent = await storedOrder(tx, body.idempotencyKey);
    if (concurrent !== undefined) {
      return { status: 'ACCEPTED', replayed: true, order: orderView(concurrent) };
    }
    throw new HttpError(
      409,
      'IDEMPOTENCY_KEY_REUSED',
      'This order key was already used. Please try again.',
    );
  });
  return json(200, answer);
});
