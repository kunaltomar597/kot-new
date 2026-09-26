import { Module } from '@nestjs/common';
import {
  FloorController,
  SectionsController,
  TablesController,
  WaiterAssignmentsController,
} from './floor.controller.js';
import { FloorService } from './floor.service.js';
import { WaiterAssignmentsService } from './waiter-assignments.service.js';

/** The floor (P1-02a): sections, tables and the day's waiter assignment. */
@Module({
  controllers: [FloorController, SectionsController, TablesController, WaiterAssignmentsController],
  providers: [FloorService, WaiterAssignmentsService],
  exports: [FloorService, WaiterAssignmentsService],
})
export class FloorModule {}
