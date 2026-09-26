import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { ApiError } from '@rp/contracts/control-plane';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { CpError } from './cp-error.js';

export interface MappedError {
  readonly status: number;
  readonly body: ApiError;
  readonly unexpected: boolean;
}

const HTTP_CODES: Readonly<Record<number, string>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

/** Body-parser errors carry a status and a type such as `entity.parse.failed`. */
export function bodyParserError(error: unknown): { status: number; type: string } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { status, type } = error as { status?: unknown; type?: unknown };
  return typeof status === 'number' && typeof type === 'string' && type.startsWith('entity.')
    ? { status, type }
    : undefined;
}

/** Maps any error to the `ApiError` contract; never leaks internals. */
export function mapError(error: unknown, correlationId?: string): MappedError {
  const withId = (body: Omit<ApiError, 'correlationId'>): ApiError =>
    correlationId === undefined ? body : { ...body, correlationId };
  if (error instanceof CpError) {
    return {
      status: error.status,
      body: withId({
        code: error.code,
        message: error.message,
        ...(error.details !== undefined && { details: { ...error.details } }),
      }),
      unexpected: false,
    };
  }
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: withId({
        code: 'VALIDATION_FAILED',
        message: 'The request does not match the contract.',
        details: {
          issues: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      }),
      unexpected: false,
    };
  }
  const parser = bodyParserError(error);
  if (parser !== undefined) {
    const tooLarge = parser.status === 413;
    return {
      status: parser.status,
      body: withId({
        code: tooLarge ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON',
        message: tooLarge
          ? 'The request body is too large.'
          : 'The request body is not valid JSON.',
      }),
      unexpected: false,
    };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return {
      status,
      body: withId({
        code: HTTP_CODES[status] ?? 'HTTP_ERROR',
        message:
          status === 404 ? 'There is no such endpoint.' : 'The request could not be completed.',
      }),
      unexpected: status >= 500,
    };
  }
  return {
    status: 500,
    body: withId({
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on the Control Plane. Try again later.',
    }),
    unexpected: true,
  };
}

/** Turns every error into the `ApiError` contract with the request's correlation ID. */
@Catch()
export class CpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(CpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: unknown }>();
    const response = http.getResponse<Response>();
    const correlationId = typeof request.id === 'string' ? request.id : undefined;
    const mapped = mapError(exception, correlationId);
    if (mapped.unexpected) {
      this.logger.error({ err: exception, correlationId, path: request.path }, 'Unhandled error');
    }
    response.status(mapped.status).json(mapped.body);
  }
}
