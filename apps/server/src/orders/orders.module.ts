import { Module } from '@nestjs/common';
import { LicensingModule } from '../licensing/licensing.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { MenuModule } from '../menu/menu.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { OrderApprovalsService } from './order-approvals.service.js';
import { OrderFeedService } from './order-feed.service.js';
import { OrderItemsService } from './order-items.service.js';
import {
  OrderFeedController,
  OrderItemsController,
  OrdersController,
  SessionOrdersController,
  TabletOrdersController,
} from './orders.controller.js';
import { OrdersService } from './orders.service.js';

/**
 * The order engine (P1-06): submission, KOTs, item status (P1-06b), the live feed (P4-01), and
 * diners' orders with their approval (P3-03a).
 */
@Module({
  imports: [AuthModule, MenuModule, SettingsModule, LicensingModule],
  controllers: [
    OrdersController,
    SessionOrdersController,
    OrderItemsController,
    OrderFeedController,
    TabletOrdersController,
  ],
  providers: [OrdersService, OrderItemsService, OrderFeedService, OrderApprovalsService],
  exports: [OrdersService, OrderItemsService],
})
export class OrdersModule {}
