import type { INestApplication, NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { APP_CONFIG, type AppConfig, loadConfig } from './config/app-config.js';
import { DEVICE_AUTHENTICATOR, type DeviceAuthenticator } from './auth/device.js';
import { createSecretStore } from './auth/secret-store.js';
import { bodyParsers } from './http/body-limits.js';
import { clientVersionMiddleware } from './http/client-version.js';
import { consoleMiddleware } from './http/console-static.js';
import { securityHeadersMiddleware } from './http/security-headers.js';
import { caDownloadMiddleware } from './tls/ca-download.js';
import { localServerNames, serverTlsOptions, TlsStore } from './tls/tls-store.js';
import { tlsDirectory, TlsService } from './tls/tls.service.js';
import {
  bodyParserErrorHandler,
  correlationMiddleware,
  notFoundOutsideApi,
} from './http/request-pipeline.js';

export const API_PREFIX = 'api/v1';

/** Options for `https.createServer`, as Nest takes them. */
type HttpsOptions = NonNullable<NestApplicationOptions['httpsOptions']>;
const UPLOAD_PATHS = [`/${API_PREFIX}/photos`, `/${API_PREFIX}/menu/import`];
const AI_IMPORT_PATH = `/${API_PREFIX}/menu/ai-imports`;

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
  // Order matters: correlation ID first, then the security headers every answer carries, then
  // the apps the server no longer serves (UPD-006), then the CA download and the console's files,
  // then the device check and the JSON parser it chooses (PC-D1), then the parser's error handler.
  express.use(correlationMiddleware);
  express.use(securityHeadersMiddleware);
  express.use(clientVersionMiddleware);
  express.use(caDownloadMiddleware(app.get(TlsService)));
  const { consoleDir } = app.get<AppConfig>(APP_CONFIG);
  if (consoleDir !== undefined) express.use(consoleMiddleware(consoleDir));
  express.use(
    bodyParsers(app.get<DeviceAuthenticator>(DEVICE_AUTHENTICATOR), {
      uploads: UPLOAD_PATHS,
      aiImport: AI_IMPORT_PATH,
    }),
  );
  express.use(bodyParserErrorHandler);
  express.use(notFoundOutsideApi(API_PREFIX));
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
