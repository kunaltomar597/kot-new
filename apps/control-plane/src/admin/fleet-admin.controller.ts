import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  type ActivationCodeView,
  AuditQuery,
  type AuditListResponse,
  CreateInstallationRequest,
  LicenceChangeRequest,
  PublishReleaseRequest,
  ReactivationCodeRequest,
  type ReactivationCodeView,
  ReasonRequest,
  PinInstallationRequest,
  UpdateRolloutRequest,
  VendorReleaseParams,
  type VendorReleaseView,
  TenantRequest,
  VendorInstallationParams,
  type VendorInstallationView,
  type VendorLicenceView,
  type VendorReleaseListResponse,
  type VendorTenantDetail,
  type VendorTenantListResponse,
  VendorTenantParams,
  type VendorTenantView,
} from '@rp/contracts/control-plane';
import type { z } from 'zod';
import { ZodPipe } from '../http/zod.pipe.js';
import { type LicenceSummary, LicencesService } from '../licences/licences.service.js';
import { ReleasesService } from '../releases/releases.service.js';
import { Vendor, type VendorRequest, vendorOf } from '../vendor/vendor.guard.js';
import { AdminService } from './admin.service.js';
import { FleetAdminService } from './fleet-admin.service.js';

function licenceView(summary: LicenceSummary): VendorLicenceView {
  return {
    installationId: summary.installationId,
    state: summary.state,
    reason: summary.reason,
    plan: summary.plan,
    modules: summary.modules as VendorLicenceView['modules'],
    deviceLimits: summary.deviceLimits,
    validityDays: summary.validityDays,
    graceDays: summary.graceDays,
    graceStartedAt: summary.graceStartedAt?.toISOString() ?? null,
    boundAt: summary.boundAt?.toISOString() ?? null,
    latest:
      summary.latest === null
        ? null
        : {
            id: summary.latest.id,
            issuedAt: summary.latest.issuedAt.toISOString(),
            validUntil: summary.latest.validUntil.toISOString(),
            state: summary.latest.state,
          },
  };
}

/**
 * The fleet for vendor staff (VCP-002, VCP-003, VCP-006, P7-02b): tenants, installations and
 * activation codes, licences, releases and the audit trail, each by the role that may.
 */
@Controller('vendor')
export class FleetAdminController {
  constructor(
    private readonly fleet: FleetAdminService,
    private readonly admin: AdminService,
    private readonly licences: LicencesService,
    private readonly releases: ReleasesService,
  ) {}

  @Get('tenants')
  @Vendor('FLEET_VIEW')
  async tenants(): Promise<VendorTenantListResponse> {
    return { tenants: await this.fleet.tenants() };
  }

  @Post('tenants')
  @Vendor('TENANTS_MANAGE')
  createTenant(
    @Req() request: VendorRequest,
    @Body(new ZodPipe(TenantRequest)) body: TenantRequest,
  ): Promise<VendorTenantView> {
    return this.fleet.createTenant(body, vendorOf(request).actor);
  }

  @Get('tenants/:id')
  @Vendor('FLEET_VIEW')
  tenant(
    @Param(new ZodPipe(VendorTenantParams)) params: VendorTenantParams,
  ): Promise<VendorTenantDetail> {
    return this.fleet.tenant(params.id);
  }

  @Put('tenants/:id')
  @Vendor('TENANTS_MANAGE')
  updateTenant(
    @Req() request: VendorRequest,
    @Param(new ZodPipe(VendorTenantParams)) params: VendorTenantParams,
    @Body(new ZodPipe(TenantRequest)) body: TenantRequest,
  ): Promise<VendorTenantView> {
    return this.fleet.updateTenant(params.id, body, vendorOf(request).actor);
  }

  @Post('tenants/:id/installations')
  @Vendor('TENANTS_MANAGE')
  async createInstallation(
    @Req() request: VendorRequest,
    @Param(new ZodPipe(VendorTenantParams)) params: VendorTenantParams,
    @Body(new ZodPipe(CreateInstallationRequest))
    body: z.output<typeof CreateInstallationRequest>,
  ): Promise<ActivationCodeView> {
    const issued = await this.admin.createInstallation(
      { tenantId: params.id, name: body.name, channel: body.channel },
      vendorOf(request).actor,
    );
    return { ...issued, expiresAt: issued.expiresAt.toISOString() };
  }

  @Get('installations/:id')
  @Vendor('FLEET_VIEW')
  installation(
    @Param(new ZodPipe(VendorInstallationParams)) params: VendorInstallationParams,
  ): Promise<VendorInstallationView> {
    return this.fleet.installation(params.id);
  }

  @Post('installations/:id/code')
  @HttpCode(200)
  @Vendor('TENANTS_MANAGE')
  async code(
    @Req() request: VendorRequest,
    @Param(new ZodPipe(VendorInstallationParams)) params: VendorInstallationParams,
  ): Promise<ActivationCodeView> {
    const issued = await this.admin.issueEnrolmentCode(params.id, vendorOf(request).actor);
    return { ...issued, expiresAt: issued.expiresAt.toISOString() };
  }

