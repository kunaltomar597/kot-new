import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module.js';
import { OrderDrillDownService } from './order-drill-down.service.js';
import { ReportExportService } from './report-export.service.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

/** Core reports v1 (P1-13): reports, CSV export and the order drill-down. */
@Module({
  imports: [PaymentsModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportExportService, OrderDrillDownService],
  exports: [ReportsService],
})
export class ReportsModule {}
