import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';

/**
 * Security headers for the console's pages (SEC-003 defence in depth): scripts, styles and
 * connections only from this server, no framing, no plugins, no referrer leaks.
 */
export const CONSOLE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(self), microphone=(), geolocation=()',
};

/** Where Vite puts content-hashed files, as it appears in a file path on this platform. */
const ASSETS_FOLDER = `${sep}assets${sep}`;

/** Paths the console must never answer: the API and the real-time socket. */
function isServerPath(path: string): boolean {
  return path.startsWith('/api/') || path === '/api' || path.startsWith('/socket.io');
}

/** A missing `/assets/app-1a2b.js` is a 404, not the app shell (which would break as a script). */
function looksLikeFile(path: string): boolean {
  return (path.split('/').pop() ?? '').includes('.');
}

function setHeaders(response: Response, filePath: string): void {
  for (const [name, value] of Object.entries(CONSOLE_SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
  // Vite puts content-hashed files under /assets/: cache them for good; always revalidate the rest.
  response.setHeader(
    'cache-control',
    filePath.includes(ASSETS_FOLDER) ? 'public, max-age=31536000, immutable' : 'no-cache',
  );
}

/**
 * Serves the built web console (P0-14b) from `directory` on the server's own origin, so the
 * console, the API and the socket share one origin (no CORS) and one TLS certificate (P0-15).
 * Any other GET that wants HTML gets `index.html`, for the console's client-side routes.
 */
export function consoleMiddleware(directory: string): express.RequestHandler[] {
  const root = resolve(directory);
  const index = join(root, 'index.html');
  if (!existsSync(index)) {
    throw new Error(`The console build is missing: ${index} not found`);
  }
  const files = express.static(root, { index: false, fallthrough: true, setHeaders });
  const staticFiles: express.RequestHandler = (request, response, next) => {
    if (isServerPath(request.path)) {
      next();
      return;
    }
    files(request, response, next);
  };
  const spaFallback = (request: Request, response: Response, next: NextFunction): void => {
    if (
      (request.method !== 'GET' && request.method !== 'HEAD') ||
      isServerPath(request.path) ||
      looksLikeFile(request.path) ||
      !request.accepts('html')
    ) {
      next();
      return;
    }
    setHeaders(response, index);
    response.sendFile(index);
  };
  return [staticFiles, spaFallback];
}
