import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApproveUpdateRequest, type SystemStatusResponse } from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { SystemService } from './system.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/** The System page (P4-04, MGR-010, NFR-I03) and "Install now" (UPD-004). */
@Controller('system')
export class SystemController {
  constructor(private readonly system: SystemService) {}

  @Get()
  @RequireCapability('OPERATIONS_CONFIGURE')
  status(@Req() request: AuthenticatedRequest): Promise<SystemStatusResponse> {
    return this.system.status(principalOf(request));
  }

  @Post('update/approve')
  @HttpCode(200)
  @RequireCapability('UPDATE_INSTALL_NOW')
  approveUpdate(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(ApproveUpdateRequest)) body: ApproveUpdateRequest,
  ): Promise<SystemStatusResponse> {
    return this.system.approveUpdate(principalOf(request), body);
  }
}
