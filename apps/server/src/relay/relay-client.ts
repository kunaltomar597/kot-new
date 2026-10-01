import {
  ApiError,
  PublishQrMenuResponse,
  type PublishQrMenuRequest,
  QrPickupResponse,
  QrServiceRequestPickupResponse,
  type UpdateQrServiceRequest,
  UpdateQrServiceRequestResponse,
  type QrPhotoWidth,
  type RelayPhotoSweepRequest,
  RelayPhotoSweepResponse,
  RelayPhotoUploadResponse,
  type RelayPresenceRequest,
  RelayPresenceResponse,
  RelaySessionResponse,
  type SyncRelayTablesRequest,
  SyncRelayTablesResponse,
  type UpdateQrOrderRequest,
  UpdateQrOrderResponse,
} from '@rp/contracts/relay';
import type { z } from 'zod';

/** A file sent as it is, not as JSON. */
class RawBody {
  constructor(
    readonly contentType: string,
    readonly bytes: Uint8Array<ArrayBuffer>,
  ) {}
}

/** A call to the relay that failed: its HTTP status and ApiError, or UNREACHABLE. */
export class RelayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number | null = null,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export interface RelayClientOptions {
  /** The functions' address, e.g. `https://abc.supabase.co/functions/v1`. */
  readonly baseUrl: string;
  readonly credential: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

/**
 * The local server's calls to the QR relay's `server` function (P5-02b, ADR-0015), each with the
 * restaurant's credential and checked against the contracts on the way back.
 */
export class RelayClient {
  private readonly fetch: typeof fetch;

  constructor(private readonly options: RelayClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  presence(body: RelayPresenceRequest): Promise<RelayPresenceResponse> {
    return this.call('POST', 'presence', RelayPresenceResponse, body);
  }

  session(): Promise<RelaySessionResponse> {
    return this.call('POST', 'session', RelaySessionResponse);
  }

  publishMenu(body: PublishQrMenuRequest): Promise<PublishQrMenuResponse> {
    return this.call('PUT', 'menu', PublishQrMenuResponse, body);
  }

  syncTables(body: SyncRelayTablesRequest): Promise<SyncRelayTablesResponse> {
    return this.call('PUT', 'tables', SyncRelayTablesResponse, body);
  }

  pickup(): Promise<QrPickupResponse> {
    return this.call('GET', 'orders', QrPickupResponse);
  }

  updateOrder(orderId: string, body: UpdateQrOrderRequest): Promise<UpdateQrOrderResponse> {
    return this.call(
      'POST',
      `orders/${encodeURIComponent(orderId)}/status`,
      UpdateQrOrderResponse,
      body,
    );
  }

  pickupServiceRequests(): Promise<QrServiceRequestPickupResponse> {
    return this.call('GET', 'service-requests', QrServiceRequestPickupResponse);
  }

  updateServiceRequest(
    requestId: string,
    body: UpdateQrServiceRequest,
  ): Promise<UpdateQrServiceRequestResponse> {
    return this.call(
      'POST',
      `service-requests/${encodeURIComponent(requestId)}/status`,
      UpdateQrServiceRequestResponse,
      body,
    );
  }

  /** MENU-008: one size of a menu photo, as the WebP file this PC made. */
  uploadPhoto(
    photoId: string,
    width: QrPhotoWidth,
    file: Uint8Array<ArrayBuffer>,
  ): Promise<RelayPhotoUploadResponse> {
    return this.call(
      'PUT',
      `photos/${encodeURIComponent(photoId)}/${String(width)}`,
      RelayPhotoUploadResponse,
      new RawBody('image/webp', file),
    );
  }

  sweepPhotos(body: RelayPhotoSweepRequest): Promise<RelayPhotoSweepResponse> {
    return this.call('POST', 'photos/sweep', RelayPhotoSweepResponse, body);
  }

  private async call<S extends z.ZodType>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    schema: S,
    body?: unknown,
  ): Promise<z.output<S>> {
    let response: Response;
    const raw = body instanceof RawBody ? body : undefined;
    try {
      response = await this.fetch(`${this.options.baseUrl}/server/${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.options.credential}`,
          ...(body !== undefined && { 'content-type': raw?.contentType ?? 'application/json' }),
        },
        ...(body !== undefined && { body: raw?.bytes ?? JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw new RelayError(
        'UNREACHABLE',
        `The QR relay did not answer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text === '' ? undefined : JSON.parse(text);
    } catch {
      payload = undefined;
    }
    if (!response.ok) {
      const error = ApiError.safeParse(payload);
      throw error.success
        ? new RelayError(error.data.code, error.data.message, response.status, error.data.details)
        : new RelayError(
            'RELAY_ERROR',
            `The QR relay answered ${String(response.status)}`,
            response.status,
          );
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new RelayError(
        'BAD_RESPONSE',
        'The QR relay answered something unexpected',
        response.status,
      );
    }
    return parsed.data;
  }
}
