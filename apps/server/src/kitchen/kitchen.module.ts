import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { KdsController } from './kds.controller.js';
import {
  DEFAULT_KDS_ESCALATION_OPTIONS,
  KDS_ESCALATION_OPTIONS,
  KdsEscalationService,
} from './kds-escalation.service.js';
import { KdsService } from './kds.service.js';

/** The kitchen display's server side (P1-09a), and escalating uncollected food (P6-05a). */
@Module({
  imports: [SettingsModule, NotificationsModule],
  controllers: [KdsController],
  providers: [
    KdsService,
    KdsEscalationService,
    { provide: KDS_ESCALATION_OPTIONS, useValue: DEFAULT_KDS_ESCALATION_OPTIONS },
  ],
})
export class KitchenModule {}
