import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import {
  type FleetRemoteSettingsView,
  type InstallationRemoteSettingsView,
  UpdateRemoteSettingsRequest,
  VendorInstallationParams,
} from '@rp/contracts/control-plane';
import { ZodPipe } from '../http/zod.pipe.js';
import { StepUp, Vendor, type VendorRequest, vendorOf } from '../vendor/vendor.guard.js';
import { RemoteSettingsService } from './remote-settings.service.js';

/** Vendor settings and feature flags for restaurant PCs (UPD-010). */
@Controller('vendor')
export class RemoteSettingsController {
  constructor(private readonly settings: RemoteSettingsService) {}

  @Get('remote-settings')
  @Vendor('FLEET_VIEW')
  fleet(): Promise<FleetRemoteSettingsView> {
    return this.settings.fleet();
  }

  @Put('remote-settings')
  @Vendor('REMOTE_CONFIG')
  @StepUp()
  setFleet(
    @Req() request: VendorRequest,
    @Body(new ZodPipe(UpdateRemoteSettingsRequest)) body: UpdateRemoteSettingsRequest,
  ): Promise<FleetRemoteSettingsView> {
    return this.settings.setFleet(body.values, body.reason, vendorOf(request).actor);
  }

  @Get('installations/:id/remote-settings')
  @Vendor('FLEET_VIEW')
  installation(
    @Param(new ZodPipe(VendorInstallationParams)) params: VendorInstallationParams,
  ): Promise<InstallationRemoteSettingsView> {
    return this.settings.installation(params.id);
  }

  @Put('installations/:id/remote-settings')
  @Vendor('REMOTE_CONFIG')
  @StepUp()
  setInstallation(
    @Req() request: VendorRequest,
    @Param(new ZodPipe(VendorInstallationParams)) params: VendorInstallationParams,
    @Body(new ZodPipe(UpdateRemoteSettingsRequest)) body: UpdateRemoteSettingsRequest,
  ): Promise<InstallationRemoteSettingsView> {
    return this.settings.setInstallation(
      params.id,
      body.values,
      body.reason,
      vendorOf(request).actor,
    );
  }
}
