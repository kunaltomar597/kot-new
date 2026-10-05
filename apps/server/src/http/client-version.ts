import {
  CLIENT_API_VERSION,
  CLIENT_HEADER,
  CLIENT_TOO_OLD,
  type ClientApiRange,
  type ClientCompatibility,
} from '@rp/contracts';
import {
  type ClientApiVersion,
  type ClientIdentity,
  clientCompatibility,
  formatClientApiVersion,
  oldestServedClientApi,
  parseClientApiVersion,
  parseClientIdentity,
} from '@rp/domain';
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors/app-error.js';
import { mapError } from '../errors/error-mapping.js';

function serverClientApi(): ClientApiVersion {
  const version = parseClientApiVersion(CLIENT_API_VERSION);
  if (version === undefined) throw new Error(`CLIENT_API_VERSION ${CLIENT_API_VERSION} is invalid`);
  return version;
}

/** The client API this server speaks (UPD-006, P7-04d). */
export const SERVER_CLIENT_API: ClientApiVersion = serverClientApi();

/** What this server speaks and the oldest it still serves (N-1). */
export function clientApiRange(server: ClientApiVersion = SERVER_CLIENT_API): ClientApiRange {
  return {
    current: formatClientApiVersion(server),
    oldest: formatClientApiVersion(oldestServedClientApi(server)),
  };
}

/** The app's `x-rp-client` identity; undefined when it sent none or a malformed one. */
export function clientIdentityOf(request: Pick<Request, 'headers'>): ClientIdentity | undefined {
  const header = request.headers[CLIENT_HEADER];
  return parseClientIdentity(typeof header === 'string' ? header : undefined);
}

/** How a stored client API (`devices.client_api`) stands against this server's. */
export function compatibilityOf(
  clientApi: string | null,
  server: ClientApiVersion = SERVER_CLIENT_API,
): ClientCompatibility {
  return clientCompatibility(
    server,
    clientApi === null ? undefined : parseClientApiVersion(clientApi),
  );
}

/** HTTP 426 Upgrade Required, or the socket's `connect_error`, for an app the server no longer serves. */
export function clientTooOld(identity: ClientIdentity): AppError {
  return new AppError(
    426,
    CLIENT_TOO_OLD,
    'This app is too old for the restaurant’s server. Update the app, then open it again.',
    {
      kind: identity.kind,
      appVersion: identity.version,
      clientApi: formatClientApiVersion(identity.api),
      served: clientApiRange(),
    },
  );
}

/**
 * Paths every app may call whatever its version: finding and checking the server (version, health,
 * the CA) and reporting its own errors.
 */
const OPEN_PATHS = new Set([
  '/api/v1/version',
  '/api/v1/health',
  '/api/v1/tls/ca',
  '/api/v1/client-errors',
]);

/**
 * N-1 (UPD-006): an app whose client API is older than the one before the server's is refused
 * before anything else runs, with 426 `CLIENT_TOO_OLD`, so it asks to be updated instead of failing
 * in odd ways. An app that does not say (a tool, a device paired before P7-04d) and an app newer
 * than the server are served: the server checks every request against its own contracts anyway.
 */
export function clientVersionMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (!request.path.startsWith('/api/') || OPEN_PATHS.has(request.path)) {
    next();
    return;
  }
  const identity = clientIdentityOf(request);
  if (
    identity === undefined ||
    clientCompatibility(SERVER_CLIENT_API, identity.api) !== 'TOO_OLD'
  ) {
    next();
    return;
  }
  const id = (request as Request & { id?: unknown }).id;
  const mapped = mapError(clientTooOld(identity), typeof id === 'string' ? id : undefined);
  response.status(mapped.status).json(mapped.body);
}
