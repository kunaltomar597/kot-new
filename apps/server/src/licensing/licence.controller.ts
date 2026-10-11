import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { type LicenceView, ReactivateLicenceRequest } from '@rp/contracts';
import { actorGrant } from '@rp/domain';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability, RequireSession } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { LicenceAgentService } from './licence-agent.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/** The licence for every screen, the Owner's reactivation code and "check now" (P7-01c). */
@Controller('licence')
export class LicenceController {
  constructor(private readonly agent: LicenceAgentService) {}

  @Get()
  @RequireSession()
  get(@Req() request: AuthenticatedRequest): Promise<LicenceView> {
    const principal = principalOf(request);
    const details =
      actorGrant(
        { role: principal.role, extraCapabilities: principal.capabilities },
        'LICENSE_VIEW',
      ) !== 'DENY';
    return this.agent.view(details);
  }

  @Post('reactivate')
  @HttpCode(200)
  @RequireCapability('LICENSE_MANAGE')
  reactivate(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(ReactivateLicenceRequest)) body: ReactivateLicenceRequest,
  ): Promise<LicenceView> {
    return this.agent.reactivate(principalOf(request), body.code);
  }

  @Post('check')
  @HttpCode(200)
  @RequireCapability('LICENSE_MANAGE')
  check(): Promise<LicenceView> {
    return this.agent.check();
  }
}
