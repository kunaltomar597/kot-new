import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
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