  @Post('installations/:id/move')
  @HttpCode(200)
  @Vendor('LICENCE_REBIND')
  move(
    @Req() request: VendorRequest,
    @Param(new ZodPipe(VendorInstallationParams)) params: VendorInstallationParams,
    @Body(new ZodPipe(ReasonRequest)) body: ReasonRequest,
  ): Promise<ActivationCodeView> {
    return this.fleet.move(params.id, body.reason, vendorOf(request).actor);
  }

  @Post('installations/:id/revoke')
  @HttpCode(200)
  @Vendor('TENANTS_MANAGE')
  async revoke(
    @Req() request: VendorRequest,
    @Param(new ZodPipe(VendorInstallationParams)) params: VendorInstallationParams,
    @Body(new ZodPipe(ReasonRequest)) body: ReasonRequest,
  ): Promise<VendorInstallationView> {
    await this.admin.revokeInstallation(params.id, body.reason, vendorOf(request).actor);
    return this.fleet.installation(params.id);
  }

  @Get('installations/:id/licence')
  @Vendor('FLEET_VIEW')
  async licence(
    @Param(new ZodPipe(VendorInstallationParams)) params: VendorInstallationParams,
  ): Promise<VendorLicenceView> {
    return licenceView(await this.licences.summary(params.id));
  }

  @Patch('installations/:id/licence')
  @Vendor('LICENCES_MANAGE')
  async changeLicence(
    @Req() request: VendorRequest,
    @Param(new ZodPipe(VendorInstallationParams)) params: VendorInstallationParams,
    @Body(new ZodPipe(LicenceChangeRequest)) body: LicenceChangeRequest,
  ): Promise<VendorLicenceView> {
    return licenceView(await this.licences.change(params.id, body, vendorOf(request).actor));
  }

  @Post('installations/:id/licence/rebind')
  @HttpCode(200)
  @Vendor('LICENCE_REBIND')
  async rebind(
    @Req() request: VendorRequest,
    @Param(new ZodPipe(VendorInstallationParams)) params: VendorInstallationParams,
    @Body(new ZodPipe(ReasonRequest)) body: ReasonRequest,
  ): Promise<VendorLicenceView> {
    return licenceView(await this.licences.rebind(params.id, body.reason, vendorOf(request).actor));
  }

  @Post('installations/:id/licence/codes')
  @HttpCode(200)
  @Vendor('REACTIVATION_CODES')
  reactivationCode(
    @Req() request: VendorRequest,
    @Param(new ZodPipe(VendorInstallationParams)) params: VendorInstallationParams,
    @Body(new ZodPipe(ReactivationCodeRequest)) body: ReactivationCodeRequest,
  ): Promise<ReactivationCodeView> {
    return this.licences.reactivationCode(params.id, body.until, vendorOf(request).actor);
  }

  @Get('releases')
  @Vendor('FLEET_VIEW')
  async releasesList(): Promise<VendorReleaseListResponse> {
    return { releases: await this.releases.list() };
  }

  @Post('releases')
  @Vendor('RELEASES_MANAGE')
  publish(
    @Req() request: VendorRequest,
    @Body(new ZodPipe(PublishReleaseRequest)) body: z.output<typeof PublishReleaseRequest>,
  ): Promise<VendorReleaseView> {
    const { notes, ...release } = body;
    return this.releases.publish(
      { ...release, ...(notes !== null && { notes }) },
      vendorOf(request).actor,
    );
  }

  @Put('releases/:id/rollout')
  @Vendor('RELEASES_MANAGE')
  rollout(
    @Req() request: VendorRequest,
    @Param(new ZodPipe(VendorReleaseParams)) params: VendorReleaseParams,
    @Body(new ZodPipe(UpdateRolloutRequest)) body: z.output<typeof UpdateRolloutRequest>,
  ): Promise<VendorReleaseView> {
    return this.releases.updateRollout(params.id, body, vendorOf(request).actor);
  }

  @Put('installations/:id/pin')
  @Vendor('RELEASES_MANAGE')
  async pin(
    @Req() request: VendorRequest,
    @Param(new ZodPipe(VendorInstallationParams)) params: VendorInstallationParams,
    @Body(new ZodPipe(PinInstallationRequest)) body: PinInstallationRequest,
  ): Promise<VendorInstallationView> {
    await this.releases.pin(params.id, body.version, body.reason, vendorOf(request).actor);
    return this.fleet.installation(params.id);
  }

  @Get('audit')
  @Vendor('AUDIT_VIEW')
  async auditTrail(
    @Query(new ZodPipe(AuditQuery)) query: z.output<typeof AuditQuery>,
  ): Promise<AuditListResponse> {
    return { entries: await this.fleet.auditTrail(query) };
  }
}
