import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { EventsModule } from '../events/events.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { ServiceRequestAlerts } from './service-request-alerts.js';
import {
  ServiceRequestsController,
  TabletServiceRequestsController,
} from './service-requests.controller.js';
import { ServiceRequestsService } from './service-requests.service.js';

/**
 * Service requests (P2-06d): Water, Waiter and Bill from the table tablet, their alerts, and the
 * waiter's inbox (TAB-004, WTR-005, BILL-015). The tablet's buttons come with P3-02, the QR page's
 * with P5.
 */
@Module({
  imports: [AuthModule, EventsModule, NotificationsModule, SettingsModule],
  controllers: [ServiceRequestsController, TabletServiceRequestsController],
  providers: [ServiceRequestsService, ServiceRequestAlerts],
  exports: [ServiceRequestsService],
})
export class ServiceRequestsModule {}
