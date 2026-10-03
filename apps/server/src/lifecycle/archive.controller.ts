import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { type ArchiveRunView, type ArchivesResponse, StartArchiveRequest } from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { ArchiveService } from './archive.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/** Archive-then-purge for the Owner (DATA-008, AUD-004, P7-06b). */
@Controller('archives')
export class ArchiveController {
  constructor(private readonly archives: ArchiveService) {}

  @Get()
  @RequireCapability('DATA_ADMIN')
  list(@Req() request: AuthenticatedRequest): Promise<ArchivesResponse> {
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
