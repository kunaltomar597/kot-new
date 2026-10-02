import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import {
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
}
