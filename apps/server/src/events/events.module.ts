import { Module } from '@nestjs/common';
import { DEFAULT_EVENT_BUS_OPTIONS, EVENT_BUS_OPTIONS, EventBus } from './event-bus.js';

/**
 * Domain events inside the server (P0-12): the outbox dispatcher and in-process bus. Producers
 * need nothing from here (they call `appendEvent` in their transaction); modules that react to
 * events import this module and subscribe to `EventBus`.
 */
@Module({
  providers: [{ provide: EVENT_BUS_OPTIONS, useValue: DEFAULT_EVENT_BUS_OPTIONS }, EventBus],
  exports: [EventBus],
})
export class EventsModule {}
