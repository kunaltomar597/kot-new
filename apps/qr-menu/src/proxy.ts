import { type NextRequest, NextResponse } from 'next/server';

/**
 * The site's Content-Security-Policy, set on every response at request time (not in next.config,
 * whose headers are fixed at build time): the browser may talk to this site and to the relay at
 * RELAY_URL only, and load nothing from anywhere else (QR-013: no third parties).
 */
function relayOrigin(): string {
  try {
    return new URL(process.env.RELAY_URL ?? '').origin;
  } catch {
    return '';
  }
}

export function contentSecurityPolicy(relay: string): string {
  return [
    "default-src 'self'",
    // Next's hydration needs inline scripts; nothing is loaded from another origin.
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: ${relay}`.trim(),
    `connect-src 'self' ${relay}`.trim(),
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function proxy(_request: NextRequest): NextResponse {
  const response = NextResponse.next();
  response.headers.set('Content-Security-Policy', contentSecurityPolicy(relayOrigin()));
  return response;
}
