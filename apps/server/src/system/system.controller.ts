import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import {
  type DiagnosticsResponse,
  InstallNowRequest,
  type SystemUpdates,
  type SystemView,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { SystemService } from './system.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/** The System page (P4-04b, MGR-010, NFR-I03): support screen, "Install now", diagnostics. */
@Controller('system')
export class SystemController {
  constructor(private readonly system: SystemService) {}

  @Get()
  @RequireCapability('OPERATIONS_CONFIGURE')
  view(@Req() request: AuthenticatedRequest): Promise<SystemView> {
    return this.system.view(principalOf(request));
  }

  @Post('updates/install-now')
  @HttpCode(200)
  @RequireCapability('UPDATE_INSTALL_NOW')
  installNow(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(InstallNowRequest)) body: InstallNowRequest,
  ): Promise<SystemUpdates> {
    return this.system.installNow(principalOf(request), body);
  }

  @Post('diagnostics')
  @HttpCode(200)
  @RequireCapability('OPERATIONS_CONFIGURE')
  sendDiagnostics(@Req() request: AuthenticatedRequest): Promise<DiagnosticsResponse> {
    return this.system.sendDiagnostics(principalOf(request));
  }
}
