import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PagersModule } from '../pagers/pagers.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { TlsModule } from '../tls/tls.module.js';
import {
  DEFAULT_DEVICE_LIVENESS_OPTIONS,
  DEVICE_LIVENESS_OPTIONS,
  DeviceLiveness,
} from './device-liveness.js';
import { DevicesController } from './devices.controller.js';
import { DevicesService } from './devices.service.js';

/**
 * Device pairing and management (AUTH-007 to AUTH-009, MGR-006): whether a device is connected
 * comes from the live gateway and the pager broker; kitchen screens and table tablets that stay
 * away are announced offline (P4-04a, NTF-003).
 */
@Module({
  imports: [AuthModule, PagersModule, RealtimeModule, SettingsModule, TlsModule],
  controllers: [DevicesController],
  providers: [
    DevicesService,
    { provide: DEVICE_LIVENESS_OPTIONS, useValue: DEFAULT_DEVICE_LIVENESS_OPTIONS },
    DeviceLiveness,
  ],
  exports: [DevicesService],
})
export class DevicesModule {}
