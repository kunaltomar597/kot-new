import { Module } from '@nestjs/common';
import { PrintingModule } from '../printing/printing.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { CashDrawerService } from './cash-drawer.service.js';
import {
  CashDrawerController,
  InvoicePaymentsController,
  ShiftsController,
} from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { ShiftsService } from './shifts.service.js';

/** Shifts, cash, payments (P1-11a) and the cash drawer (P4-07b). */
@Module({
  imports: [SettingsModule, PrintingModule],
  controllers: [ShiftsController, InvoicePaymentsController, CashDrawerController],
  providers: [ShiftsService, PaymentsService, CashDrawerService],
  exports: [ShiftsService, PaymentsService],
})
export class PaymentsModule {}
