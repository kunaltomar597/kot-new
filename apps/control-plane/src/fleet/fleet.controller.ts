import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  type AuditHeadListResponse,
  AvailabilityQuery,
  type AvailabilityResponse,
  FleetAlertParams,
  FleetAlertQuery,
  type FleetAlertListResponse,
  type FleetAlertView,
  type FleetResponse,
  ReasonRequest,
  VendorInstallationParams,
} from '@rp/contracts/control-plane';
import { ZodPipe } from '../http/zod.pipe.js';
import { Vendor, type VendorRequest, vendorOf } from '../vendor/vendor.guard.js';
import { FleetService } from './fleet.service.js';

/** Fleet monitoring for vendor staff (VCP-005, AUD-003, DATA-005). */
@Controller('vendor')
export class FleetController {
  constructor(private readonly fleet: FleetService) {}

  @Get('fleet')
  @Vendor('FLEET_VIEW')
  overview(): Promise<FleetResponse> {
    return this.fleet.fleet();
  }

  @Get('fleet/alerts')
  @Vendor('FLEET_VIEW')
  async alerts(
    @Query(new ZodPipe(FleetAlertQuery)) query: FleetAlertQuery,
  ): Promise<FleetAlertListResponse> {
    return { alerts: await this.fleet.alerts(query) };
  }

  @Post('fleet/alerts/:id/resolve')
  @HttpCode(200)
  @Vendor('SUPPORT_NOTES')
  resolve(
    @Req() request: VendorRequest,
    @Param(new ZodPipe(FleetAlertParams)) params: FleetAlertParams,
    @Body(new ZodPipe(ReasonRequest)) body: ReasonRequest,
  ): Promise<FleetAlertView> {
    return this.fleet.resolve(params.id, body.reason, vendorOf(request).actor);
  }

  @Get('installations/:id/audit-heads')
  @Vendor('FLEET_VIEW')
  async auditHeads(
    @Param(new ZodPipe(VendorInstallationParams)) params: VendorInstallationParams,
  ): Promise<AuditHeadListResponse> {
    return { heads: await this.fleet.auditHeads(params.id) };
  }

  @Get('installations/:id/availability')
  @Vendor('FLEET_VIEW')
  availability(
    @Param(new ZodPipe(VendorInstallationParams)) params: VendorInstallationParams,
    @Query(new ZodPipe(AvailabilityQuery)) query: AvailabilityQuery,
  ): Promise<AvailabilityResponse> {
    return this.fleet.availability(params.id, query);
  }
}
