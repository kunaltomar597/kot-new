import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module.js';
import { KdsController } from './kds.controller.js';
import { KdsService } from './kds.service.js';

/** The kitchen display's server side (P1-09a). */
@Module({
  imports: [SettingsModule],
  controllers: [KdsController],
  providers: [KdsService],
})
export class KitchenModule {}
