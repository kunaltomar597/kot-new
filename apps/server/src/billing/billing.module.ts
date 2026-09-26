import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrintingModule } from '../printing/printing.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { BillsController, InvoicesController } from './billing.controller.js';
import { BillsService } from './bills.service.js';
import { InvoiceActionsService } from './invoice-actions.service.js';
import { InvoicesService } from './invoices.service.js';

/** Bills and GST invoices (P1-10). */
@Module({
  imports: [AuthModule, SettingsModule, PrintingModule],
  controllers: [BillsController, InvoicesController],
  providers: [BillsService, InvoicesService, InvoiceActionsService],
  exports: [BillsService, InvoicesService],
})
export class BillingModule {}
