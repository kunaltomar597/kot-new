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
  notFoundOutsideApi,
  securityHeadersMiddleware,
} from './http/pipeline.js';
import { requestLimitMiddleware } from './http/request-limits.js';
import { webMiddleware } from './http/web-static.js';

export const API_PREFIX = 'v1';
/** Heartbeats are small; anything larger is refused before it is parsed. */
const JSON_BODY_LIMIT = '64kb';
/** 20 MB of files in base64, with room for the JSON around them. */
const MENU_BODY_LIMIT = '28mb';
/** A 4 MB diagnostics bundle (UPD-008) with room for the request around it. */
const DIAGNOSTICS_BODY_LIMIT = '5mb';

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
  express.use(securityHeadersMiddleware);
  if (config.env !== 'development') express.use(hstsMiddleware);
  // Before the web app, the bodies and everything else that costs (CP-D1).
  express.use(
    requestLimitMiddleware({
      burst: config.requestBurst,
      perSecond: config.requestsPerSecond,
      publicBurst: config.publicRequestBurst,
      publicPerSecond: config.publicRequestsPerSecond,
    }),
  );
  // The vendor web app (P7-02e) on the same origin as the API; never for `/v1/...`.
  if (config.webDir !== undefined) express.use(webMiddleware(config.webDir));
  // Menu photos and PDFs (ONB-006) are the only large bodies; everything else stays small.
  express.use(
    `/${API_PREFIX}/menu-extractions`,
    json({ limit: MENU_BODY_LIMIT, verify: keepRawBody }),
  );
  express.use(
    `/${API_PREFIX}/diagnostics`,
    json({ limit: DIAGNOSTICS_BODY_LIMIT, verify: keepRawBody }),
  );
  express.use(json({ limit: JSON_BODY_LIMIT, verify: keepRawBody }));
  express.use(bodyParserErrorHandler);
  express.use(notFoundOutsideApi(API_PREFIX));
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
