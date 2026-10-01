import type { QrMenuResponse } from '@rp/contracts/relay';
import { openTable, publishedMenu, restaurantState } from './diner.js';
import { type Handler, json, serveWith } from './http.js';

/**
 * GET qr-menu (QR-002, QR-008): the table's latest menu and whether ordering is open. The menu is
 * the document the restaurant published, checked when it was published (P5-02b).
 */
export const qrMenu: Handler = serveWith('GET', (request, context) =>
  context.db.transaction(async (tx) => {
    const scope = await openTable(tx, request);
    const state = await restaurantState(tx, scope);
    const { version, document } = publishedMenu(state);
    const body: QrMenuResponse = {
      table: { label: scope.label },
      version,
      readOnly: state.readOnly,
      pickupTimeoutSeconds: state.pickupTimeoutSeconds,
      document,
    };
    return json(200, body);
  }),
);
