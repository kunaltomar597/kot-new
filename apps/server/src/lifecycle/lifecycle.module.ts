import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { ArchiveController } from './archive.controller.js';
import { ArchiveService } from './archive.service.js';
import { ArchiveViewerService } from './archive-viewer.service.js';
import { DataExportController } from './data-export.controller.js';
import { DataExportService } from './data-export.service.js';
import {
  DEFAULT_RETENTION_OPTIONS,
  RETENTION_OPTIONS,
  RetentionService,
} from './retention.service.js';

/**
 * The data lifecycle (P7-06): the automatic retention of BRD §9.3 (P7-06a) and archive-then-purge
 * (P7-06b).
 */
@Module({
  imports: [AuthModule, SettingsModule],
  controllers: [ArchiveController, DataExportController],
  providers: [
    RetentionService,
    ArchiveService,
    ArchiveViewerService,
    DataExportService,
    { provide: RETENTION_OPTIONS, useValue: DEFAULT_RETENTION_OPTIONS },
  ],
  exports: [RetentionService, ArchiveService, ArchiveViewerService, DataExportService],
})
export class LifecycleModule {}
