import { type NextRequest, NextResponse } from 'next/server';

/**
 * The site's Content-Security-Policy, set on every page at request time (not in next.config, whose
 * headers are fixed at build time): the browser may talk to this site and to the relay at
 * RELAY_URL only, and load nothing from anywhere else (QR-013: no third parties). Scripts run only
 * with this request's nonce, which Next.js puts on its own scripts (RELAY-T5, P8-03c1), so a
 * script injected into the page does not run.
 */
function relayOrigin(): string {
  try {
    return new URL(process.env.RELAY_URL ?? '').origin;
  } catch {
    return '';
  }
}

/** 128 random bits, as Next.js reads a nonce from the policy: base64. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export function contentSecurityPolicy(relay: string, nonce: string): string {
  return [
    "default-src 'self'",
    // Next.js's inline scripts carry the nonce, its files come from this site. No 'strict-dynamic':
    // it would also run an inline script that script on the page creates.
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    // The restaurant's accent colour is a style attribute on the page; attributes run no script.
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' data: ${relay}`.trim(),
    `connect-src 'self' ${relay}`.trim(),
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Every request, files included: a path under `/_next/static` that is no file answers an HTML
 * page too (found by the DAST scan, P8-03c1), and the header costs a file nothing.
 */
export function proxy(request: NextRequest): NextResponse {
  const policy = contentSecurityPolicy(relayOrigin(), newNonce());
  // Next.js reads the nonce from the request's policy while it renders the page.
  const headers = new Headers(request.headers);
  headers.set('content-security-policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}
