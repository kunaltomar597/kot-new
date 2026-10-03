import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CloudModule } from '../cloud/cloud.module.js';
import { ServerLifecycle } from '../common/server-lifecycle.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { BackupController } from './backup.controller.js';
import { BACKUP_OPTIONS, BackupService, DEFAULT_BACKUP_OPTIONS } from './backup.service.js';
import {
  CLOUD_BACKUP_OPTIONS,
  CloudBackupService,
  DEFAULT_CLOUD_BACKUP_OPTIONS,
} from './cloud-backup.service.js';
import {
  CONTINUOUS_BACKUP_OPTIONS,
  ContinuousBackupService,
  DEFAULT_CONTINUOUS_BACKUP_OPTIONS,
} from './continuous-backup.service.js';

/**
 * Encrypted local backups (P7-05a, DATA-002, DATA-005), restore (P7-05b, DATA-004), the
 * continuous backup with restore to a point in time (P7-05c) and the cloud backup (P7-05d,
 * DATA-003).
 */
@Module({
  imports: [AuthModule, SettingsModule, NotificationsModule, CloudModule],
  controllers: [BackupController],
  providers: [
    BackupService,
    ContinuousBackupService,
    CloudBackupService,
    ServerLifecycle,
    { provide: BACKUP_OPTIONS, useValue: DEFAULT_BACKUP_OPTIONS },
    { provide: CONTINUOUS_BACKUP_OPTIONS, useValue: DEFAULT_CONTINUOUS_BACKUP_OPTIONS },
    { provide: CLOUD_BACKUP_OPTIONS, useValue: DEFAULT_CLOUD_BACKUP_OPTIONS },
  ],
  exports: [BackupService, ContinuousBackupService, CloudBackupService, ServerLifecycle],
})
export class BackupsModule {}
