import type { INestApplication, NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { APP_CONFIG, type AppConfig, loadConfig } from './config/app-config.js';
import { consoleMiddleware } from './http/console-static.js';
import { bodyParserErrorHandler, correlationMiddleware } from './http/request-pipeline.js';

export const API_PREFIX = 'api/v1';
const JSON_BODY_LIMIT = '1mb';

/**
 * Options for creating the Nest application. Nest's own body parser is disabled because
 * `configureApp` installs the request pipeline in a fixed order.
 */
export const NEST_APP_OPTIONS: NestApplicationOptions = { bufferLogs: true, bodyParser: false };

/** Applies the settings every instance needs, in production and in tests. */
export function configureApp(app: INestApplication): void {
  const express = app as NestExpressApplication;
  express.useLogger(app.get(Logger));
  express.disable('x-powered-by');
  // Order matters: correlation ID first, then the console's files, then the JSON parser, then its
  // error handler.
  express.use(correlationMiddleware);
  const { consoleDir } = app.get<AppConfig>(APP_CONFIG);
  if (consoleDir !== undefined) express.use(consoleMiddleware(consoleDir));
  express.use(json({ limit: JSON_BODY_LIMIT }));
  express.use(bodyParserErrorHandler);
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();
}

export async function createApp(config: AppConfig = loadConfig()): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot(config),
    NEST_APP_OPTIONS,
  );
  configureApp(app);
  return app;
}
