import { Module } from '@nestjs/common';
import { MenuModule } from '../menu/menu.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { OrderItemsService } from './order-items.service.js';
import { OrderItemsController, OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

/** The order engine (P1-06): submission, KOTs, and item status (P1-06b). */
@Module({
  imports: [MenuModule, SettingsModule],
  controllers: [OrdersController, OrderItemsController],
  providers: [OrdersService, OrderItemsService],
  exports: [OrdersService, OrderItemsService],
})
export class OrdersModule {}
