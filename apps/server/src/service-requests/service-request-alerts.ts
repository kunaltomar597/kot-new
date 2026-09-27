import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DomainEvent } from '@rp/contracts';
import type { TransactionClient } from '../database/prisma.service.js';
import { EventBus } from '../events/event-bus.js';
import { ServiceRequestsService } from './service-requests.service.js';

/**
 * Keeps each service request in step with its alert and its table (P2-06d, INT-001: this module
 * hears the notification engine's events, it does not read its tables):
 * - the alert acknowledged on a pager, a phone or the POS: the request is acknowledged (NTF-004);
 * - the alert escalated to the managers: the request is escalated (NTF-005);
 * - the table closed: its open requests end as the tablet's Cancel would end them.
 * A durable consumer, so a restart misses none of them.
 */
@Injectable()
export class ServiceRequestAlerts implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly requests: ServiceRequestsService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe({
      name: 'service-requests.alerts',
      types: ['AlertAcknowledged', 'AlertEscalated', 'TableClosed'],
      handle: (event, context) => this.handle(event, context.tx),
    });
  }

  async handle(event: DomainEvent, tx: TransactionClient): Promise<void> {
    switch (event.type) {
      case 'AlertAcknowledged':
        await this.requests.alertAcknowledged(
          tx,
          event.payload.alertId,
          event.payload.acknowledgedBy,
        );
        return;
      case 'AlertEscalated':
        await this.requests.alertEscalated(tx, event.payload.alertId);
        return;
      case 'TableClosed':
        await this.requests.tableClosed(tx, event.payload.tableSessionId);
        return;
      default:
        return;
    }
  }
}
