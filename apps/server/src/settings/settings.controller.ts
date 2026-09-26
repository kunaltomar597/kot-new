import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import {
  SettingKeyParams,
  type SettingsResponse,
  type SettingView,
  UpdateSettingRequest,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { SettingsService } from './settings.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/** The settings registry on the dashboard (P1-01a, MGR-007). */
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @RequireCapability('OPERATIONS_CONFIGURE')
  async list(@Req() request: AuthenticatedRequest): Promise<SettingsResponse> {
    return { settings: await this.settings.list(principalOf(request)) };
  }

  // The route needs OPERATIONS_CONFIGURE; the service also checks the capability the setting
  // itself names (and the Owner's second factor for tax, invoice and data settings).
  @Put(':key')
  @RequireCapability('OPERATIONS_CONFIGURE')
  update(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(SettingKeyParams)) params: { key: string },
    @Body(new ZodValidationPipe(UpdateSettingRequest)) body: UpdateSettingRequest,
  ): Promise<SettingView> {
    return this.settings.update(principalOf(request), params.key, body);
  }
}
