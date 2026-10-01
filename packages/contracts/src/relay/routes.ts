import { ApiError } from '../common.js';
import type { RouteDefinition, RouteResponse } from '../routes.js';
import {
  QrMenuResponse,
  QrOrderStatusQuery,
  QrOrderView,
  QrSubmitOrderRequest,
  QrSubmitOrderResponse,
} from './schemas.js';

/**
 * Who may call a relay function (ADR-0015): `TABLE_TOKEN` needs a table's QR token in
 * `x-rp-table-token` (the browser's id in `x-rp-browser` where a rate limit applies).
 */
export type RelayAccess = 'TABLE_TOKEN';

/** Errors of every function a diner's browser calls. */
const dinerErrors = {
  400: { description: 'The request does not match the contract.', schema: ApiError },
  404: {
    description:
      'The table token is unknown, the table is no longer in service, or the restaurant is ' +
      'suspended (`TABLE_NOT_FOUND`).',
    schema: ApiError,
  },
} as const satisfies Readonly<Record<number, RouteResponse>>;

/** The relay's edge functions (Supabase, `/functions/v1/<name>`), documented like the local API. */
export const RELAY_ROUTES = [
  {
    operationId: 'getQrMenu',
    method: 'GET',
    path: '/functions/v1/qr-menu',
    summary: "The table's menu, and whether ordering is open",
    description:
      'The latest menu the restaurant published, with the table label and the pickup timeout. ' +
      '`readOnly` is true when the restaurant has not been heard from for its read-only time ' +
      '(QR-008); the site then shows the menu with a banner and no ordering.',
    tags: ['qr'],
    requirements: ['QR-001', 'QR-002', 'QR-008', 'QR-014'],
    capability: 'TABLE_TOKEN',
    responses: {
      200: { description: 'The menu.', schema: QrMenuResponse },
      ...dinerErrors,
      503: {
        description: 'The restaurant has not published a menu yet (`MENU_NOT_PUBLISHED`).',
        schema: ApiError,
      },
    },
  },
  {
    operationId: 'submitQrOrder',
    method: 'POST',
    path: '/functions/v1/submit-order',
    summary: 'Send a diner’s order to the restaurant',
    description:
      'Checks the table token, every line against the latest menu (the same check as the ' +
      "restaurant's own, ORD-017), and the rate limits per table and per browser (QR-006); then " +
      'stores the order with its idempotency key. A repeat with the same key at the same table ' +
      'returns the original order with `replayed` (ORD-013). Needs `x-rp-browser`.',
    tags: ['qr'],
    requirements: ['QR-005', 'QR-006', 'QR-007', 'ORD-013', 'ORD-014', 'ORD-017', 'QR-014'],
    capability: 'TABLE_TOKEN',
    request: { body: QrSubmitOrderRequest },
    responses: {
      200: {
        description: 'Accepted (new or replayed), or the lines the menu cannot serve.',
        schema: QrSubmitOrderResponse,
      },
      ...dinerErrors,
      409: {
        description: 'The idempotency key was used at another table (`IDEMPOTENCY_KEY_REUSED`).',
        schema: ApiError,
      },
      429: {
        description:
          'Too many orders from this table or this browser in the window (`RATE_LIMITED`, with ' +
          '`details.retryAfterSeconds` and a `Retry-After` header).',
        schema: ApiError,
      },
      503: {
        description:
          'The restaurant is offline, so ordering is closed (`RESTAURANT_OFFLINE`), or it has no ' +
          'menu yet (`MENU_NOT_PUBLISHED`).',
        schema: ApiError,
      },
    },
  },
  {
    operationId: 'getQrOrderStatus',
    method: 'GET',
    path: '/functions/v1/order-status',
    summary: 'Where a diner’s order is',
    description:
      'The order as its diner sees it (QR-007), for orders of the token’s table only. An order ' +
      'past its pickup time reads EXPIRED at once, before the expiry job marks it.',
    tags: ['qr'],
    requirements: ['QR-007', 'QR-014'],
    capability: 'TABLE_TOKEN',
    request: { query: QrOrderStatusQuery },
    responses: {
      200: { description: 'The order.', schema: QrOrderView },
      400: dinerErrors[400],
      404: {
        description:
          `${dinerErrors[404].description} Or there is no such order at this table, or it is ` +
          'past retention (`ORDER_NOT_FOUND`).',
        schema: ApiError,
      },
    },
  },
] as const satisfies readonly RouteDefinition<RelayAccess>[];
