import { Controller, Get, Query, Req } from '@nestjs/common';
import {
  type GstSummaryResponse,
  type InvoiceRegisterResponse,
  type ItemSalesResponse,
  type PaymentModesResponse,
  ReportRangeQuery,
  type SalesSummaryResponse,
  type ShiftReportResponse,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { ReportsService } from './reports.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/**
 * Reports (P1-13a). §4.2 gives cashiers reports on their own shift only (OWN): they get the shift
 * report of their own shifts, and no other report.
 */
function restaurantOf(request: AuthenticatedRequest): string {
  if (request.ownershipRequired === true) throw authErrors.forbidden();
  return principalOf(request).restaurantId;
}

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('sales')
  @RequireCapability('REPORTS_VIEW_EXPORT')
  sales(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(ReportRangeQuery)) range: ReportRangeQuery,
  ): Promise<SalesSummaryResponse> {
    return this.reports.sales(restaurantOf(request), range);
  }

  @Get('items')
  @RequireCapability('REPORTS_VIEW_EXPORT')
  items(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(ReportRangeQuery)) range: ReportRangeQuery,
  ): Promise<ItemSalesResponse> {
    return this.reports.items(restaurantOf(request), range);
  }

  @Get('payments')
  @RequireCapability('REPORTS_VIEW_EXPORT')
  payments(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(ReportRangeQuery)) range: ReportRangeQuery,
  ): Promise<PaymentModesResponse> {
    return this.reports.payments(restaurantOf(request), range);
  }

  @Get('shifts')
  @RequireCapability('REPORTS_VIEW_EXPORT')
  shifts(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(ReportRangeQuery)) range: ReportRangeQuery,
  ): Promise<ShiftReportResponse> {
    const principal = principalOf(request);
    const own = request.ownershipRequired === true ? principal.staffId : null;
    return this.reports.shiftReport(principal.restaurantId, range, own);
  }

  @Get('gst')
  @RequireCapability('REPORTS_VIEW_EXPORT')
  gst(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(ReportRangeQuery)) range: ReportRangeQuery,
  ): Promise<GstSummaryResponse> {
    return this.reports.gst(restaurantOf(request), range);
  }

  @Get('invoice-register')
  @RequireCapability('REPORTS_VIEW_EXPORT')
  register(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(ReportRangeQuery)) range: ReportRangeQuery,
  ): Promise<InvoiceRegisterResponse> {
    return this.reports.register(restaurantOf(request), range);
  }
}
