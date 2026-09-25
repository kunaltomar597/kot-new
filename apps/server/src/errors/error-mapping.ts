import { HttpException, HttpStatus } from '@nestjs/common';
import type { ApiError } from '@rp/contracts';
import { type DomainErrorCode, isDomainError } from '@rp/domain';
import { ZodError } from 'zod';
import { AppError } from './app-error.js';

export interface MappedError {
  readonly status: number;
  readonly body: ApiError;
  /** Unexpected errors are sent to the error reporter; expected ones are not. */
  readonly unexpected: boolean;
}

const DOMAIN_STATUS: Readonly<Record<DomainErrorCode, number>> = {
  INVALID_AMOUNT: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_RATE: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_QUANTITY: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_ARGUMENT: HttpStatus.UNPROCESSABLE_ENTITY,
  DISCOUNT_EXCEEDS_AMOUNT: HttpStatus.UNPROCESSABLE_ENTITY,
  UNKNOWN_TAX_GROUP: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_TAX_GROUP: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_TRANSITION: HttpStatus.CONFLICT,
  INVALID_SELECTION: HttpStatus.UNPROCESSABLE_ENTITY,
  INVOICE_NUMBER_TOO_LONG: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_INVOICE_SERIES: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_DATE: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_TIME: HttpStatus.UNPROCESSABLE_ENTITY,
};

const HTTP_CODES: Readonly<Record<number, string>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

const HTTP_MESSAGES: Readonly<Record<number, string>> = {
  400: 'The request is not valid.',
  401: 'Please log in again.',
  403: 'You do not have permission to do this.',
  404: 'That page or item does not exist.',
  405: 'This action is not supported here.',
  409: 'This conflicts with the current state. Refresh and try again.',
  413: 'The upload is too large.',
  415: 'This file type is not supported.',
  429: 'Too many attempts. Wait a moment and try again.',
  503: 'The service is temporarily unavailable. Try again shortly.',
};

function withCorrelation(body: Omit<ApiError, 'correlationId'>, correlationId?: string): ApiError {
  return correlationId === undefined ? body : { ...body, correlationId };
}

function httpExceptionMessage(exception: HttpException, status: number): string {
  const response = exception.getResponse();
  if (typeof response === 'string' && response.trim() !== '') return response;
  if (typeof response === 'object') {
    const message = (response as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') return message;
    if (Array.isArray(message) && message.every((part) => typeof part === 'string')) {
      return message.join('; ');
    }
  }
  return HTTP_MESSAGES[status] ?? 'The request could not be completed.';
}

/** Body-parser errors carry an HTTP status and a type such as "entity.parse.failed". */
function bodyParserError(error: unknown): { status: number; type: string } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { status, type } = error as { status?: unknown; type?: unknown };
  if (typeof status === 'number' && typeof type === 'string' && type.startsWith('entity.')) {
    return { status, type };
  }
  return undefined;
}

export function isBodyParserError(error: unknown): boolean {
  return bodyParserError(error) !== undefined;
}

/**
 * Maps any thrown value to the `ApiError` contract and an HTTP status. Stack traces and internal
 * messages of unexpected errors never reach the client (SEC-004).
 */
export function mapError(error: unknown, correlationId?: string): MappedError {
  if (isDomainError(error)) {
    return {
      status: DOMAIN_STATUS[error.code],
      body: withCorrelation(
        {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined && { details: { ...error.details } }),
        },
        correlationId,
      ),
      unexpected: false,
    };
  }
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: withCorrelation(
        {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined && { details: { ...error.details } }),
        },
        correlationId,
      ),
      unexpected: error.status >= 500,
    };
  }
  if (error instanceof ZodError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      body: withCorrelation(
        {
          code: 'VALIDATION_FAILED',
          message: 'Some fields are missing or not valid.',
          details: {
            issues: error.issues.map((issue) => ({
              path: issue.path.map(String).join('.'),
              code: issue.code,
              message: issue.message,
            })),
          },
        },
        correlationId,
      ),
      unexpected: false,
    };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return {
      status,
      body: withCorrelation(
        {
          code: HTTP_CODES[status] ?? `HTTP_${status}`,
          message: httpExceptionMessage(error, status),
        },
        correlationId,
      ),
      unexpected: status >= 500,
    };
  }
  const parserError = bodyParserError(error);
  if (parserError !== undefined) {
    const tooLarge = parserError.type === 'entity.too.large';
    return {
      status: tooLarge ? HttpStatus.PAYLOAD_TOO_LARGE : HttpStatus.BAD_REQUEST,
      body: withCorrelation(
        tooLarge
          ? { code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' }
          : { code: 'INVALID_BODY', message: 'The request body is not valid JSON.' },
        correlationId,
      ),
      unexpected: false,
    };
  }
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: withCorrelation(
      {
        code: 'INTERNAL_ERROR',
        message:
          'Something went wrong. Try again; if it keeps happening, contact support with this reference.',
      },
      correlationId,
    ),
    unexpected: true,
  };
}
