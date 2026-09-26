import { Module } from '@nestjs/common';
import { MenuAdminController } from './menu-admin.controller.js';
import { MenuAdminService } from './menu-admin.service.js';

/** The menu (P1-03): the draft managers edit. */
@Module({
  controllers: [MenuAdminController],
  providers: [MenuAdminService],
  exports: [MenuAdminService],
})
export class MenuModule {}
