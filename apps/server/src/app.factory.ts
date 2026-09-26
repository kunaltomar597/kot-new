import type { INestApplication, NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { APP_CONFIG, type AppConfig, loadConfig } from './config/app-config.js';
import { createSecretStore } from './auth/secret-store.js';
import { consoleMiddleware } from './http/console-static.js';
import { caDownloadMiddleware } from './tls/ca-download.js';
import { localServerNames, serverTlsOptions, TlsStore } from './tls/tls-store.js';
import { tlsDirectory, TlsService } from './tls/tls.service.js';
import { bodyParserErrorHandler, correlationMiddleware } from './http/request-pipeline.js';

export const API_PREFIX = 'api/v1';

/** Options for `https.createServer`, as Nest takes them. */
type HttpsOptions = NonNullable<NestApplicationOptions['httpsOptions']>;
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
  // Order matters: correlation ID first, then the CA download and the console's files, then the
  // JSON parser, then its error handler.
  express.use(correlationMiddleware);
  express.use(caDownloadMiddleware(app.get(TlsService)));
  const { consoleDir } = app.get<AppConfig>(APP_CONFIG);
  if (consoleDir !== undefined) express.use(consoleMiddleware(consoleDir));
  express.use(json({ limit: JSON_BODY_LIMIT }));
  express.use(bodyParserErrorHandler);
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();
}

/**
 * HTTPS options with the installation's certificate (ADR-0011), creating the CA and server
 * certificate on first start. `TlsService` renews the certificate later without a restart.
 */
export async function httpsOptionsFor(config: AppConfig): Promise<HttpsOptions> {
  const store = new TlsStore(tlsDirectory(config), createSecretStore(config));
  const { material } = await store.ensure(localServerNames(config.tlsHostnames));
  // Nest's type lacks `minVersion`; the options go to https.createServer unchanged.
  return serverTlsOptions(material);
}

export async function createApp(config: AppConfig = loadConfig()): Promise<NestExpressApplication> {
  const httpsOptions = config.tls ? await httpsOptionsFor(config) : undefined;
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    ...NEST_APP_OPTIONS,
    ...(httpsOptions !== undefined && { httpsOptions }),
  });
  configureApp(app);
  return app;
}
