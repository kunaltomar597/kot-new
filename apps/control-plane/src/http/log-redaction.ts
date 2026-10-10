/**
 * Addresses whose last part is a credential: a digital bill's private link (`/v1/bills/<token>`)
 * and the development object store's signed grants (`/v1/object-store/<grant>`). Their tokens are
 * never written to the request log or to error reports (threat CP-I3).
 */
const SECRET_IN_PATH = /^(\/v1\/(?:bills|object-store)\/)[^/?#]+/;
const MASK = '[REDACTED]';
/** Path parameters that hold those credentials. */
const SECRET_PARAMS = new Set(['token', 'grant']);

/** The address with a bill's or a grant's token replaced, anything else as it is. */
export function maskedPath(url: string): string {
  return url.replace(SECRET_IN_PATH, `$1${MASK}`);
}

/** The request as pino-http serialised it, with its address and credential parameters masked. */
export function maskedRequest<
  T extends { url?: unknown; params?: unknown; [key: string]: unknown },
>(request: T): T {
  if (typeof request.url === 'string') request.url = maskedPath(request.url);
  if (typeof request.params === 'object' && request.params !== null) {
    const params = { ...(request.params as Record<string, unknown>) };
    for (const name of Object.keys(params)) if (SECRET_PARAMS.has(name)) params[name] = MASK;
    request.params = params;
  }
  return request;
}

/** Never logged: signatures, enrolment codes and proofs (SEC-015). */
const REDACTED = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers.cookie',
  'req.headers["x-rp-signature"]',
  'code',
  '*.code',
  'proof',
  '*.proof',
];

/** What the request log leaves out: the request log's pino-http options. */
export const REQUEST_LOG_REDACTION = {
  redact: { paths: REDACTED, censor: MASK },
  serializers: { req: maskedRequest },
};
