import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import {
  ArchiveRoleRequest,
  type RoleListResponse,
  RoleParams,
  RoleRequest,
  type RoleView,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { RolesService } from './roles.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/** Built-in and custom roles (P4-02e, AUTH-012); changes are the Owner's (see the service). */
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequireCapability('STAFF_MANAGE')
  list(@Req() request: AuthenticatedRequest): Promise<RoleListResponse> {
    return this.roles.list(principalOf(request));
  }

  @Post()
  @RequireCapability('STAFF_MANAGE')
  create(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(RoleRequest)) body: RoleRequest,
  ): Promise<RoleView> {
    return this.roles.create(principalOf(request), body);
  }

  @Put(':roleId')
  @RequireCapability('STAFF_MANAGE')
  update(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(RoleParams)) params: RoleParams,
    @Body(new ZodValidationPipe(RoleRequest)) body: RoleRequest,
  ): Promise<RoleView> {
    return this.roles.update(principalOf(request), params.roleId, body);
  }

  @Post(':roleId/archive')
  @HttpCode(200)
  @RequireCapability('STAFF_MANAGE')
  archive(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(RoleParams)) params: RoleParams,
    @Body(new ZodValidationPipe(ArchiveRoleRequest)) body: ArchiveRoleRequest,
  ): Promise<RoleView> {
    return this.roles.archive(principalOf(request), params.roleId, body.reason);
  }
}
