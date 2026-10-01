import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { EventsModule } from '../events/events.module.js';
import { MenuModule } from '../menu/menu.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { PhotosModule } from '../photos/photos.module.js';
import { RecommendationsModule } from '../recommendations/recommendations.module.js';
import { ServiceRequestsModule } from '../service-requests/service-requests.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import {
  DEFAULT_RELAY_ORDERS_OPTIONS,
  RELAY_ORDERS_OPTIONS,
  RelayOrdersService,
} from './relay-orders.service.js';
import {
  DEFAULT_RELAY_SYNC_OPTIONS,
  RELAY_SYNC_OPTIONS,
  RelaySyncService,
} from './relay-sync.service.js';

/** The local server's link to the QR relay (P5-03, ADR-0015). */
@Module({
  imports: [
    AuthModule,
    EventsModule,
    MenuModule,
    OrdersModule,
    PhotosModule,
    RecommendationsModule,
    ServiceRequestsModule,
    SettingsModule,
  ],
  providers: [
    { provide: RELAY_SYNC_OPTIONS, useValue: DEFAULT_RELAY_SYNC_OPTIONS },
    { provide: RELAY_ORDERS_OPTIONS, useValue: DEFAULT_RELAY_ORDERS_OPTIONS },
    RelaySyncService,
    RelayOrdersService,
  ],
  exports: [RelaySyncService, RelayOrdersService],
})
export class RelayModule {}
