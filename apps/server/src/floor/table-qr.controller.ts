import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  RegenerateTableQrRequest,
  type TableQrCodesResponse,
  type TableQrView,
  TableParams,
  TableTentsRequest,
  type TableTentsResponse,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { TableQrService } from './table-qr.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/** Table QR codes and their tents (P5-04, QR-001); managers and the Owner. */
@Controller('tables')
export class TableQrController {
  constructor(private readonly qr: TableQrService) {}

  @Get('qr-codes')
  @RequireCapability('STAFF_MANAGE')
  list(@Req() request: AuthenticatedRequest): Promise<TableQrCodesResponse> {
    return this.qr.list(principalOf(request));
  }

  @Post('qr-codes')
  @HttpCode(200)
  @RequireCapability('STAFF_MANAGE')
  issue(@Req() request: AuthenticatedRequest): Promise<TableQrCodesResponse> {
    return this.qr.issueMissing(principalOf(request));
  }

  @Post('qr-codes/tents')
  @HttpCode(200)
  @RequireCapability('STAFF_MANAGE')
  tents(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(TableTentsRequest)) body: TableTentsRequest,
  ): Promise<TableTentsResponse> {
    return this.qr.tents(principalOf(request), body);
  }

  @Post(':tableId/qr-code')
  @HttpCode(200)
  @RequireCapability('STAFF_MANAGE')
  regenerate(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(TableParams)) params: TableParams,
    @Body(new ZodValidationPipe(RegenerateTableQrRequest)) body: RegenerateTableQrRequest,
  ): Promise<TableQrView> {
    return this.qr.regenerate(principalOf(request), params.tableId, body.reason);
  }
}
