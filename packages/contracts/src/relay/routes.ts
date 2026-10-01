import { ApiError } from '../common.js';
import type { RouteDefinition, RouteResponse } from '../routes.js';
import {
  PublishQrMenuRequest,
  QrMenuQuery,
  PublishQrMenuResponse,
  QrMenuResponse,
  QrOrderParams,
  QrOrderStatusQuery,
  QrOrderView,
  QrPickupResponse,
  QrServiceRequestBody,
  QrServiceRequestParams,
  QrServiceRequestPickupResponse,
  QrServiceRequestQuery,
  QrServiceRequestResponse,
  QrServiceRequestView,
  UpdateQrServiceRequest,
  UpdateQrServiceRequestResponse,
  QrSubmitOrderRequest,
  QrSubmitOrderResponse,
  RelayPresenceRequest,
  RelayPresenceResponse,
  RelaySessionResponse,
  SyncRelayTablesRequest,
  SyncRelayTablesResponse,
  UpdateQrOrderRequest,
  UpdateQrOrderResponse,
} from './schemas.js';

/**
 * Who may call a relay function (ADR-0015): `TABLE_TOKEN` needs a table's QR token in
 * `x-rp-table-token` (the browser's id in `x-rp-browser` where a rate limit applies);
 * `SERVER_CREDENTIAL` needs a local server's credential as `Authorization: Bearer <credential>`.
 */
export type RelayAccess = 'TABLE_TOKEN' | 'SERVER_CREDENTIAL';

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

