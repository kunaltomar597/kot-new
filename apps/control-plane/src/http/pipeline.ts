import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { mapError } from '../errors/cp-exception.filter.js';

export const CORRELATION_HEADER = 'x-correlation-id';
const SAFE_ID = /^[A-Za-z0-9._:-]{1,64}$/;

type RequestWithId = Request & { id?: unknown; rawBody?: Buffer };

/** First middleware: every request and error carries a correlation ID (NFR-O01). */
export function correlationMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const incoming = request.headers[CORRELATION_HEADER];
  const id = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
  (request as RequestWithId).id = id;
  response.setHeader(CORRELATION_HEADER, id);
  next();
}

/**
 * Headers on every answer (P8-03c1): JSON, files and errors are never run as a page, framed,
 * sniffed into another type, cached or read by another site. Set first, so the vendor web app's
 * pages and the digital bill pages replace what they need.
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

/** HSTS in staging and production (SEC-001: cloud TLS with HSTS). */
export function hstsMiddleware(_request: Request, response: Response, next: NextFunction): void {
  response.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  next();
}

/** Keeps the exact body bytes: signed requests cover their SHA-256 (ADR-0012). */
export function keepRawBody(request: Request, _response: Response, body: Buffer): void {
  (request as RequestWithId).rawBody = body;
}

/** Answers malformed or oversized JSON in the ApiError shape. */
export function bodyParserErrorHandler(
  error: unknown,
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const mapped = mapError(error, (request as RequestWithId).id as string | undefined);
  if (mapped.unexpected) {
    next(error);
    return;
  }
  response.status(mapped.status).json(mapped.body);
}

/**
 * Last: a path outside the API that nothing before served (the vendor web app's files) is a 404
 * in the ApiError shape, with the security headers already set. Nest answers unknown paths only
 * under its prefix; without this, Express's own HTML page would answer the rest and replace the
 * CSP (found by the DAST scan, P8-03c1).
 */
export function notFoundOutsideApi(prefix: string): RequestHandler {
  const root = `/${prefix}`;
  return (request, response, next) => {
    if (request.path === root || request.path.startsWith(`${root}/`)) {
      next();
      return;
    }
    const mapped = mapError(
      new NotFoundException(`Cannot ${request.method} ${request.path}`),
      (request as RequestWithId).id as string | undefined,
    );
    response.status(mapped.status).json(mapped.body);
  };
}
