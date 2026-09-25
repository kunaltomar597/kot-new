import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import type { AppConfig } from './config/app-config.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { DevicesModule } from './devices/devices.module.js';
import { ApiExceptionFilter } from './errors/api-exception.filter.js';
import { HealthModule } from './health/health.module.js';
import { LoggingModule } from './logging/logging.module.js';
import { ObservabilityModule } from './observability/error-reporter.js';

/**
 * Root module. Feature modules (audit, auth, devices, realtime, settings, floor, menu, orders,
 * kitchen, billing, ...) are added here by later work packages.
 */
@Module({})
export class AppModule {
  static forRoot(config?: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggingModule,
        ObservabilityModule,
        DatabaseModule,
        AuthModule,
        AuditModule,
        DevicesModule,
        HealthModule,
      ],
      providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
    };
  }
}
