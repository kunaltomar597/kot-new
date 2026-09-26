import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import {
  KotParams,
  KotReprintRequest,
  type PrinterListResponse,
  PrinterRedirectRequest,
  PrinterRequest,
  type PrinterView,
  PrintingArchiveRequest,
  PrintingParams,
  type PrintQueueResponse,
  type StationListResponse,
  StationRequest,
  type StationView,
  type TestPrintResponse,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability, RequireSession } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { PrintQueueService } from './print-queue.service.js';
import { PrintersService } from './printers.service.js';
import { StationsService } from './stations.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/** Kitchen stations (P1-07a, KDS-002, KDS-008); managers and the Owner change them. */
@Controller('stations')
export class StationsController {
  constructor(private readonly stations: StationsService) {}

  @Get()
  @RequireSession()
  async list(@Req() request: AuthenticatedRequest): Promise<StationListResponse> {
    return { stations: await this.stations.list(principalOf(request).restaurantId) };
  }

  @Post()
  @RequireCapability('OPERATIONS_CONFIGURE')
  create(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(StationRequest)) body: StationRequest,
  ): Promise<StationView> {
    return this.stations.create(principalOf(request), body);
  }

  @Put(':id')
  @RequireCapability('OPERATIONS_CONFIGURE')
  update(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(PrintingParams)) params: PrintingParams,
    @Body(new ZodValidationPipe(StationRequest)) body: StationRequest,
  ): Promise<StationView> {
    return this.stations.update(principalOf(request), params.id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequireCapability('OPERATIONS_CONFIGURE')
  archive(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(PrintingParams)) params: PrintingParams,
    @Body(new ZodValidationPipe(PrintingArchiveRequest)) body: PrintingArchiveRequest,
  ): Promise<StationView> {
    return this.stations.archive(principalOf(request), params.id, body.reason);
  }
}

/** Printers and the setup test page (P1-07a, KDS-008, ONB-004 step 6). */
@Controller('printers')
export class PrintersController {
  constructor(private readonly printers: PrintersService) {}

  @Get()
  @RequireCapability('OPERATIONS_CONFIGURE')
  async list(@Req() request: AuthenticatedRequest): Promise<PrinterListResponse> {
    return { printers: await this.printers.list(principalOf(request).restaurantId) };
  }

  @Post()
  @RequireCapability('OPERATIONS_CONFIGURE')
  create(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(PrinterRequest)) body: PrinterRequest,
  ): Promise<PrinterView> {
    return this.printers.create(principalOf(request), body);
  }

  @Put(':id')
  @RequireCapability('OPERATIONS_CONFIGURE')
  update(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(PrintingParams)) params: PrintingParams,
    @Body(new ZodValidationPipe(PrinterRequest)) body: PrinterRequest,
  ): Promise<PrinterView> {
    return this.printers.update(principalOf(request), params.id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequireCapability('OPERATIONS_CONFIGURE')
  archive(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(PrintingParams)) params: PrintingParams,
    @Body(new ZodValidationPipe(PrintingArchiveRequest)) body: PrintingArchiveRequest,
  ): Promise<PrinterView> {
    return this.printers.archive(principalOf(request), params.id, body.reason);
  }

  @Post(':id/redirect')
  @HttpCode(200)
  @RequireCapability('OPERATIONS_CONFIGURE')
  redirect(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(PrintingParams)) params: PrintingParams,
    @Body(new ZodValidationPipe(PrinterRedirectRequest)) body: PrinterRedirectRequest,
  ): Promise<PrinterView> {
    return this.printers.redirect(principalOf(request), params.id, body.toPrinterId, body.reason);
  }

  @Post(':id/test')
  @HttpCode(200)
  @RequireCapability('OPERATIONS_CONFIGURE')
  test(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(PrintingParams)) params: PrintingParams,
  ): Promise<TestPrintResponse> {
    return this.printers.testPrint(principalOf(request), params.id);
  }
}

/** The print queue as the POS sees it (P1-07b, KDS-008, NTF-003). */
@Controller('print-queue')
export class PrintQueueController {
  constructor(private readonly queue: PrintQueueService) {}

  @Get()
  @RequireCapability('BILL_PRINT_AND_PAYMENT')
  get(@Req() request: AuthenticatedRequest): Promise<PrintQueueResponse> {
    return this.queue.queue(principalOf(request).restaurantId);
  }
}

/** Kitchen tickets on paper (P1-07b, KDS-008). */
@Controller('kots')
export class KotsController {
  constructor(private readonly queue: PrintQueueService) {}

  @Post(':id/reprint')
  @HttpCode(200)
  @RequireCapability('ORDER_CREATE')
  reprint(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(KotParams)) params: KotParams,
    @Body(new ZodValidationPipe(KotReprintRequest)) body: KotReprintRequest,
  ): Promise<TestPrintResponse> {
    const parsed = KotReprintRequest.parse(body);
    return this.queue.reprint(principalOf(request), params.id, parsed);
  }
}
