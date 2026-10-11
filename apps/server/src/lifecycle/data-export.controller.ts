import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import {
  type DataExportResponse,
  type DataExportView,
  StartDataExportRequest,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { DataExportService } from './data-export.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/**
 * The full data export for the Owner (DATA-010, P7-06c), at any time: restricted licence mode
 * (LIC-005) gates ordering only, never this.
 */
@Controller('data-export')
export class DataExportController {
  constructor(private readonly exports: DataExportService) {}

  @Get()
  @RequireCapability('DATA_ADMIN')
  last(): DataExportResponse {
    return { last: this.exports.view() };
  }

  @Post()
  @HttpCode(202)
  @RequireCapability('DATA_ADMIN')
  start(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(StartDataExportRequest)) body: StartDataExportRequest,
  ): Promise<DataExportView> {
    return this.exports.start(principalOf(request), body.folder);
  }
}
