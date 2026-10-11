import { Module } from '@nestjs/common';
import { LicensingModule } from '../licensing/licensing.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { TlsModule } from '../tls/tls.module.js';
import {
  DEFAULT_PRESENCE_OPTIONS,
  DevicePresenceMonitor,
  PRESENCE_OPTIONS,
  TEST_PRESENCE_OPTIONS,
} from './device-presence.monitor.js';
import { DevicesController } from './devices.controller.js';
import { DevicesService } from './devices.service.js';
import { TabletController } from './tablet.controller.js';
import { TabletService } from './tablet.service.js';

/**
 * Device pairing and management (AUTH-007 to AUTH-009), what devices report about themselves and
 * whether they are connected (TAB-015), and the table tablet's own table and kiosk exit (P3-01a).
 */
@Module({
  imports: [AuthModule, TlsModule, RealtimeModule, SettingsModule, LicensingModule],
  controllers: [DevicesController, TabletController],
  providers: [
    DevicesService,
    TabletService,
    DevicePresenceMonitor,
    {
      provide: PRESENCE_OPTIONS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        config.nodeEnv === 'test' ? TEST_PRESENCE_OPTIONS : DEFAULT_PRESENCE_OPTIONS,
    },
  ],
  exports: [DevicesService],
})
export class DevicesModule {}
