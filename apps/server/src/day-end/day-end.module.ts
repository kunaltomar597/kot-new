import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module.js';
import { DayEndController } from './day-end.controller.js';
import { DayEndService } from './day-end.service.js';

/** Day-end and the Z-report (P1-11b). */
@Module({
  imports: [PaymentsModule],
  controllers: [DayEndController],
  providers: [DayEndService],
  exports: [DayEndService],
})
export class DayEndModule {}
