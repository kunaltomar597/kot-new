import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { EventsModule } from '../events/events.module.js';
import { KotTicketsService } from './kot-tickets.service.js';
import {
  DEFAULT_PRINT_QUEUE_OPTIONS,
  PRINT_QUEUE_OPTIONS,
  PrintQueueService,
  TEST_PRINT_QUEUE_OPTIONS,
} from './print-queue.service.js';
import { PrinterStatusService } from './printer-status.service.js';
import { NetworkAndUsbTransport, PrinterTransport } from './printer-transport.js';
import {
  KotsController,
  PrintersController,
  PrintQueueController,
  StationsController,
} from './printing.controller.js';
import { PrintersService } from './printers.service.js';
import { StationsService } from './stations.service.js';

/** Stations, printers and kitchen tickets on paper (P1-07): setup, rendering and the queue. */
@Module({
  imports: [EventsModule],
  controllers: [StationsController, PrintersController, PrintQueueController, KotsController],
  providers: [
    StationsService,
    PrintersService,
    KotTicketsService,
    PrinterStatusService,
    PrintQueueService,
    { provide: PrinterTransport, useFactory: () => new NetworkAndUsbTransport() },
    {
      provide: PRINT_QUEUE_OPTIONS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        config.nodeEnv === 'test' ? TEST_PRINT_QUEUE_OPTIONS : DEFAULT_PRINT_QUEUE_OPTIONS,
    },
  ],
  exports: [
    StationsService,
    PrintersService,
    KotTicketsService,
    PrintQueueService,
    PrinterTransport,
  ],
})
export class PrintingModule {}
