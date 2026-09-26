import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import {
  FloorArchiveRequest,
  type FloorResponse,
  SectionParams,
  SectionRequest,
  type SectionView,
  TableParams,
  TableRequest,
  type TableView,
  UpdateWaiterAssignmentsRequest,
  type WaiterAssignmentsResponse,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability, RequireSession } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { FloorService } from './floor.service.js';
import { WaiterAssignmentsService } from './waiter-assignments.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/** The whole floor for any signed-in person (P1-02a, TBL-001). */
@Controller('floor')
export class FloorController {
  constructor(private readonly floor: FloorService) {}

  @Get()
  @RequireSession()
  async get(@Req() request: AuthenticatedRequest): Promise<FloorResponse> {
    return { sections: await this.floor.floor(principalOf(request).restaurantId) };
  }
}

/** Sections (TBL-001); managers and the Owner (BRD §4.2 "manage staff, sections"). */
@Controller('sections')
export class SectionsController {
  constructor(private readonly floor: FloorService) {}

  @Post()
  @RequireCapability('STAFF_MANAGE')
  create(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(SectionRequest)) body: SectionRequest,
  ): Promise<SectionView> {
    return this.floor.createSection(principalOf(request), body);
  }

  @Put(':sectionId')
  @RequireCapability('STAFF_MANAGE')
  update(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(SectionParams)) params: SectionParams,
    @Body(new ZodValidationPipe(SectionRequest)) body: SectionRequest,
  ): Promise<SectionView> {
    return this.floor.updateSection(principalOf(request), params.sectionId, body);
  }

  @Post(':sectionId/archive')
  @HttpCode(200)
  @RequireCapability('STAFF_MANAGE')
  archive(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(SectionParams)) params: SectionParams,
    @Body(new ZodValidationPipe(FloorArchiveRequest)) body: FloorArchiveRequest,
  ): Promise<SectionView> {
    return this.floor.archiveSection(principalOf(request), params.sectionId, body.reason);
  }

  @Post(':sectionId/restore')
  @HttpCode(200)
  @RequireCapability('STAFF_MANAGE')
  restore(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(SectionParams)) params: SectionParams,
  ): Promise<SectionView> {
    return this.floor.restoreSection(principalOf(request), params.sectionId);
  }
}

/** Tables (TBL-001); managers and the Owner. */
@Controller('tables')
export class TablesController {
  constructor(private readonly floor: FloorService) {}

  @Post()
  @RequireCapability('STAFF_MANAGE')
  create(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(TableRequest)) body: TableRequest,
  ): Promise<TableView> {
    return this.floor.createTable(principalOf(request), body);
  }

  @Put(':tableId')
  @RequireCapability('STAFF_MANAGE')
  update(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(TableParams)) params: TableParams,
    @Body(new ZodValidationPipe(TableRequest)) body: TableRequest,
  ): Promise<TableView> {
    return this.floor.updateTable(principalOf(request), params.tableId, body);
  }

  @Post(':tableId/archive')
  @HttpCode(200)
  @RequireCapability('STAFF_MANAGE')
  archive(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(TableParams)) params: TableParams,
    @Body(new ZodValidationPipe(FloorArchiveRequest)) body: FloorArchiveRequest,
  ): Promise<TableView> {
    return this.floor.archiveTable(principalOf(request), params.tableId, body.reason);
  }

  @Post(':tableId/restore')
  @HttpCode(200)
  @RequireCapability('STAFF_MANAGE')
  restore(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(TableParams)) params: TableParams,
  ): Promise<TableView> {
    return this.floor.restoreTable(principalOf(request), params.tableId);
  }
}

/** The day's waiter assignment (TBL-002); waiters read it for "My tables" (WTR-002). */
@Controller('waiter-assignments')
export class WaiterAssignmentsController {
  constructor(private readonly assignments: WaiterAssignmentsService) {}

  @Get()
  @RequireSession()
  get(@Req() request: AuthenticatedRequest): Promise<WaiterAssignmentsResponse> {
    return this.assignments.get(principalOf(request).restaurantId);
  }

  @Put()
  @RequireCapability('STAFF_MANAGE')
  update(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(UpdateWaiterAssignmentsRequest))
    body: UpdateWaiterAssignmentsRequest,
  ): Promise<WaiterAssignmentsResponse> {
    return this.assignments.update(principalOf(request), body);
  }
}
