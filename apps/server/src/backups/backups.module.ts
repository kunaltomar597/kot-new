import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ServerLifecycle } from '../common/server-lifecycle.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { BackupController } from './backup.controller.js';
import { BACKUP_OPTIONS, BackupService, DEFAULT_BACKUP_OPTIONS } from './backup.service.js';
import {
  CONTINUOUS_BACKUP_OPTIONS,
  ContinuousBackupService,
  DEFAULT_CONTINUOUS_BACKUP_OPTIONS,
} from './continuous-backup.service.js';

/**
 * Encrypted local backups (P7-05a, DATA-002, DATA-005), restore (P7-05b, DATA-004) and the
 * continuous backup with restore to a point in time (P7-05c).
 */
@Module({
  imports: [AuthModule, SettingsModule, NotificationsModule],
  controllers: [BackupController],
  providers: [
    BackupService,
    ContinuousBackupService,
    ServerLifecycle,
    { provide: BACKUP_OPTIONS, useValue: DEFAULT_BACKUP_OPTIONS },
    { provide: CONTINUOUS_BACKUP_OPTIONS, useValue: DEFAULT_CONTINUOUS_BACKUP_OPTIONS },
  ],
  exports: [BackupService, ContinuousBackupService, ServerLifecycle],
})
export class BackupsModule {}
