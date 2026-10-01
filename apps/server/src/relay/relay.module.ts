import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { EventsModule } from '../events/events.module.js';
import { MenuModule } from '../menu/menu.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import {
  DEFAULT_RELAY_SYNC_OPTIONS,
  RELAY_SYNC_OPTIONS,
  RelaySyncService,
} from './relay-sync.service.js';

/** The local server's link to the QR relay (P5-03, ADR-0015). */
@Module({
  imports: [AuthModule, EventsModule, MenuModule, SettingsModule],
  providers: [
    { provide: RELAY_SYNC_OPTIONS, useValue: DEFAULT_RELAY_SYNC_OPTIONS },
    RelaySyncService,
  ],
  exports: [RelaySyncService],
})
export class RelayModule {}
