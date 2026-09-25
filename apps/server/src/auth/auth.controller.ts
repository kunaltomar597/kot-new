import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import {
  type LoginResponse,
  OverrideRequest,
  type OverrideResponse,
  OwnerLoginRequest,
  OwnerPasswordRequest,
  PinLoginRequest,
  RefreshRequest,
  type StaffTilesResponse,
  StepUpRequest,
  type StepUpResponse,
  TotpConfirmRequest,
  type TotpConfirmResponse,
  type TotpEnrollmentResponse,
  UnlockStaffRequest,
} from '@rp/contracts';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { authErrors } from './auth-errors.js';
import { AuthService } from './auth.service.js';
import { RequireCapability, RequireDevice, RequireSession } from './decorators.js';
import type { AuthenticatedDevice } from './device.js';
import type { AuthenticatedRequest, Principal } from './principal.js';
import { SessionService } from './session.service.js';

function deviceOf(request: AuthenticatedRequest): AuthenticatedDevice {
  if (request.device === undefined) throw authErrors.deviceNotRecognised();
  return request.device;
}

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/** Sign-in, sessions, step-up and manager overrides (AUTH-001 to AUTH-006, AUTH-011). */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Get('staff-tiles')
  @RequireDevice()
  staffTiles(@Req() request: AuthenticatedRequest): Promise<StaffTilesResponse> {
    return this.auth.staffTiles(deviceOf(request));
  }

  @Post('pin-login')
  @HttpCode(200)
  @RequireDevice()
  pinLogin(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(PinLoginRequest)) body: PinLoginRequest,
  ): Promise<LoginResponse> {
    return this.auth.pinLogin(deviceOf(request), body);
  }

  @Post('owner-login')
  @HttpCode(200)
  @RequireDevice()
  ownerLogin(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(OwnerLoginRequest)) body: OwnerLoginRequest,
  ): Promise<LoginResponse> {
    return this.auth.ownerLogin(deviceOf(request), body);
  }

  @Post('refresh')
  @HttpCode(200)
  @RequireDevice()
  refresh(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(RefreshRequest)) body: RefreshRequest,
  ): Promise<LoginResponse> {
    return this.sessions.refresh(body.refreshToken, deviceOf(request));
  }

  @Post('logout')
  @HttpCode(204)
  @RequireSession()
  logout(@Req() request: AuthenticatedRequest): Promise<void> {
    return this.auth.logout(principalOf(request));
  }

  @Post('step-up')
  @HttpCode(200)
  @RequireSession()
  stepUp(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(StepUpRequest)) body: StepUpRequest,
  ): Promise<StepUpResponse> {
    return this.auth.stepUp(principalOf(request), deviceOf(request), body);
  }

  @Post('override')
  @HttpCode(200)
  @RequireSession()
  override(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(OverrideRequest)) body: OverrideRequest,
  ): Promise<OverrideResponse> {
    return this.auth.grantOverride(principalOf(request), deviceOf(request), body);
  }

  @Post('unlock')
  @HttpCode(204)
  @RequireCapability('STAFF_MANAGE')
  unlock(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(UnlockStaffRequest)) body: UnlockStaffRequest,
  ): Promise<void> {
    return this.auth.unlock(principalOf(request), body.staffId);
  }

  @Post('owner/totp/enroll')
  @HttpCode(200)
  @RequireSession()
  enrollTotp(@Req() request: AuthenticatedRequest): Promise<TotpEnrollmentResponse> {
    return this.auth.enrollTotp(principalOf(request));
  }

  @Post('owner/totp/confirm')
  @HttpCode(200)
  @RequireSession()
  confirmTotp(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(TotpConfirmRequest)) body: TotpConfirmRequest,
  ): Promise<TotpConfirmResponse> {
    return this.auth.confirmTotp(principalOf(request), body.code);
  }

  @Post('owner/password')
  @HttpCode(204)
  @RequireSession()
  setOwnerPassword(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(OwnerPasswordRequest)) body: OwnerPasswordRequest,
  ): Promise<void> {
    return this.auth.setOwnerPassword(principalOf(request), body);
  }
}
