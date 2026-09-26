/**
 * Signed requests from installations to the Control Plane (ADR-0012): no bearer secret; each
 * request is signed with the installation's Ed25519 key over its method, path, time, a one-time
 * nonce and the SHA-256 of its body.
 */

/** Headers of a signed request. */
export const INSTALLATION_HEADERS = {
  installation: 'x-rp-installation',
  /** Milliseconds since the epoch, as a decimal string. */
  timestamp: 'x-rp-timestamp',
  /** 16 or more random bytes, base64url; accepted once per installation. */
  nonce: 'x-rp-nonce',
  /** Ed25519 signature of `signedRequestMessage(...)`, base64. */
  signature: 'x-rp-signature',
} as const;

/** How far a request's timestamp may be from the Control Plane's clock. */
export const SIGNED_REQUEST_WINDOW_MS = 5 * 60_000;

/** A nonce: base64url, 16 to 64 characters. */
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export interface SignedRequestParts {
  readonly method: string;
  /** Path with the query string exactly as sent, e.g. `/v1/updates?version=1.2.0`. */
  readonly path: string;
  readonly timestamp: string;
  readonly nonce: string;
  /** SHA-256 of the exact body bytes (of an empty body for GET), lower-case hex. */
  readonly bodySha256: string;
}

/** The text an installation signs for one request. */
export function signedRequestMessage(parts: SignedRequestParts): string {
  return [
    'rp-cp-request:v1',
    parts.method.toUpperCase(),
    parts.path,
    parts.timestamp,
    parts.nonce,
    parts.bodySha256,
  ].join('\n');
}
