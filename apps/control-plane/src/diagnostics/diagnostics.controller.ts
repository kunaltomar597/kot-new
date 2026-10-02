import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  CreateDiagnosticsRequest,
  DeclineDiagnosticsRequest,
  type DiagnosticsRequestListResponse,
  DiagnosticsRequestParams,
  type DiagnosticsRequestView,
  DiagnosticsParams,
  DiagnosticsUploadRequest,
  type DiagnosticsUploadResponse,
  type VendorDiagnosticsDetail,
  type VendorDiagnosticsListResponse,
  VendorInstallationParams,
} from '@rp/contracts/control-plane';
import type { z } from 'zod';
import { type InstallationRequest, installationOf } from '../auth/installation.guard.js';
import { ZodPipe } from '../http/zod.pipe.js';
import { Vendor, type VendorRequest, vendorOf } from '../vendor/vendor.guard.js';
import { DiagnosticsService } from './diagnostics.service.js';

/** Diagnostics from restaurant PCs (UPD-008) and for vendor staff (VCP-007). */
@Controller()
export class DiagnosticsController {
  constructor(private readonly diagnostics: DiagnosticsService) {}

  // Signed by the installation (InstallationGuard): it can only send its own.
  @Post('diagnostics')
  upload(
    @Req() request: InstallationRequest,
    @Body(new ZodPipe(DiagnosticsUploadRequest))
    body: z.output<typeof DiagnosticsUploadRequest>,
  ): Promise<DiagnosticsUploadResponse> {
    return this.diagnostics.receive(installationOf(request).id, body);
  }

  @Get('vendor/installations/:id/diagnostics')
  @Vendor('FLEET_VIEW')
  async list(
    @Param(new ZodPipe(VendorInstallationParams)) params: VendorInstallationParams,
  ): Promise<VendorDiagnosticsListResponse> {
    return { bundles: await this.diagnostics.list(params.id) };
  }

  @Get('vendor/diagnostics/:id')
  @Vendor('SUPPORT_NOTES')
  open(
    @Req() request: VendorRequest,
    @Param(new ZodPipe(DiagnosticsParams)) params: DiagnosticsParams,
  ): Promise<VendorDiagnosticsDetail> {
    return this.diagnostics.open(params.id, vendorOf(request).actor);
  }

  @Post('vendor/installations/:id/diagnostics-requests')
  @Vendor('SUPPORT_NOTES')
  ask(
    @Req() request: VendorRequest,
    @Param(new ZodPipe(VendorInstallationParams)) params: VendorInstallationParams,
    @Body(new ZodPipe(CreateDiagnosticsRequest)) body: CreateDiagnosticsRequest,
  ): Promise<DiagnosticsRequestView> {
    return this.diagnostics.request(params.id, body.reason, vendorOf(request));
  }

  @Get('vendor/installations/:id/diagnostics-requests')
  @Vendor('FLEET_VIEW')
  async requests(
    @Param(new ZodPipe(VendorInstallationParams)) params: VendorInstallationParams,
  ): Promise<DiagnosticsRequestListResponse> {
    return { requests: await this.diagnostics.requests(params.id) };
  }

  // Signed by the installation: it can only decline its own requests.
  @Post('diagnostics-requests/:id/decline')
  @HttpCode(204)
  async decline(
    @Req() request: InstallationRequest,
    @Param(new ZodPipe(DiagnosticsRequestParams)) params: DiagnosticsRequestParams,
    @Body(new ZodPipe(DeclineDiagnosticsRequest)) body: DeclineDiagnosticsRequest,
  ): Promise<void> {
    await this.diagnostics.decline(installationOf(request).id, params.id, body.by);
  }
}
