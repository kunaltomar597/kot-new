import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DomainEvent } from '@rp/contracts';
import { newId } from '../common/ids.js';
import type { TransactionClient } from '../database/prisma.service.js';
import { EventBus } from '../events/event-bus.js';

/**
 * Counts suggestions that were ordered (REC-008): an order line sent with the suggestion it was
 * added from (`recommendation` on the line) becomes one ORDERED event for its layer and item, on
 * the channel it was ordered from. The report reads the line's quantity, value and final state
 * (RPT-012), so a line rejected or voided later is not counted as revenue. A durable consumer:
 * a restart misses no order, and each line is counted once (a unique order line per event).
 */
@Injectable()
export class RecommendationOrders implements OnModuleInit {
  constructor(private readonly bus: EventBus) {}

  onModuleInit(): void {
    this.bus.subscribe({
      name: 'recommendations.ordered',
      types: ['OrderSubmitted'],
      handle: (event, context) => this.handle(event, context.tx),
    });
  }

  async handle(event: DomainEvent, tx: TransactionClient): Promise<void> {
    if (event.type !== 'OrderSubmitted') return;
    const order = await tx.order.findUnique({
      where: { id: event.payload.orderId },
      select: {
        restaurantId: true,
        businessDate: true,
        source: true,
        tableSessionId: true,
        deviceId: true,
        createdById: true,
        items: {
          where: { recommendationLayer: { not: null }, parentOrderItemId: null },
          select: { id: true, itemId: true, recommendationLayer: true, recommendationRuleId: true },
        },
      },
    });
    if (order === null || order.items.length === 0) return;
    await tx.recommendationEvent.createMany({
      data: order.items.flatMap((line) =>
        line.recommendationLayer === null
          ? []
          : [
              {
                id: newId(),
                restaurantId: order.restaurantId,
                businessDate: order.businessDate,
                kind: 'ORDERED' as const,
                layer: line.recommendationLayer,
                itemId: line.itemId,
                ruleId: line.recommendationRuleId,
                channel: order.source,
                tableSessionId: order.tableSessionId,
                orderItemId: line.id,
                deviceId: order.deviceId,
                staffId: order.createdById,
              },
            ],
      ),
      skipDuplicates: true,
    });
  }
}
