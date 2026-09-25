import type { NextFunction, Request, Response } from 'express';
import { isBodyParserError, mapError } from '../errors/error-mapping.js';
import { CORRELATION_HEADER, resolveCorrelationId } from '../logging/correlation.js';

type RequestWithId = Request & { id?: unknown };

/**
 * First middleware of every request: assigns the correlation ID before anything else can fail,
 * so even body-parsing errors carry one (NFR-O01). The logger reuses `req.id`.
 */
export function correlationMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const id = resolveCorrelationId(request.headers[CORRELATION_HEADER]);
  (request as RequestWithId).id = id;
  response.setHeader(CORRELATION_HEADER, id);
  next();
}

/**
 * Answers malformed or oversized JSON bodies in the ApiError shape. Runs straight after the JSON
 * parser; every other error continues to the Nest exception filter.
 */
export function bodyParserErrorHandler(
  error: unknown,
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (!isBodyParserError(error)) {
    next(error);
    return;
  }
  const id = (request as RequestWithId).id;
  const mapped = mapError(error, typeof id === 'string' ? id : undefined);
  response.status(mapped.status).json(mapped.body);
}
