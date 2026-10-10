import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  CreateVendorUserRequest,
  UpdateVendorUserRequest,
  VendorAccessReviewRequest,
  type VendorMeView,
  type VendorResetRequestedView,
  type VendorSessionView,
  VendorSetupConfirmRequest,
  VendorSetupRequest,
  type VendorSetupResponse,
  type VendorSetupTokenView,
  VendorSignInRequest,
  type VendorUserListResponse,
  VendorUserParams,
  type VendorUserView,
} from '@rp/contracts/control-plane';
import type { Request, Response } from 'express';
import { Public } from '../auth/public.decorator.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { CpError } from '../errors/cp-error.js';
import { ZodPipe } from '../http/zod.pipe.js';
import { VendorAuthService } from './vendor-auth.service.js';
import { StepUp, Vendor, type VendorRequest, vendorOf } from './vendor.guard.js';

/** Vendor staff: signing in, setting up an account, the accounts and access reviews (VCP-001). */
@Controller('vendor')
export class VendorController {
  constructor(
    private readonly auth: VendorAuthService,
    private readonly limiter: RateLimiter,
  ) {}

  // Public: this is how a session starts. Limited per address on top of the account lockout.
  @Post('session')
  @Public()
  signIn(
    @Req() request: Request,
    @Body(new ZodPipe(VendorSignInRequest)) body: VendorSignInRequest,
  ): Promise<VendorSessionView> {
    const address = request.ip ?? 'unknown';
    if (!this.limiter.hit(`vendor-sign-in:${address}`, 20, 15 * 60_000)) {
      throw new CpError(429, 'RATE_LIMITED', 'Too many attempts. Wait a few minutes.');
    }
    return this.auth.signIn(body, address);
  }

  @Delete('session')
  @HttpCode(204)
  @Vendor()
  async signOut(@Req() request: VendorRequest): Promise<void> {
    await this.auth.signOut(vendorOf(request));
  }

  @Get('me')
  @Vendor()
  me(@Req() request: VendorRequest): Promise<VendorMeView> {
    return this.auth.me(vendorOf(request));
  }

  // Public: the one-time setup token is the credential.
  @Post('setup')
  @HttpCode(200)
  @Public()
  setup(
    @Req() request: Request,
    @Body(new ZodPipe(VendorSetupRequest)) body: VendorSetupRequest,
  ): Promise<VendorSetupResponse> {
    this.throttleSetup(request);
    return this.auth.setup(body.token, body.password);
  }

  @Post('setup/confirm')
  @HttpCode(200)
  @Public()
  confirm(
    @Req() request: Request,
    @Body(new ZodPipe(VendorSetupConfirmRequest)) body: VendorSetupConfirmRequest,
  ): Promise<VendorUserView> {
    this.throttleSetup(request);
    return this.auth.confirm(body.token, body.code);
  }

  @Get('users')
  @Vendor('USERS_MANAGE')
  async users(): Promise<VendorUserListResponse> {
    return { users: await this.auth.list() };
  }

  @Post('users')
  @Vendor('USERS_MANAGE')
  @StepUp()
  createUser(
    @Req() request: VendorRequest,
    @Body(new ZodPipe(CreateVendorUserRequest)) body: CreateVendorUserRequest,
  ): Promise<VendorSetupTokenView> {
    return this.auth.create(body, vendorOf(request).actor);
  }

  @Patch('users/:id')
  @Vendor('USERS_MANAGE')
  @StepUp()
  updateUser(
    @Req() request: VendorRequest,
    @Param(new ZodPipe(VendorUserParams)) params: VendorUserParams,
    @Body(new ZodPipe(UpdateVendorUserRequest)) body: UpdateVendorUserRequest,
  ): Promise<VendorUserView> {
    return this.auth.update(params.id, body, vendorOf(request));
  }

  /** 200 with the setup token, or 202 when a Super Admin's reset waits for a second one. */
  @Post('users/:id/reset')
  @HttpCode(200)
  @Vendor('USERS_MANAGE')
  @StepUp()
  async resetUser(
    @Req() request: VendorRequest,
    @Res({ passthrough: true }) response: Response,
    @Param(new ZodPipe(VendorUserParams)) params: VendorUserParams,
  ): Promise<VendorSetupTokenView | VendorResetRequestedView> {
    const outcome = await this.auth.reset(params.id, vendorOf(request));
    if (!outcome.done) response.status(202);
    return outcome.view;
  }

  @Post('access-reviews')
  @HttpCode(200)
  @Vendor('USERS_MANAGE')
  @StepUp()
  async review(
    @Req() request: VendorRequest,
    @Body(new ZodPipe(VendorAccessReviewRequest)) body: VendorAccessReviewRequest,
  ): Promise<VendorUserListResponse> {
    return { users: await this.auth.review(body.keep, body.note, vendorOf(request)) };
  }

  private throttleSetup(request: Request): void {
    if (!this.limiter.hit(`vendor-setup:${request.ip ?? 'unknown'}`, 20, 15 * 60_000)) {
      throw new CpError(429, 'RATE_LIMITED', 'Too many attempts. Wait a few minutes.');
    }
  }
}
