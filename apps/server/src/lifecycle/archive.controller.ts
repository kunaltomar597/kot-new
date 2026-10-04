import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  type ArchivedDaysResponse,
  type ArchivedInvoiceListResponse,
  ArchivedInvoiceParams,
  ArchivedInvoiceQuery,
  type ArchivedInvoiceResponse,
  ArchiveParams,
  type ArchiveRunView,
  type ArchivesResponse,
  StartArchiveRequest,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { ArchiveService } from './archive.service.js';
import { ArchiveViewerService } from './archive-viewer.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/**
 * Archives hold the whole restaurant's years: a cashier's reports on their own shifts (OWN, §4.2)
 * do not reach them.
 */
function wholeRestaurant(request: AuthenticatedRequest): void {
  if (request.ownershipRequired === true) throw authErrors.forbidden();
}

/**
 * Archive-then-purge for the Owner (DATA-008, AUD-004, P7-06b), and the archive viewer for those
 * who read reports (DATA-009, P7-06c).
 */
@Controller('archives')
export class ArchiveController {
  constructor(
    private readonly archives: ArchiveService,
    private readonly viewer: ArchiveViewerService,
  ) {}

  @Get(':id/days')
  @RequireCapability('REPORTS_VIEW_EXPORT')
  days(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(ArchiveParams)) params: ArchiveParams,
  ): Promise<ArchivedDaysResponse> {
    wholeRestaurant(request);
    return this.viewer.days(params.id);
  }

  @Get(':id/invoices')
  @RequireCapability('REPORTS_VIEW_EXPORT')
  invoices(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(ArchiveParams)) params: ArchiveParams,
    @Query(new ZodValidationPipe(ArchivedInvoiceQuery)) query: ArchivedInvoiceQuery,
  ): Promise<ArchivedInvoiceListResponse> {
    wholeRestaurant(request);
    return this.viewer.invoices(params.id, query);
  }

  @Get(':id/invoices/:invoiceId')
  @RequireCapability('REPORTS_VIEW_EXPORT')
  invoice(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(ArchivedInvoiceParams)) params: ArchivedInvoiceParams,
  ): Promise<ArchivedInvoiceResponse> {
    wholeRestaurant(request);
    return this.viewer.invoice(params.id, params.invoiceId);
  }

  @Get()
  @RequireCapability('REPORTS_VIEW_EXPORT')
  list(@Req() request: AuthenticatedRequest): Promise<ArchivesResponse> {
    wholeRestaurant(request);
    return this.archives.overview(principalOf(request).restaurantId);
  }

  // DATA_ADMIN is the Owner with a fresh second factor (AUTH-006).
  @Post()
  @HttpCode(202)
  @RequireCapability('DATA_ADMIN')
  start(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(StartArchiveRequest)) body: StartArchiveRequest,
  ): Promise<ArchiveRunView> {
    return this.archives.start(principalOf(request), body);
  }
}
