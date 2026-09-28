import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PagersModule } from '../pagers/pagers.module.js';
import { StaffController } from './staff.controller.js';
import { StaffService } from './staff.service.js';

/** Staff administration: people, roles, PINs, deactivation (P4-02a, MGR-004). */
@Module({
  imports: [AuthModule, PagersModule],
  controllers: [StaffController],
  providers: [StaffService],
})
export class StaffModule {}