/** Errors of every function a local server calls. */
const serverErrors = {
  400: { description: 'The request does not match the contract.', schema: ApiError },
  401: {
    description:
      'Missing, unknown or revoked credential, or the restaurant is suspended ' +
      '(`CREDENTIAL_REJECTED`).',
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
      '(QR-008); the site then shows the menu with a banner and no ordering. With `?known=` the ' +
      'version the browser has, an unchanged menu comes back as `document: null`.',
    tags: ['qr'],
    requirements: ['QR-001', 'QR-002', 'QR-008', 'QR-014'],
    capability: 'TABLE_TOKEN',
    request: { query: QrMenuQuery },
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
  {
    operationId: 'openRelaySession',
    method: 'POST',
    path: '/functions/v1/server/session',
    summary: 'A short-lived token for the Realtime channel of new orders',
    description:
      "Signed for the role `relay_server` and the credential's restaurant, so the subscription " +
      'sees only its own orders (QR-009). It expires within the hour; the sync agent renews it ' +
      'and polls `GET server/orders` meanwhile.',
    tags: ['server'],
    requirements: ['QR-009', 'SEC-005', 'QR-014'],
    capability: 'SERVER_CREDENTIAL',
    responses: {
      200: { description: 'The token and what to subscribe to.', schema: RelaySessionResponse },
      ...serverErrors,
      503: {
        description:
          'Realtime tokens are not set up for this relay (`REALTIME_NOT_CONFIGURED`); poll instead.',
        schema: ApiError,
      },
    },
  },
  {
    operationId: 'reportRelayPresence',
    method: 'POST',
    path: '/functions/v1/server/presence',
    summary: 'The local server is here, with the QR settings to enforce',
    description:
      'Sent every `qr.presenceIntervalSeconds` (QR-008). Without it for `qr.readOnlyAfterSeconds` ' +
      'the QR menu turns read-only. The settings take effect for the next order.',
    tags: ['server'],
    requirements: ['QR-008', 'QR-006', 'QR-007'],
    capability: 'SERVER_CREDENTIAL',
    request: { body: RelayPresenceRequest },
    responses: {
      200: { description: 'Noted.', schema: RelayPresenceResponse },
      ...serverErrors,
    },
  },
  {
    operationId: 'publishQrMenu',
    method: 'PUT',
    path: '/functions/v1/server/menu',
    summary: 'Publish the QR menu',
    description:
      'A new version of the document the QR site shows and checks orders against (QR-003). The ' +
      'same version with the same document again is a replay; an older or different one is ' +
      'refused (`STALE_MENU_VERSION`, with `details.latest`).',
    tags: ['server'],
    requirements: ['QR-003', 'MENU-006', 'MENU-013'],
    capability: 'SERVER_CREDENTIAL',
    request: { body: PublishQrMenuRequest },
    responses: {
      200: { description: 'Published, or already published.', schema: PublishQrMenuResponse },
      ...serverErrors,
      409: { description: 'Older than the latest publication.', schema: ApiError },
    },
  },
  {
    operationId: 'syncRelayTables',
    method: 'PUT',
    path: '/functions/v1/server/tables',
    summary: 'Keep the tables and their QR code hashes in step',
    description:
      'Every table of the restaurant with the SHA-256 of its QR token (QR-001). A new hash ' +
      'replaces the old one, so a regenerated code stops the old one at once; tables left out ' +
      'are taken out of service.',
    tags: ['server'],
    requirements: ['QR-001', 'QR-010'],
    capability: 'SERVER_CREDENTIAL',
    request: { body: SyncRelayTablesRequest },
    responses: {
      200: { description: 'In step.', schema: SyncRelayTablesResponse },
      ...serverErrors,
    },
  },
  {
    operationId: 'listQrOrdersForPickup',
    method: 'GET',
    path: '/functions/v1/server/orders',
    summary: 'Diners’ orders waiting to be picked up',
    description:
      'Submitted orders still within their pickup time, oldest first, at most 100: the polling ' +
      'fallback to Realtime (QR-009). An order stays here until it is marked received or expires.',
    tags: ['server'],
    requirements: ['QR-009', 'QR-007'],
    capability: 'SERVER_CREDENTIAL',
    responses: {
      200: { description: 'The orders.', schema: QrPickupResponse },
      ...serverErrors,
    },
  },
  {
    operationId: 'updateQrOrder',
    method: 'POST',
    path: '/functions/v1/server/orders/:orderId/status',
    summary: 'What became of a diner’s order',
    description:
      'Received (with the local order), sent to the kitchen, rejected with the reason, or ' +
      'expired, and the kitchen’s item states (QR-007). An order past its pickup time cannot be ' +
      'received: it is marked expired and the answer is `ORDER_EXPIRED`, so the restaurant ' +
      'rejects it.',
    tags: ['server'],
    requirements: ['QR-007', 'QR-009'],
    capability: 'SERVER_CREDENTIAL',
    request: { params: QrOrderParams, body: UpdateQrOrderRequest },
    responses: {
      200: { description: 'Updated.', schema: UpdateQrOrderResponse },
      ...serverErrors,
      404: {
        description: 'No such order of this restaurant (`ORDER_NOT_FOUND`).',
        schema: ApiError,
      },
      409: {
        description: 'The status cannot move that way (`INVALID_STATUS_CHANGE`).',
        schema: ApiError,
      },
      410: {
        description: 'Not picked up in time; now expired (`ORDER_EXPIRED`).',
        schema: ApiError,
      },
    },
  },
  {
    operationId: 'raiseQrServiceRequest',
    method: 'POST',
    path: '/functions/v1/service-request',
    summary: 'Call a waiter or ask for the bill from the QR page',
    description:
      'For tables without a tablet (QR-011), through the restaurant’s own service requests: the ' +
      'waiter is alerted, and asking for the bill also tells the cashier. One open request of ' +
      'each kind per table: asking again finds the open one (`existing`). Needs `x-rp-browser`.',
    tags: ['qr'],
    requirements: ['QR-011', 'QR-014'],
    capability: 'TABLE_TOKEN',
    request: { body: QrServiceRequestBody },
    responses: {
      200: { description: 'The request, new or already open.', schema: QrServiceRequestResponse },
      ...dinerErrors,
      409: {
        description:
          'The restaurant does not take requests from the QR page (`SERVICE_REQUESTS_OFF`), or ' +
          'the key was used for another request (`IDEMPOTENCY_KEY_REUSED`).',
        schema: ApiError,
      },
      503: {
        description: 'The restaurant is offline (`RESTAURANT_OFFLINE`).',
        schema: ApiError,
      },
    },
  },
  {
    operationId: 'getQrServiceRequest',
    method: 'GET',
    path: '/functions/v1/service-request',
    summary: 'Where a diner’s request is',
    tags: ['qr'],
    requirements: ['QR-011', 'QR-014'],
    capability: 'TABLE_TOKEN',
    request: { query: QrServiceRequestQuery },
    responses: {
      200: { description: 'The request.', schema: QrServiceRequestView },
      400: dinerErrors[400],
      404: {
        description: `${dinerErrors[404].description} Or no such request here (\`REQUEST_NOT_FOUND\`).`,
        schema: ApiError,
      },
    },
  },
  {
    operationId: 'listQrServiceRequestsForPickup',
    method: 'GET',
    path: '/functions/v1/server/service-requests',
    summary: 'Diners’ requests waiting to be picked up',
    tags: ['server'],
    requirements: ['QR-011'],
    capability: 'SERVER_CREDENTIAL',
    responses: {
      200: { description: 'The requests, oldest first.', schema: QrServiceRequestPickupResponse },
      ...serverErrors,
    },
  },
  {
    operationId: 'updateQrServiceRequest',
    method: 'POST',
    path: '/functions/v1/server/service-requests/:requestId/status',
    summary: 'What became of a diner’s request',
    description:
      'Received (the waiter is alerted), acknowledged (on the way), done, or rejected with the ' +
      'reason. Receiving one past its pickup time marks it expired (`REQUEST_EXPIRED`).',
    tags: ['server'],
    requirements: ['QR-011'],
    capability: 'SERVER_CREDENTIAL',
    request: { params: QrServiceRequestParams, body: UpdateQrServiceRequest },
    responses: {
      200: { description: 'Updated.', schema: UpdateQrServiceRequestResponse },
      ...serverErrors,
      404: { description: 'No such request of this restaurant.', schema: ApiError },
      409: { description: 'The status cannot move that way.', schema: ApiError },
      410: { description: 'Not picked up in time; now expired.', schema: ApiError },
    },
  },
] as const satisfies readonly RouteDefinition<RelayAccess>[];
