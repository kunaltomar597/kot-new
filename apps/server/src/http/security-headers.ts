import type { NextFunction, Request, Response } from 'express';

/**
 * Headers on every answer of the server (P8-03c1, PC-I2): JSON, files and errors are never run as
 * a page, framed, sniffed into another type, cached or read by another site. Set first, so the
 * console's pages and the files with their own caching (photos, CA, APKs) replace what they need.
 * No HSTS: the LAN certificate comes from the installation's own CA, which a replaced PC renews,
 * and a browser that remembered HSTS could not open the console again (decision in PROGRESS.md).
 */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  // base-uri, form-action and frame-ancestors do not fall back to default-src: each is set.
  'content-security-policy':
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
};

export function securityHeadersMiddleware(
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
  next();
}
