import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import {
  ActivateRequest,
  type ActivateResponse,
  type GoLiveView,
  MarkOnboardingStepRequest,
  type OnboardingResponse,
  OnboardingStepParams,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { OnboardingService } from './onboarding.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/** The first-run setup (ONB-004) and activating the PC (ONB-003). */
@Controller()
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get('onboarding')
  @RequireCapability('OPERATIONS_CONFIGURE')
  view(@Req() request: AuthenticatedRequest): Promise<OnboardingResponse> {
    return this.onboarding.view(principalOf(request).restaurantId);
  }

  @Put('onboarding/steps/:step')
  @RequireCapability('OPERATIONS_CONFIGURE')
  mark(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(OnboardingStepParams)) params: OnboardingStepParams,
    @Body(new ZodValidationPipe(MarkOnboardingStepRequest)) body: MarkOnboardingStepRequest,
  ): Promise<OnboardingResponse> {
    return this.onboarding.mark(principalOf(request), params.step, body.status);
  }

  @Get('onboarding/go-live')
  @RequireCapability('OPERATIONS_CONFIGURE')
  goLive(@Req() request: AuthenticatedRequest): Promise<GoLiveView> {
    return this.onboarding.goLive(principalOf(request).restaurantId);
  }

  @Post('onboarding/go-live/start')
  @HttpCode(200)
  @RequireCapability('OPERATIONS_CONFIGURE')
  startGoLive(@Req() request: AuthenticatedRequest): Promise<GoLiveView> {
    return this.onboarding.startGoLive(principalOf(request));
  }

  @Post('activation')
  @HttpCode(200)
  @RequireCapability('LICENSE_MANAGE')
  activate(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(ActivateRequest)) body: ActivateRequest,
  ): Promise<ActivateResponse> {
    return this.onboarding.activate(principalOf(request), body.code);
  }
}
