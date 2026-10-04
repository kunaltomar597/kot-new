import { Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  type DigitalBillEntry,
  type InvoiceDigitalBillsResponse,
  InvoiceParams,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { DigitalBillsService } from './digital-bills.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/** A bill sent to the diner on WhatsApp or SMS (BILL-012, P7-09b), by whoever takes payment. */
@Controller('invoices/:id/digital-bills')
export class DigitalBillsController {
  constructor(private readonly bills: DigitalBillsService) {}

  @Get()
  @RequireCapability('BILL_PRINT_AND_PAYMENT')
  list(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(InvoiceParams)) params: InvoiceParams,
  ): Promise<InvoiceDigitalBillsResponse> {
    return this.bills.list(principalOf(request).restaurantId, params.id);
  }

  @Post()
  @HttpCode(202)
  @RequireCapability('BILL_PRINT_AND_PAYMENT')
  send(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(InvoiceParams)) params: InvoiceParams,
  ): Promise<DigitalBillEntry> {
    return this.bills.send(principalOf(request), params.id);
  }
}
