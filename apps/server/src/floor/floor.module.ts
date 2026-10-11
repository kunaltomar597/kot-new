import { Module } from '@nestjs/common';
import { LicensingModule } from '../licensing/licensing.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import {
  FloorController,
  SectionsController,
  TablesController,
  WaiterAssignmentsController,
} from './floor.controller.js';
import { FloorService } from './floor.service.js';
import { TableQrController } from './table-qr.controller.js';
import { TableQrService } from './table-qr.service.js';
import { TableSessionsController } from './table-sessions.controller.js';
import { TableSessionsService } from './table-sessions.service.js';
import { TableTransfersService } from './table-transfers.service.js';
import { WaiterAssignmentsService } from './waiter-assignments.service.js';

/** The floor (P1-02a): sections, tables and the day's waiter assignment. */
@Module({
  imports: [SettingsModule, LicensingModule],
  controllers: [
    FloorController,
    SectionsController,
    // Before TablesController, so `qr-codes` is never read as a table id.
    TableQrController,
    TablesController,
    WaiterAssignmentsController,
    TableSessionsController,
  ],
  providers: [
    FloorService,
    WaiterAssignmentsService,
    TableSessionsService,
    TableTransfersService,
    TableQrService,
  ],
  exports: [FloorService, WaiterAssignmentsService, TableSessionsService],
})
export class FloorModule {}
