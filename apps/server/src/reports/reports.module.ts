import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

/** Core reports v1 (P1-13). */
@Module({
  imports: [PaymentsModule],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
