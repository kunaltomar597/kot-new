import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { DestinationStream } from 'pino';
import { APP_CONFIG, type AppConfig, loadConfig } from './app-config.js';

/**
 * Where log lines go; null means standard output. Tests replace it to inspect what is logged
 * (for example that no PIN or token ever appears, SEC-015).
 */
export const LOG_DESTINATION = Symbol('LOG_DESTINATION');
export type LogDestination = DestinationStream | null;

@Global()
@Module({})
export class ConfigModule {
  /** Provides the validated configuration; tests pass an explicit config. */
  static forRoot(config: AppConfig = loadConfig()): DynamicModule {
    return {
      module: ConfigModule,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: LOG_DESTINATION, useValue: null },
      ],
      exports: [APP_CONFIG, LOG_DESTINATION],
    };
  }
}
