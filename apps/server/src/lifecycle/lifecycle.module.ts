import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module.js';
import {
  DEFAULT_RETENTION_OPTIONS,
  RETENTION_OPTIONS,
  RetentionService,
} from './retention.service.js';

/** The data lifecycle (P7-06): the automatic retention of BRD §9.3 (P7-06a). */
@Module({
  imports: [SettingsModule],
  providers: [
    RetentionService,
    { provide: RETENTION_OPTIONS, useValue: DEFAULT_RETENTION_OPTIONS },
  ],
  exports: [RetentionService],
})
export class LifecycleModule {}
