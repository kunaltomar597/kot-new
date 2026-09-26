import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import {
  ArchiveRequest,
  type InvoiceSeriesListResponse,
  InvoiceSeriesParams,
  InvoiceSeriesRequest,
  type InvoiceSeriesView,
  type RestaurantProfile,
  type TaxGroupListResponse,
  TaxGroupParams,
  TaxGroupRequest,
  type TaxGroupView,
  UpdateRestaurantLegalRequest,
  UpdateRestaurantProfileRequest,
} from '@rp/contracts';
import { authErrors } from '../auth/auth-errors.js';
import { RequireCapability, RequireDevice, RequireSession } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { InvoiceSeriesService } from './invoice-series.service.js';
import { RestaurantService } from './restaurant.service.js';
import { TaxGroupsService } from './tax-groups.service.js';

function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) throw authErrors.unauthenticated();
  return request.principal;
}

/** The restaurant profile and invoice particulars (P1-01b, ONB-004 step 1, BILL-002). */
@Controller('restaurant')
export class RestaurantController {
  constructor(private readonly restaurant: RestaurantService) {}

  // Any paired device: the login screen shows the name and logo, bills the particulars.
  @Get()
  @RequireDevice()
  get(@Req() request: AuthenticatedRequest): Promise<RestaurantProfile> {
    if (request.device === undefined) throw authErrors.deviceNotRecognised();
    return this.restaurant.get(request.device.restaurantId);
  }

  @Put('profile')
  @RequireCapability('OPERATIONS_CONFIGURE')
  updateProfile(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(UpdateRestaurantProfileRequest))
    body: UpdateRestaurantProfileRequest,
  ): Promise<RestaurantProfile> {
    return this.restaurant.updateProfile(principalOf(request), body);
  }

  // Tax and invoice settings: the guard also asks for the Owner's fresh second factor (AUTH-006).
  @Put('legal')
  @RequireCapability('TAX_AND_INVOICE_SETTINGS')
  updateLegal(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(UpdateRestaurantLegalRequest)) body: UpdateRestaurantLegalRequest,
  ): Promise<RestaurantProfile> {
    return this.restaurant.updateLegal(principalOf(request), body);
  }
}

/** Tax groups (P1-01b, BILL-004, ONB-004 step 2). Changes are the Owner's (AUTH-006). */
@Controller('tax-groups')
export class TaxGroupsController {
  constructor(private readonly taxGroups: TaxGroupsService) {}

  @Get()
  @RequireSession()
  async list(@Req() request: AuthenticatedRequest): Promise<TaxGroupListResponse> {
    return { taxGroups: await this.taxGroups.list(principalOf(request).restaurantId) };
  }

  @Post()
  @RequireCapability('TAX_AND_INVOICE_SETTINGS')
  create(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(TaxGroupRequest)) body: TaxGroupRequest,
  ): Promise<TaxGroupView> {
    return this.taxGroups.create(principalOf(request), body);
  }

  @Put(':taxGroupId')
  @RequireCapability('TAX_AND_INVOICE_SETTINGS')
  update(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(TaxGroupParams)) params: TaxGroupParams,
    @Body(new ZodValidationPipe(TaxGroupRequest)) body: TaxGroupRequest,
  ): Promise<TaxGroupView> {
    return this.taxGroups.update(principalOf(request), params.taxGroupId, body);
  }

  @Post(':taxGroupId/archive')
  @HttpCode(200)
  @RequireCapability('TAX_AND_INVOICE_SETTINGS')
  archive(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(TaxGroupParams)) params: TaxGroupParams,
    @Body(new ZodValidationPipe(ArchiveRequest)) body: ArchiveRequest,
  ): Promise<TaxGroupView> {
    return this.taxGroups.archive(principalOf(request), params.taxGroupId, body.reason);
  }
}

/** Invoice series (P1-01b, BILL-003, ONB-004 step 3). Changes are the Owner's (AUTH-006). */
@Controller('invoice-series')
export class InvoiceSeriesController {
  constructor(private readonly series: InvoiceSeriesService) {}

  @Get()
  @RequireSession()
  async list(@Req() request: AuthenticatedRequest): Promise<InvoiceSeriesListResponse> {
    return { invoiceSeries: await this.series.list(principalOf(request).restaurantId) };
  }

  @Post()
  @RequireCapability('TAX_AND_INVOICE_SETTINGS')
  create(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(InvoiceSeriesRequest)) body: InvoiceSeriesRequest,
  ): Promise<InvoiceSeriesView> {
    return this.series.create(principalOf(request), body);
  }

  @Put(':seriesId')
  @RequireCapability('TAX_AND_INVOICE_SETTINGS')
  update(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(InvoiceSeriesParams)) params: InvoiceSeriesParams,
    @Body(new ZodValidationPipe(InvoiceSeriesRequest)) body: InvoiceSeriesRequest,
  ): Promise<InvoiceSeriesView> {
    return this.series.update(principalOf(request), params.seriesId, body);
  }

  @Post(':seriesId/archive')
  @HttpCode(200)
  @RequireCapability('TAX_AND_INVOICE_SETTINGS')
  archive(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(InvoiceSeriesParams)) params: InvoiceSeriesParams,
    @Body(new ZodValidationPipe(ArchiveRequest)) body: ArchiveRequest,
  ): Promise<InvoiceSeriesView> {
    return this.series.archive(principalOf(request), params.seriesId, body.reason);
  }

  @Post(':seriesId/default')
  @HttpCode(200)
  @RequireCapability('TAX_AND_INVOICE_SETTINGS')
  setDefault(
    @Req() request: AuthenticatedRequest,
    @Param(new ZodValidationPipe(InvoiceSeriesParams)) params: InvoiceSeriesParams,
  ): Promise<InvoiceSeriesView> {
    return this.series.setDefault(principalOf(request), params.seriesId);
  }
}
