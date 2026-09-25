import { type DynamicModule, Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig, loadConfig } from './app-config.js';

@Global()
@Module({})
export class ConfigModule {
  /** Provides the validated configuration; tests pass an explicit config. */
  static forRoot(config: AppConfig = loadConfig()): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
