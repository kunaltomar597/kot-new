import { Module } from '@nestjs/common';
import { CloudModule } from '../cloud/cloud.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { RelayModule } from '../relay/relay.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { UpdatesModule } from '../updates/updates.module.js';
import { DiagnosticsService } from './diagnostics.service.js';
import { SystemController } from './system.controller.js';
import { SystemService } from './system.service.js';
import { VendorSettingsAgent } from './vendor-settings.agent.js';

/**
 * The System page (P4-04): versions, services, storage, devices and the update on offer, and
 * "Send diagnostics to support" (UPD-008, P7-08a).
 */
@Module({
  imports: [
    SettingsModule,
    CloudModule,
    RelayModule,
    RealtimeModule,
    NotificationsModule,
    UpdatesModule,
  ],
  controllers: [SystemController],
  providers: [SystemService, DiagnosticsService, VendorSettingsAgent],
})
export class SystemModule {}
