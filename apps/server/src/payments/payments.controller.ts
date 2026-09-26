import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  CashMovementRequest,
  CloseShiftRequest,
  type CurrentShiftResponse,
  InvoiceParams,
  type InvoicePaymentsView,
  OpenShiftRequest,
  RecordPaymentsRequest,
  ShiftParams,
  type ShiftView,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { type ParsedPayments, PaymentsService } from './payments.service.js';
import { ShiftsService } from './shifts.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/** Cash shifts (P1-11a, BILL-013). */
@Controller('shifts')
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  @Post()
  @RequireCapability('BILL_PRINT_AND_PAYMENT')
  open(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(OpenShiftRequest)) body: OpenShiftRequest,
  ): Promise<ShiftView> {
    return this.shifts.open(principalOf(request), body.openingFloat);
  }

  @Get('current')
  @RequireCapability('BILL_PRINT_AND_PAYMENT')
  async current(@Req() request: AuthenticatedRequest): Promise<CurrentShiftResponse> {
    return { shift: await this.shifts.current(principalOf(request)) };
  }

  @Post(':id/cash-movements')
  @HttpCode(200)
  @RequireCapability('CASH_MOVEMENT_AND_SHIFT_CLOSE')
  moveCash(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(ShiftParams)) params: ShiftParams,
    @Body(new ZodValidationPipe(CashMovementRequest)) body: CashMovementRequest,
  ): Promise<ShiftView> {
    return this.shifts.moveCash(
      principalOf(request),
      params.id,
      body,
      request.ownershipRequired === true,
    );
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequireCapability('CASH_MOVEMENT_AND_SHIFT_CLOSE')
  close(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(ShiftParams)) params: ShiftParams,
    @Body(new ZodValidationPipe(CloseShiftRequest))
    body: ReturnType<typeof CloseShiftRequest.parse>,
  ): Promise<ShiftView> {
    return this.shifts.close(
      principalOf(request),
      params.id,
      body,
      request.ownershipRequired === true,
    );
  }
}

/** Payments against invoices (P1-11a, BILL-008). */
@Controller('invoices')
export class InvoicePaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get(':id/payments')
  @RequireCapability('BILL_PRINT_AND_PAYMENT')
  get(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(InvoiceParams)) params: InvoiceParams,
  ): Promise<InvoicePaymentsView> {
    return this.payments.paymentsOf(principalOf(request).restaurantId, params.id);
  }

  @Post(':id/payments')
  @HttpCode(200)
  @RequireCapability('BILL_PRINT_AND_PAYMENT')
  record(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(InvoiceParams)) params: InvoiceParams,
    @Body(new ZodValidationPipe(RecordPaymentsRequest)) body: ParsedPayments,
  ): Promise<InvoicePaymentsView> {
    return this.payments.record(principalOf(request), params.id, body);
  }
}
