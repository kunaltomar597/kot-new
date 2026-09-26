import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuditModule } from './audit/audit.module.js';
import { BillingModule } from './billing/billing.module.js';
import { CloudModule } from './cloud/cloud.module.js';
import { AuthModule } from './auth/auth.module.js';
import type { AppConfig } from './config/app-config.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { DayEndModule } from './day-end/day-end.module.js';
import { DevicesModule } from './devices/devices.module.js';
import { EventsModule } from './events/events.module.js';
import { ApiExceptionFilter } from './errors/api-exception.filter.js';
import { HealthModule } from './health/health.module.js';
import { LoggingModule } from './logging/logging.module.js';
import { ObservabilityModule } from './observability/error-reporter.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { KitchenModule } from './kitchen/kitchen.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { FloorModule } from './floor/floor.module.js';
import { MenuModule } from './menu/menu.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { PrintingModule } from './printing/printing.module.js';
import { RestaurantModule } from './restaurant/restaurant.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { TlsModule } from './tls/tls.module.js';

/**
 * Root module. Feature modules (settings, floor, menu, orders, kitchen, billing, ...) are added here
 * by later work packages.
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
        SettingsModule,
        RestaurantModule,
        FloorModule,
        MenuModule,
        OrdersModule,
        PrintingModule,
        BillingModule,
        PaymentsModule,
        DayEndModule,
        ReportsModule,
        KitchenModule,
        DevicesModule,
        EventsModule,
        RealtimeModule,
        TlsModule,
        CloudModule,
        HealthModule,
      ],
      providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
    };
  }
}
