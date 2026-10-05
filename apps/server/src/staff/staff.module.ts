import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PagersModule } from '../pagers/pagers.module.js';
import { RolesController } from './roles.controller.js';
import { RolesService } from './roles.service.js';
import { StaffController } from './staff.controller.js';
import { StaffService } from './staff.service.js';

/**
 * Staff administration: people, roles, PINs, deactivation (P4-02a, MGR-004) and custom roles
 * (P4-02e, AUTH-012).
 */
@Module({
  imports: [AuthModule, PagersModule],
  controllers: [StaffController, RolesController],
  providers: [StaffService, RolesService],
})
export class StaffModule {}
