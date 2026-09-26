import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import {
  BillCustomerRequest,
  BillDiscountParams,
  BillParams,
  type BillView,
  DiscountRequest,
  InvoiceParams,
  type InvoiceView,
  IssueInvoiceRequest,
  OpenBillRequest,
  OVERRIDE_TOKEN_HEADER,
  PrintInvoiceRequest,
  type PrintInvoiceResponse,
  RevokeDiscountRequest,
  ServiceChargeRequest,
  VoidInvoiceRequest,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { BillsService, type ParsedDiscount } from './bills.service.js';
import { InvoiceActionsService } from './invoice-actions.service.js';
import { InvoicesService } from './invoices.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

function overrideTokenOf(request: AuthenticatedRequest): string | undefined {
  const header = request.headers[OVERRIDE_TOKEN_HEADER];
  return Array.isArray(header) ? header[0] : header;
}

/** Bills before printing and printing them (P1-10a, BILL-001 to BILL-006, BILL-011). */
@Controller('bills')
export class BillsController {
  constructor(
    private readonly bills: BillsService,
    private readonly invoices: InvoicesService,
  ) {}

  @Post()
  @HttpCode(200)
  @RequireCapability('BILL_PRINT_AND_PAYMENT')
  open(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(OpenBillRequest)) body: OpenBillRequest,
  ): Promise<BillView> {
    return this.bills.open(principalOf(request), body);
  }

  @Get(':id')
  @RequireCapability('BILL_PRINT_AND_PAYMENT')
  get(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(BillParams)) params: BillParams,
  ): Promise<BillView> {
    return this.bills.view(principalOf(request).restaurantId, params.id);
  }

  @Post(':id/discounts')
  @HttpCode(200)
  @RequireCapability('DISCOUNT_WITHIN_LIMIT')
  addDiscount(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(BillParams)) params: BillParams,
    @Body(new ZodValidationPipe(DiscountRequest)) body: ParsedDiscount,
  ): Promise<BillView> {
    return this.bills.addDiscount(principalOf(request), params.id, body, overrideTokenOf(request));
  }

  @Post(':id/discounts/:discountId/revoke')
  @HttpCode(200)
  @RequireCapability('DISCOUNT_WITHIN_LIMIT')
  revokeDiscount(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(BillDiscountParams)) params: BillDiscountParams,
    @Body(new ZodValidationPipe(RevokeDiscountRequest)) body: RevokeDiscountRequest,
  ): Promise<BillView> {
    return this.bills.revokeDiscount(
      principalOf(request),
      params.id,
      params.discountId,
      body.reason,
    );
  }

  @Post(':id/service-charge')
  @HttpCode(200)
  @RequireCapability('SERVICE_CHARGE_REMOVE')
  serviceCharge(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(BillParams)) params: BillParams,
    @Body(new ZodValidationPipe(ServiceChargeRequest)) body: ServiceChargeRequest,
  ): Promise<BillView> {
    return this.bills.setServiceCharge(principalOf(request), params.id, body.removed, body.reason);
  }

  @Put(':id/customer')
  @RequireCapability('BILL_PRINT_AND_PAYMENT')
  customer(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(BillParams)) params: BillParams,
    @Body(new ZodValidationPipe(BillCustomerRequest)) body: BillCustomerRequest,
  ): Promise<BillView> {
    return this.bills.setCustomer(principalOf(request), params.id, body);
  }

  @Post(':id/invoice')
  @RequireCapability('BILL_PRINT_AND_PAYMENT')
  issue(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(BillParams)) params: BillParams,
    @Body(new ZodValidationPipe(IssueInvoiceRequest))
    body: ReturnType<typeof IssueInvoiceRequest.parse>,
  ): Promise<InvoiceView> {
    return this.invoices.issue(principalOf(request), params.id, body.seriesId);
  }
}

/** Issued invoices (P1-10a, BILL-002): view, print or reprint, and void (P1-10b). */
@Controller('invoices')
export class InvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly actions: InvoiceActionsService,
  ) {}

  @Post(':id/print')
  @HttpCode(200)
  @RequireCapability('BILL_REPRINT')
  print(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(InvoiceParams)) params: InvoiceParams,
    @Body(new ZodValidationPipe(PrintInvoiceRequest))
    body: ReturnType<typeof PrintInvoiceRequest.parse>,
  ): Promise<PrintInvoiceResponse> {
    return this.actions.print(principalOf(request), params.id, body.printerId);
  }

  @Post(':id/void')
  @HttpCode(200)
  @RequireCapability('INVOICE_VOID')
  void(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(InvoiceParams)) params: InvoiceParams,
    @Body(new ZodValidationPipe(VoidInvoiceRequest)) body: VoidInvoiceRequest,
  ): Promise<InvoiceView> {
    return this.actions.void(principalOf(request), params.id, body.reason, request.override);
  }

  @Get(':id')
  @RequireCapability('BILL_PRINT_AND_PAYMENT')
  get(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(InvoiceParams)) params: InvoiceParams,
  ): Promise<InvoiceView> {
    return this.invoices.view(principalOf(request).restaurantId, params.id);
  }
}
