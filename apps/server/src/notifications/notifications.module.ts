import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import {
  DEFAULT_NOTIFICATION_OPTIONS,
  NOTIFICATION_CLOCK,
  NOTIFICATION_OPTIONS,
  SYSTEM_CLOCK,
} from './clock.js';
import { NotificationTriggers } from './notification-triggers.js';
import { BreakController, NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { PRESENCE, PresenceRegistry } from './presence.js';
import { SystemAlerts } from './system-alerts.js';

/** The notification and escalation engine (P2-03, NTF-001 to NTF-007). */
@Module({
  imports: [EventsModule, RealtimeModule, SettingsModule],
  controllers: [NotificationsController, BreakController],
  providers: [
    { provide: NOTIFICATION_CLOCK, useValue: SYSTEM_CLOCK },
    { provide: NOTIFICATION_OPTIONS, useValue: DEFAULT_NOTIFICATION_OPTIONS },
    {
      provide: PresenceRegistry,
      inject: [RealtimeGateway],
      useFactory: (gateway: RealtimeGateway): PresenceRegistry => {
        const registry = new PresenceRegistry();
        registry.add((restaurantId, staffId) => gateway.isStaffConnected(restaurantId, staffId));
        return registry;
      },
    },
    { provide: PRESENCE, useExisting: PresenceRegistry },
    NotificationsService,
    NotificationTriggers,
    SystemAlerts,
  ],
  exports: [NotificationsService, PresenceRegistry, NOTIFICATION_CLOCK],
})
export class NotificationsModule {}
