import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Req } from '@nestjs/common';
import {
  CreateStaffRequest,
  DeactivateStaffRequest,
  SetStaffPinRequest,
  type StaffListResponse,
  StaffParams,
  type StaffView,
  UpdateStaffRequest,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { StaffService } from './staff.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/** Staff administration for managers and the Owner (P4-02a, MGR-004). */
@Controller('staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  @RequireCapability('STAFF_MANAGE')
  list(@Req() request: AuthenticatedRequest): Promise<StaffListResponse> {
    return this.staff.list(principalOf(request));
  }

  @Post()
  @RequireCapability('STAFF_MANAGE')
  create(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(CreateStaffRequest)) body: CreateStaffRequest,
  ): Promise<StaffView> {
    return this.staff.create(principalOf(request), body);
  }

  @Patch(':staffId')
  @RequireCapability('STAFF_MANAGE')
  update(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(StaffParams)) params: StaffParams,
    @Body(new ZodValidationPipe(UpdateStaffRequest)) body: UpdateStaffRequest,
  ): Promise<StaffView> {
    return this.staff.update(principalOf(request), params.staffId, body);
  }

  @Post(':staffId/deactivate')
  @HttpCode(200)
  @RequireCapability('STAFF_MANAGE')
  deactivate(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(StaffParams)) params: StaffParams,
    @Body(new ZodValidationPipe(DeactivateStaffRequest)) body: DeactivateStaffRequest,
  ): Promise<StaffView> {
    return this.staff.deactivate(principalOf(request), params.staffId, body.reason);
  }

  @Post(':staffId/reactivate')
  @HttpCode(200)
  @RequireCapability('STAFF_MANAGE')
  reactivate(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(StaffParams)) params: StaffParams,
  ): Promise<StaffView> {
    return this.staff.reactivate(principalOf(request), params.staffId);
  }

  @Put(':staffId/pin')
  @HttpCode(204)
  @RequireCapability('STAFF_MANAGE')
  setPin(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(StaffParams)) params: StaffParams,
    @Body(new ZodValidationPipe(SetStaffPinRequest)) body: SetStaffPinRequest,
  ): Promise<void> {
    return this.staff.setPin(principalOf(request), params.staffId, body.pin);
  }
}
