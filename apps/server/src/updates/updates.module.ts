import { Module } from '@nestjs/common';
import { BackupsModule } from '../backups/backups.module.js';
import { CloudModule } from '../cloud/cloud.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import {
  DEFAULT_UPDATE_AGENT_OPTIONS,
  UPDATE_AGENT_OPTIONS,
  UpdateAgentService,
} from './update-agent.service.js';

/**
 * The update agent on the restaurant PC (UPD-004, UPD-005, UPD-007, P7-04c): downloads and checks
 * the release on offer, waits for the maintenance window or "Install now", backs up and hands the
 * update to the updater, then records and reports how it went.
 */
@Module({
  imports: [SettingsModule, CloudModule, BackupsModule],
  providers: [
    UpdateAgentService,
    { provide: UPDATE_AGENT_OPTIONS, useValue: DEFAULT_UPDATE_AGENT_OPTIONS },
  ],
  exports: [UpdateAgentService],
})
export class UpdatesModule {}
