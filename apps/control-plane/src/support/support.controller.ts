import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  type RelayProvisioningView,
  type SupportNoteListResponse,
  SupportNoteRequest,
  type SupportNoteView,
  VendorTenantParams,
} from '@rp/contracts/control-plane';
import { ZodPipe } from '../http/zod.pipe.js';
import { Vendor, type VendorRequest, vendorOf } from '../vendor/vendor.guard.js';
import { SupportService } from './support.service.js';

/** Support notes and QR relay provisioning for vendor staff (VCP-007, VCP-002). */
@Controller('vendor/tenants')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get(':id/notes')
  @Vendor('FLEET_VIEW')
  async notes(
    @Param(new ZodPipe(VendorTenantParams)) params: VendorTenantParams,
  ): Promise<SupportNoteListResponse> {
    return { notes: await this.support.notes(params.id) };
  }

  @Post(':id/notes')
  @Vendor('SUPPORT_NOTES')
  addNote(
    @Req() request: VendorRequest,
    @Param(new ZodPipe(VendorTenantParams)) params: VendorTenantParams,
    @Body(new ZodPipe(SupportNoteRequest)) body: SupportNoteRequest,
  ): Promise<SupportNoteView> {
    return this.support.addNote(params.id, body.body, vendorOf(request).actor);
  }

  @Get(':id/relay')
  @Vendor('FLEET_VIEW')
  relay(
    @Param(new ZodPipe(VendorTenantParams)) params: VendorTenantParams,
  ): Promise<RelayProvisioningView> {
    return this.support.relayProvisioning(params.id);
  }

  @Post(':id/relay')
  @HttpCode(200)
  @Vendor('TENANTS_MANAGE')
  provision(
    @Req() request: VendorRequest,
    @Param(new ZodPipe(VendorTenantParams)) params: VendorTenantParams,
  ): Promise<RelayProvisioningView> {
    return this.support.provisionRelay(params.id, vendorOf(request).actor);
  }
}
