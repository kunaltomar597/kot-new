import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { OrderDrillDownService } from './order-drill-down.service.js';
import { ReportDocumentsService } from './report-documents.service.js';
import { ReportExportService } from './report-export.service.js';
import { ReportSuiteService } from './report-suite.service.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';
import {
  DAILY_REPORT_OPTIONS,
  DEFAULT_DAILY_REPORT_OPTIONS,
  SuspiciousActivityJob,
  TEST_DAILY_REPORT_OPTIONS,
} from './suspicious-activity.job.js';
import { SuspiciousActivityService } from './suspicious-activity.service.js';

/**
 * Reports (P1-13, P4-05 to P4-07): reports, exports, the order drill-down and the suspicious-activity
 * report with its daily job.
 */
@Module({
  imports: [SettingsModule, NotificationsModule],
  controllers: [ReportsController],
  providers: [
    ReportsService,
    ReportSuiteService,
    ReportDocumentsService,
    ReportExportService,
    OrderDrillDownService,
    SuspiciousActivityService,
    SuspiciousActivityJob,
    {
      provide: DAILY_REPORT_OPTIONS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        config.nodeEnv === 'test' ? TEST_DAILY_REPORT_OPTIONS : DEFAULT_DAILY_REPORT_OPTIONS,
    },
  ],
  exports: [ReportsService, SuspiciousActivityService],
})
export class ReportsModule {}
