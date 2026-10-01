import {
  BROWSER_ID_HEADER,
  QrMenuResponse,
  QrOrderView,
  QrSubmitOrderResponse,
  type QrSubmitOrderRequest,
  TABLE_TOKEN_HEADER,
} from '@rp/contracts/relay';
import { ApiError } from '@rp/contracts';

/**
 * The QR relay's functions as the site calls them (P5-02a): the table's token in a header,
 * answers checked against the contracts. Used on the server for the first menu and in the
 * browser after that.
 */

export class RelayCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

async function call<T>(url: string, init: RequestInit, parse: (body: unknown) => T): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, cache: 'no-store', referrerPolicy: 'no-referrer' });
  } catch {
    throw new RelayCallError(0, 'NETWORK', 'The relay could not be reached');
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = ApiError.safeParse(body);
    throw error.success
      ? new RelayCallError(response.status, error.data.code, error.data.message, error.data.details)
      : new RelayCallError(
          response.status,
          'RELAY_ERROR',
          `The relay answered ${String(response.status)}`,
        );
  }
  return parse(body);
}

export function fetchMenu(
  relayUrl: string,
  token: string,
  known?: number,
): Promise<QrMenuResponse> {
  const query = known === undefined ? '' : `?known=${String(known)}`;
  return call(`${relayUrl}/qr-menu${query}`, { headers: { [TABLE_TOKEN_HEADER]: token } }, (body) =>
    QrMenuResponse.parse(body),
  );
}

export function submitOrder(
  relayUrl: string,
  token: string,
  browserId: string,
  order: QrSubmitOrderRequest,
): Promise<QrSubmitOrderResponse> {
  return call(
    `${relayUrl}/submit-order`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [TABLE_TOKEN_HEADER]: token,
        [BROWSER_ID_HEADER]: browserId,
      },
      body: JSON.stringify(order),
    },
    (body) => QrSubmitOrderResponse.parse(body),
  );
}

export function fetchOrder(relayUrl: string, token: string, orderId: string): Promise<QrOrderView> {
  return call(
    `${relayUrl}/order-status?id=${encodeURIComponent(orderId)}`,
    { headers: { [TABLE_TOKEN_HEADER]: token } },
    (body) => QrOrderView.parse(body),
  );
}
