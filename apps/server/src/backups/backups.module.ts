import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ServerLifecycle } from '../common/server-lifecycle.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { BackupController } from './backup.controller.js';
import { BACKUP_OPTIONS, BackupService, DEFAULT_BACKUP_OPTIONS } from './backup.service.js';

/** Encrypted local backups (P7-05a, DATA-002, DATA-005) and restore (P7-05b, DATA-004). */
@Module({
  imports: [AuthModule, SettingsModule, NotificationsModule],
  controllers: [BackupController],
  providers: [
    BackupService,
    ServerLifecycle,
    { provide: BACKUP_OPTIONS, useValue: DEFAULT_BACKUP_OPTIONS },
  ],
  exports: [BackupService, ServerLifecycle],
})
export class BackupsModule {}
