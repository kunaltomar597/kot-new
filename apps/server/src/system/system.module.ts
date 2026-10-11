import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CloudModule } from '../cloud/cloud.module.js';
import { DevicesModule } from '../devices/devices.module.js';
import { PagersModule } from '../pagers/pagers.module.js';
import { PrintingModule } from '../printing/printing.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { StorageUsage } from './storage-usage.js';
import { SystemController } from './system.controller.js';
import { SystemService } from './system.service.js';

/** The System page (P4-04b): the support screen, "Install now" and diagnostics. */
@Module({
  imports: [AuthModule, CloudModule, DevicesModule, PagersModule, PrintingModule, SettingsModule],
  controllers: [SystemController],
  providers: [SystemService, StorageUsage],
})
export class SystemModule {}
