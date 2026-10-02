import { AiMenuImportService } from './import/ai-menu-import.service.js';
import { AiMenuImportController, MenuImportController } from './import/menu-import.controller.js';
import { MenuImportService } from './import/menu-import.service.js';
import { Module } from '@nestjs/common';
import { MenuAdminController } from './menu-admin.controller.js';
import { MenuAdminService } from './menu-admin.service.js';
import { MenuPublishController } from './menu-publish.controller.js';
import { MenuPublishService } from './menu-publish.service.js';
import { CloudModule } from '../cloud/cloud.module.js';
import { SettingsModule } from '../settings/settings.module.js';

/** The menu (P1-03): the draft managers edit, combos, availability and published versions. */
@Module({
  imports: [SettingsModule, CloudModule],
  controllers: [
    MenuAdminController,
    MenuPublishController,
    MenuImportController,
    AiMenuImportController,
  ],
  providers: [MenuAdminService, MenuPublishService, MenuImportService, AiMenuImportService],
  exports: [MenuAdminService, MenuPublishService],
})
export class MenuModule {}
