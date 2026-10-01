import { Module } from '@nestjs/common';
import { CloudModule } from '../cloud/cloud.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SystemController } from './system.controller.js';
import { SystemService } from './system.service.js';

/** The System page (P4-04): versions, services, storage, devices and the update on offer. */
@Module({
  imports: [SettingsModule, CloudModule, RealtimeModule],
  controllers: [SystemController],
  providers: [SystemService],
})
export class SystemModule {}
