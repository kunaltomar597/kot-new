import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { BillsController, InvoicesController } from './billing.controller.js';
import { BillsService } from './bills.service.js';
import { InvoicesService } from './invoices.service.js';

/** Bills and GST invoices (P1-10). */
@Module({
  imports: [AuthModule, SettingsModule],
  controllers: [BillsController, InvoicesController],
  providers: [BillsService, InvoicesService],
  exports: [BillsService, InvoicesService],
})
export class BillingModule {}
