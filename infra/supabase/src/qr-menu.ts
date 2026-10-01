import { QrMenuQuery, type QrMenuResponse } from '@rp/contracts/relay';
import { openTable, publishedMenu, restaurantState } from './diner.js';
import { type Handler, HttpError, json, serveWith } from './http.js';

/**
 * GET qr-menu (QR-002, QR-008): the table's latest menu and whether ordering is open. The menu is
 * the document the restaurant published, checked when it was published (P5-02b).
 */
export const qrMenu: Handler = serveWith('GET', (request, context) =>
  context.db.transaction(async (tx) => {
    const query = QrMenuQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) throw new HttpError(400, 'VALIDATION_FAILED', 'Give ?known= as a version.');
    const scope = await openTable(tx, request);
    const state = await restaurantState(tx, scope);
    const unchanged = state.menu !== undefined && state.menu.version === query.data.known;
    const { version, document } = unchanged
      ? { version: state.menu.version, document: null }
      : publishedMenu(state);
    const body: QrMenuResponse = {
      table: { label: scope.label },
      version,
      readOnly: state.readOnly,
      pickupTimeoutSeconds: state.pickupTimeoutSeconds,
      document,
      photoBase: context.photos?.publicBase ?? null,
    };
    return json(200, body);
  }),
);
