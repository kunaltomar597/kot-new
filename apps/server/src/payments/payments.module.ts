import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module.js';
import { InvoicePaymentsController, ShiftsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { ShiftsService } from './shifts.service.js';

/** Shifts, cash and payments (P1-11a). */
@Module({
  imports: [SettingsModule],
  controllers: [ShiftsController, InvoicePaymentsController],
  providers: [ShiftsService, PaymentsService],
  exports: [ShiftsService, PaymentsService],
})
export class PaymentsModule {}
