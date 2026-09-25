import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { LOG_DESTINATION, type LogDestination } from '../config/config.module.js';
import { CORRELATION_HEADER, redactionPaths, resolveCorrelationId } from './correlation.js';

/**
 * Structured JSON logging with correlation IDs (NFR-O01) and secret redaction (SEC-015).
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG, LOG_DESTINATION],
      useFactory: (config: AppConfig, destination: LogDestination) => {
        const options = {
          level: config.logLevel,
          // correlationMiddleware (src/http/request-pipeline.ts) normally assigned req.id already.
          genReqId: (request: IncomingMessage, response: ServerResponse) => {
            const existing = (request as IncomingMessage & { id?: unknown }).id;
            if (typeof existing === 'string') return existing;
            const id = resolveCorrelationId(request.headers[CORRELATION_HEADER]);
            response.setHeader(CORRELATION_HEADER, id);
            return id;
          },
          // Every log line written while handling a request carries its correlation ID.
          customProps: (request: IncomingMessage) => {
            const id = (request as IncomingMessage & { id?: unknown }).id;
            return typeof id === 'string' ? { correlationId: id } : {};
          },
          customLogLevel: (_request: IncomingMessage, response: ServerResponse, error?: Error) => {
            if (error !== undefined || response.statusCode >= 500) return 'error';
            if (response.statusCode >= 400) return 'warn';
            return 'info';
          },
          redact: { paths: redactionPaths(), censor: '[REDACTED]' },
          ...(config.logPretty && config.nodeEnv !== 'production' && destination === null
            ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
            : {}),
        };
        return { pinoHttp: destination === null ? options : [options, destination] };
      },
    }),
  ],
})
export class LoggingModule {}
