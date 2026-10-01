import { Module } from '@nestjs/common';
import { OrderDrillDownService } from './order-drill-down.service.js';
import { ReportExportService } from './report-export.service.js';
import { ReportSuiteService } from './report-suite.service.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

/** Reports (P1-13, P4-05): reports, CSV export and the order drill-down. */
@Module({
  controllers: [ReportsController],
  providers: [ReportsService, ReportSuiteService, ReportExportService, OrderDrillDownService],
  exports: [ReportsService],
})
export class ReportsModule {}
