import { QrOrderStatusQuery } from '@rp/contracts/relay';
import { ORDER_COLUMNS, openTable, type OrderRow, orderView } from './diner.js';
import { type Handler, HttpError, json, serveWith } from './http.js';

/** GET order-status?id= (QR-007): an order of the token's table, as its diner sees it. */
export const orderStatus: Handler = serveWith('GET', (request, context) =>
  context.db.transaction(async (tx) => {
    const query = QrOrderStatusQuery.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!query.success) {
      throw new HttpError(400, 'VALIDATION_FAILED', 'Give the order as ?id=<order id>.');
    }
    await openTable(tx, request);
    // Row-Level Security limits this to the token's own table.
    const [row] = await tx.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM relay.qr_orders WHERE id = $1`,
      [query.data.id],
    );
    if (row === undefined) {
      throw new HttpError(404, 'ORDER_NOT_FOUND', 'We could not find that order.');
    }
    return json(200, orderView(row));
  }),
);
