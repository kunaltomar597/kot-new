import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  type GstSummaryResponse,
  type InvoiceRegisterResponse,
  type ItemSalesResponse,
  OrderDrillDownParams,
  type OrderDrillDownResponse,
  type PaymentModesResponse,
  ReportExportRequest,
  type ReportExportResponse,
  ReportRangeQuery,
  type SalesSummaryResponse,
  type ShiftReportResponse,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { OrderDrillDownService } from './order-drill-down.service.js';
import { ReportExportService } from './report-export.service.js';
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
  constructor(
    private readonly reports: ReportsService,
    private readonly exports: ReportExportService,
    private readonly drillDowns: OrderDrillDownService,
  ) {}

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

  /** RPT-017: a stamped, audited CSV. Cashiers may export their own shift report only. */
  @Post('exports')
  @HttpCode(200)
  @RequireCapability('REPORTS_VIEW_EXPORT')
  export(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(ReportExportRequest)) body: ReportExportRequest,
  ): Promise<ReportExportResponse> {
    const principal = principalOf(request);
    const own = request.ownershipRequired === true;
    if (own && body.report !== 'SHIFTS') throw authErrors.forbidden();
    return this.exports.export(principal, body, own ? principal.staffId : null);
  }

  /** RPT-015: one order and who did each step. */
  @Get('orders/:orderId')
  @RequireCapability('REPORTS_VIEW_EXPORT')
  drillDown(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(OrderDrillDownParams)) params: OrderDrillDownParams,
  ): Promise<OrderDrillDownResponse> {
    return this.drillDowns.drillDown(restaurantOf(request), params.orderId);
  }
}
