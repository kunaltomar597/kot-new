import { type ArgumentsHost, Catch, type ExceptionFilter, Inject } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { CORRELATION_HEADER } from '../logging/correlation.js';
import { ERROR_REPORTER, type ErrorReporter } from '../observability/error-reporter.js';
import { mapError } from './error-mapping.js';

/**
 * Turns every error into the `ApiError` contract with the request's correlation ID.
 * Registered globally through APP_FILTER in AppModule.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly logger: PinoLogger,
    @Inject(ERROR_REPORTER) private readonly reporter: ErrorReporter,
  ) {
    this.logger.setContext(ApiExceptionFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: unknown }>();
    const response = http.getResponse<Response>();
    const correlationId = typeof request.id === 'string' ? request.id : undefined;
    const mapped = mapError(exception, correlationId);

    if (mapped.unexpected) {
      this.logger.error(
        { err: exception, correlationId, path: request.originalUrl },
        'Unhandled error',
      );
      this.reporter.report(exception, {
        correlationId,
        method: request.method,
        path: request.path,
      });
    } else {
      this.logger.debug(
        { code: mapped.body.code, status: mapped.status, correlationId },
        'Request rejected',
      );
    }

    if (correlationId !== undefined && !response.headersSent) {
      response.setHeader(CORRELATION_HEADER, correlationId);
    }
    response.status(mapped.status).json(mapped.body);
  }
}
