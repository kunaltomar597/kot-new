import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';

/**
 * Security headers for the vendor web app's pages (SEC-003, SEC-018): scripts, styles and API
 * calls only from this origin, no framing, no plugins, no referrer, no search indexing.
 */
export const WEB_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Trusted Types (P8-03c1): no string reaches an HTML or script sink (innerHTML, eval, a
    // script's src), and no policy may be made to let one through. React never needs one.
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'x-robots-tag': 'noindex, nofollow',
};

/** Where Vite puts content-hashed files, as it appears in a file path on this platform. */
const ASSETS_FOLDER = `${sep}assets${sep}`;

/** The API is never answered with the app. */
function isApiPath(path: string): boolean {
  return path === '/v1' || path.startsWith('/v1/');
}

/** A missing `/assets/app-1a2b.js` is a 404, not the app shell (which would break as a script). */
function looksLikeFile(path: string): boolean {
  return (path.split('/').pop() ?? '').includes('.');
}

function setHeaders(response: Response, filePath: string): void {
  for (const [name, value] of Object.entries(WEB_SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
  response.setHeader(
    'cache-control',
    filePath.includes(ASSETS_FOLDER) ? 'public, max-age=31536000, immutable' : 'no-cache',
  );
}

/**
 * Serves the built vendor web app (`apps/control-plane-web/dist`, P7-02e) at `/`, so the app and
 * the API share one origin: no CORS, and the session token never leaves it. Any other GET that
 * wants HTML gets `index.html`, for the app's own routes.
 */
export function webMiddleware(directory: string): express.RequestHandler[] {
  const root = resolve(directory);
  const index = join(root, 'index.html');
  if (!existsSync(index)) {
    throw new Error(`The vendor web app build is missing: ${index} not found`);
  }
  // No redirect from a folder (`/assets` to `/assets/`): its page would replace the CSP (P8-03c1).
  const files = express.static(root, {
    index: false,
    fallthrough: true,
    redirect: false,
    setHeaders,
  });
  const staticFiles: express.RequestHandler = (request, response, next) => {
    if (isApiPath(request.path)) {
      next();
      return;
    }
    files(request, response, next);
  };
  const appShell = (request: Request, response: Response, next: NextFunction): void => {
    if (
      (request.method !== 'GET' && request.method !== 'HEAD') ||
      isApiPath(request.path) ||
      looksLikeFile(request.path) ||
      !request.accepts('html')
    ) {
      next();
      return;
    }
    setHeaders(response, index);
    response.sendFile(index);
  };
  return [staticFiles, appShell];
}
