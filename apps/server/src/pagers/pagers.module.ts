import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { TlsModule } from '../tls/tls.module.js';
import { DEFAULT_PAGER_OPTIONS, PAGER_OPTIONS, PagerBroker } from './pager-broker.js';
import { PagersController } from './pagers.controller.js';
import { PagersService } from './pagers.service.js';

/** Wrist pagers: the MQTT broker and pager administration (P2-04). */
@Module({
  imports: [EventsModule, NotificationsModule, TlsModule],
  controllers: [PagersController],
  providers: [
    { provide: PAGER_OPTIONS, useValue: DEFAULT_PAGER_OPTIONS },
    PagerBroker,
    PagersService,
  ],
  exports: [PagerBroker],
})
export class PagersModule {}
