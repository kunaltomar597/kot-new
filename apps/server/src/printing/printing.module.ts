import { Module } from '@nestjs/common';
import { KotTicketsService } from './kot-tickets.service.js';
import { NetworkAndUsbTransport, PrinterTransport } from './printer-transport.js';
import { PrintersController, StationsController } from './printing.controller.js';
import { PrintersService } from './printers.service.js';
import { StationsService } from './stations.service.js';

/** Stations, printers and kitchen tickets on paper (P1-07a). */
@Module({
  controllers: [StationsController, PrintersController],
  providers: [
    StationsService,
    PrintersService,
    KotTicketsService,
    { provide: PrinterTransport, useFactory: () => new NetworkAndUsbTransport() },
  ],
  exports: [StationsService, PrintersService, KotTicketsService, PrinterTransport],
})
export class PrintingModule {}
