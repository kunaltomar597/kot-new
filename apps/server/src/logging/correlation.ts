import { randomUUID } from 'node:crypto';

/**
 * Correlation IDs tie together logs from devices, the server and the cloud (NFR-O01).
 * A client may send `x-correlation-id`; otherwise the server creates one. The id is echoed in the
 * response header and in every error body so support can find the matching log lines.
 */
export const CORRELATION_HEADER = 'x-correlation-id';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** Accepts a client-supplied id only if it is short and safe to log; otherwise creates one. */
export function resolveCorrelationId(incoming: string | string[] | undefined): string {
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  return candidate !== undefined && SAFE_ID.test(candidate) ? candidate : randomUUID();
}

/**
 * Keys whose values must never appear in logs (SEC-015, CONVENTIONS "Security habits").
 * Used to build pino redaction paths at several nesting depths.
 */
export const SENSITIVE_KEYS = [
  'pin',
  'password',
  'passcode',
  'otp',
  'totp',
  'token',
  'accessToken',
  'refreshToken',
  'overrideToken',
  'deviceToken',
  'secret',
  'privateKey',
  'authorization',
  'cookie',
] as const;

export function redactionPaths(): string[] {
  const paths = new Set<string>([
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-device-token"]',
    'res.headers["set-cookie"]',
  ]);
  for (const key of SENSITIVE_KEYS) {
    paths.add(key);
    paths.add(`*.${key}`);
    paths.add(`*.*.${key}`);
  }
  return [...paths];
}
