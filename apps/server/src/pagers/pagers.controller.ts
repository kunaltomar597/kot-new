import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import {
  AssignPagerRequest,
  CreatePagerRequest,
  type PagerCredentialResponse,
  type PagerListResponse,
  PagerParams,
  type PagerView,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { PagersService } from './pagers.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

const params = new ZodValidationPipe(PagerParams);

/** Pager administration (P2-04, PGR-012). */
@Controller('pagers')
@RequireCapability('DEVICE_PAIR')
export class PagersController {
  constructor(private readonly pagers: PagersService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest): Promise<PagerListResponse> {
    return this.pagers.list(principalOf(request).restaurantId);
  }

  @Post()
  create(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(CreatePagerRequest)) body: CreatePagerRequest,
  ): Promise<PagerCredentialResponse> {
    return this.pagers.create(principalOf(request), body);
  }

  @Post(':deviceId/credential')
  @HttpCode(200)
  rotate(
    @Req() request: AuthenticatedRequest,
    @Param(params) { deviceId }: PagerParams,
  ): Promise<PagerCredentialResponse> {
    return this.pagers.rotate(principalOf(request), deviceId);
  }

  @Put(':deviceId/wearer')
  assign(
    @Req() request: AuthenticatedRequest,
    @Param(params) { deviceId }: PagerParams,
    @Body(new ZodValidationPipe(AssignPagerRequest)) body: AssignPagerRequest,
  ): Promise<PagerView> {
    return this.pagers.assign(principalOf(request), deviceId, body.staffId);
  }
}
