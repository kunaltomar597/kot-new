import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { CloseDayRequest, DayEndParams, type DayEndPreview, type DayEndView } from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { DayEndService } from './day-end.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/** Day-end: the Z-report and closing the business date (P1-11b, BILL-013). */
@Controller()
export class DayEndController {
  constructor(private readonly dayEnd: DayEndService) {}

  @Get('day-end')
  @RequireCapability('DAY_END_CLOSE')
  preview(@Req() request: AuthenticatedRequest): Promise<DayEndPreview> {
    return this.dayEnd.preview(principalOf(request).restaurantId);
  }

  @Post('day-end')
  @RequireCapability('DAY_END_CLOSE')
  close(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(CloseDayRequest)) body: ReturnType<typeof CloseDayRequest.parse>,
  ): Promise<DayEndView> {
    return this.dayEnd.close(principalOf(request), body.businessDate, body.carryForwardTables);
  }

  @Get('day-ends/:businessDate')
  @RequireCapability('DAY_END_CLOSE')
  get(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(DayEndParams)) params: DayEndParams,
  ): Promise<DayEndView> {
    return this.dayEnd.dayEnd(principalOf(request).restaurantId, params.businessDate);
  }
}
