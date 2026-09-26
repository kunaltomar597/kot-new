import { Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { type AlertListResponse, AlertParams, type AlertView } from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireSession } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { NotificationsService } from './notifications.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/** Alerts for the signed-in person, and acknowledging them (P2-03, NTF-004, NTF-006). */
@Controller('alerts')
@RequireSession()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest): Promise<AlertListResponse> {
    return this.notifications.list(principalOf(request));
  }

  @Post(':alertId/acknowledge')
  @HttpCode(200)
  acknowledge(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(AlertParams)) { alertId }: AlertParams,
  ): Promise<AlertView> {
    return this.notifications.acknowledge(principalOf(request), alertId);
  }
}
