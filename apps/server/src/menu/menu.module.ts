import { Module } from '@nestjs/common';
import { MenuAdminController } from './menu-admin.controller.js';
import { MenuAdminService } from './menu-admin.service.js';
import { MenuPublishController } from './menu-publish.controller.js';
import { MenuPublishService } from './menu-publish.service.js';
import { SettingsModule } from '../settings/settings.module.js';

/** The menu (P1-03): the draft managers edit, combos, availability and published versions. */
@Module({
  imports: [SettingsModule],
  controllers: [MenuAdminController, MenuPublishController],
  providers: [MenuAdminService, MenuPublishService],
  exports: [MenuAdminService, MenuPublishService],
})
export class MenuModule {}
