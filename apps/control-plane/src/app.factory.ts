import type { INestApplication, NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';
import { Logger } from 'nestjs-pino';
import { ControlPlaneModule } from './app.module.js';
import { CP_CONFIG, type CpConfig } from './config/cp-config.js';
import {
  bodyParserErrorHandler,
  correlationMiddleware,
  hstsMiddleware,
  keepRawBody,
} from './http/pipeline.js';

export const API_PREFIX = 'v1';
/** Heartbeats are small; anything larger is refused before it is parsed. */
const JSON_BODY_LIMIT = '64kb';

/** Nest's own body parser is off: `configureControlPlaneApp` installs the pipeline in order. */
export const NEST_APP_OPTIONS: NestApplicationOptions = { bufferLogs: true, bodyParser: false };

/** Settings every instance needs, in production and in tests. */
export function configureControlPlaneApp(app: INestApplication): void {
  const express = app as NestExpressApplication;
  const config = app.get<CpConfig>(CP_CONFIG);
  express.useLogger(app.get(Logger));
  express.disable('x-powered-by');
  // The load balancer's address is not the client's (rate limits by address).
  express.set('trust proxy', config.trustProxy);
  express.use(correlationMiddleware);
  if (config.env !== 'development') express.use(hstsMiddleware);
  express.use(json({ limit: JSON_BODY_LIMIT, verify: keepRawBody }));
  express.use(bodyParserErrorHandler);
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();
}

export async function createControlPlaneApp(config: CpConfig): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    ControlPlaneModule.forRoot(config),
    NEST_APP_OPTIONS,
  );
  configureControlPlaneApp(app);
  return app;
}
