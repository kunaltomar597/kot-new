import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  RaiseServiceRequest,
  type ServiceRequestListResponse,
  ServiceRequestParams,
  type ServiceRequestView,
  type TableServiceRequestsResponse,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability, RequireDevice } from '../auth/decorators.js';
import type { AuthenticatedDevice } from '../auth/device.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { ServiceRequestsService } from './service-requests.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

function deviceOf(request: AuthenticatedRequest): AuthenticatedDevice {
  if (request.device === undefined) throw authErrors.deviceNotRecognised();
  return request.device;
}

/** The waiter's service request inbox (P2-06d, WTR-005): open requests, acknowledge, resolve. */
@Controller('service-requests')
@RequireCapability('ORDER_CREATE')
export class ServiceRequestsController {
  constructor(private readonly requests: ServiceRequestsService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest): Promise<ServiceRequestListResponse> {
    return this.requests.list(principalOf(request).restaurantId);
  }

  @Post(':requestId/acknowledge')
  @HttpCode(200)
  acknowledge(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(ServiceRequestParams)) { requestId }: ServiceRequestParams,
  ): Promise<ServiceRequestView> {
    return this.requests.acknowledge(principalOf(request), requestId);
  }

  @Post(':requestId/resolve')
  @HttpCode(200)
  resolve(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(ServiceRequestParams)) { requestId }: ServiceRequestParams,
  ): Promise<ServiceRequestView> {
    return this.requests.resolve(principalOf(request), requestId);
  }
}

/**
 * The table tablet's Water, Waiter, Bill and Cancel (P2-06d, TAB-004): the device acts for its own
 * table only (AUTH-009), whoever is signed in on it. P3-02 builds the buttons on these.
 */
@Controller('devices/current/service-requests')
@RequireDevice()
export class TabletServiceRequestsController {
  constructor(private readonly requests: ServiceRequestsService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest): Promise<TableServiceRequestsResponse> {
    return this.requests.listForTablet(deviceOf(request));
  }

  @Post()
  raise(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(RaiseServiceRequest)) body: RaiseServiceRequest,
  ): Promise<ServiceRequestView> {
    return this.requests.raiseFromTablet(deviceOf(request), body.type);
  }

  @Post(':requestId/cancel')
  @HttpCode(200)
  cancel(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(ServiceRequestParams)) { requestId }: ServiceRequestParams,
  ): Promise<ServiceRequestView> {
    return this.requests.cancelFromTablet(deviceOf(request), requestId);
  }
}
