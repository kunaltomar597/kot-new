import { Module } from '@nestjs/common';
import { MenuModule } from '../menu/menu.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { OrderFeedService } from './order-feed.service.js';
import { OrderItemsService } from './order-items.service.js';
import {
  OrderFeedController,
  OrderItemsController,
  OrdersController,
  SessionOrdersController,
} from './orders.controller.js';
import { OrdersService } from './orders.service.js';

/** The order engine (P1-06): submission, KOTs, item status (P1-06b) and the live feed (P4-01). */
@Module({
  imports: [MenuModule, SettingsModule],
  controllers: [
    OrdersController,
    SessionOrdersController,
    OrderItemsController,
    OrderFeedController,
  ],
  providers: [OrdersService, OrderItemsService, OrderFeedService],
  exports: [OrdersService, OrderItemsService],
})
export class OrdersModule {}
