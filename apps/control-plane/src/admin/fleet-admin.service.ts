import { Injectable } from '@nestjs/common';
import type {
  ActivationCodeView,
  AuditEntryView,
  LicenceState,
  TenantRequest,
  VendorInstallationView,
  VendorTenantDetail,
  VendorTenantView,
} from '@rp/contracts/control-plane';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { CpError } from '../errors/cp-error.js';
import type { Installation, InstallationLicence, Tenant } from '../generated/prisma/client.js';
import { newId } from '../ids.js';
import {
  ENROLMENT_CODE_DAYS,
  generateEnrolmentCode,
  hashEnrolmentCode,
} from '../installations/enrolment-code.js';

const DAY_MS = 86_400_000;
/** Most severe first: a tenant's list row shows its most severe licence. */
const SEVERITY: readonly LicenceState[] = [
  'TERMINATED',
  'RESTRICTED',
  'GRACE',
  'PAYMENT_DUE',
  'ACTIVE',
];

type InstallationRow = Installation & { licence: InstallationLicence | null };

function notFound(what: string): CpError {
  return new CpError(404, 'NOT_FOUND', `${what} was not found.`);
}

/** The `RESTAURANT_PC` version from a stored heartbeat payload. */
function installedVersion(payload: unknown): string | null {
  const components = (payload as { components?: unknown } | null)?.components;
  if (!Array.isArray(components)) return null;
  for (const component of components as unknown[]) {
    const { name, version } = component as { name?: unknown; version?: unknown };
    if (name === 'RESTAURANT_PC' && typeof version === 'string') return version;
  }
  return null;
}

function installationView(installation: InstallationRow): VendorInstallationView {
  return {
    id: installation.id,
    tenantId: installation.tenantId,
    name: installation.name,
    status: installation.status,
    channel: installation.channel,
    enrolledAt: installation.enrolledAt?.toISOString() ?? null,
    lastSeenAt: installation.lastSeenAt?.toISOString() ?? null,
    version: installedVersion(installation.lastHeartbeat),
    licenceState: installation.licence?.state ?? null,
  };
}

function tenantView(tenant: Tenant, installations: readonly InstallationRow[]): VendorTenantView {
  const states = installations.flatMap((row) => (row.licence === null ? [] : [row.licence.state]));
  return {
    id: tenant.id,
    name: tenant.name,
    legalName: tenant.legalName,
    gstin: tenant.gstin,
    stateCode: tenant.stateCode,
    contactName: tenant.contactName ?? '',
    contactEmail: tenant.contactEmail,
    contactPhone: tenant.contactPhone,
    installations: installations.length,
    licenceState: SEVERITY.find((state) => states.includes(state)) ?? null,
    createdAt: tenant.createdAt.toISOString(),
  };
}

const WITH_LICENCE = { licence: true } as const;

/**
 * The fleet as vendor staff manage it (VCP-002, P7-02b): tenants with their contacts and GSTIN,
 * installations with activation codes, moving an installation to a new PC, revoking, and the
 * audit trail. Every change is audited with the vendor staff member as the actor.
 */
@Injectable()
export class FleetAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async tenants(): Promise<VendorTenantView[]> {
    const tenants = await this.prisma.tenant.findMany({
      orderBy: { name: 'asc' },
      include: { installations: { include: WITH_LICENCE } },
    });
    return tenants.map((tenant) => tenantView(tenant, tenant.installations));
  }

  async tenant(id: string): Promise<VendorTenantDetail> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      include: { installations: { include: WITH_LICENCE, orderBy: { createdAt: 'asc' } } },
    });
    if (tenant === null) throw notFound('The tenant');
    return {
      ...tenantView(tenant, tenant.installations),
      installationList: tenant.installations.map(installationView),
    };
  }

  async createTenant(request: TenantRequest, actor: string): Promise<VendorTenantView> {
    return this.prisma.transaction(async (tx) => {
      const tenant = await tx.tenant.create({ data: { id: newId(), ...request } });
      await this.audit.record(tx, {
        actor,
        action: 'tenant.created',
        targetType: 'tenant',
        targetId: tenant.id,
        details: { ...request },
      });
      return tenantView(tenant, []);
    });
  }

  async updateTenant(id: string, request: TenantRequest, actor: string): Promise<VendorTenantView> {
    return this.prisma.transaction(async (tx) => {
      const before = await tx.tenant.findUnique({ where: { id } });
      if (before === null) throw notFound('The tenant');
      const tenant = await tx.tenant.update({
        where: { id },
        data: request,
        include: { installations: { include: WITH_LICENCE } },
      });
      await this.audit.record(tx, {
        actor,
        action: 'tenant.changed',
        targetType: 'tenant',
        targetId: id,
        details: {
          before: {
            name: before.name,
            legalName: before.legalName,
            gstin: before.gstin,
            stateCode: before.stateCode,
            contactName: before.contactName,
            contactEmail: before.contactEmail,
            contactPhone: before.contactPhone,
          },
          after: { ...request },
        },
      });
      return tenantView(tenant, tenant.installations);
    });
  }

  async installation(id: string): Promise<VendorInstallationView> {
    const installation = await this.prisma.installation.findUnique({
      where: { id },
      include: WITH_LICENCE,
    });
    if (installation === null) throw notFound('The installation');
    return installationView(installation);
  }

  /**
   * Moves an installation to a new PC (VCP-002, LIC-004): a fresh activation code for it. The old
   * PC keeps working until the new one activates with the code; then the old PC's key is refused
   * and the licence binds the new PC.
   */
  async move(id: string, reason: string, actor: string): Promise<ActivationCodeView> {
    const code = generateEnrolmentCode();
    const expiresAt = new Date(Date.now() + ENROLMENT_CODE_DAYS * DAY_MS);
    return this.prisma.transaction(async (tx) => {
      const installation = await tx.installation.findUnique({ where: { id } });
      if (installation === null) throw notFound('The installation');
      if (installation.status !== 'ACTIVE') {
        throw new CpError(
          409,
          installation.status === 'PENDING' ? 'NOT_ACTIVATED' : 'INSTALLATION_REVOKED',
          installation.status === 'PENDING'
            ? 'This installation has not been activated yet: give it a new activation code.'
            : 'This installation was revoked.',
        );
      }
      await tx.installation.update({
        where: { id },
        data: { enrolmentCodeHash: hashEnrolmentCode(code), enrolmentCodeExpiresAt: expiresAt },
      });
      await this.audit.record(tx, {
        actor,
        action: 'installation.move_started',
        targetType: 'installation',
        targetId: id,
        details: { reason },
      });
      return { installationId: id, code, expiresAt: expiresAt.toISOString() };
    });
  }

  /** The audit trail, newest first, a page at a time. */
  async auditTrail(query: {
    readonly targetId?: string | undefined;
    readonly action?: string | undefined;
    readonly before?: number | undefined;
    readonly limit: number;
  }): Promise<AuditEntryView[]> {
    const entries = await this.prisma.auditEntry.findMany({
      where: {
        ...(query.targetId !== undefined && { targetId: query.targetId }),
        ...(query.action !== undefined && { action: query.action }),
        ...(query.before !== undefined && { id: { lt: BigInt(query.before) } }),
      },
      orderBy: { id: 'desc' },
      take: query.limit,
    });
    return entries.map((entry) => ({
      id: entry.id.toString(),
      at: entry.occurredAt.toISOString(),
      actor: entry.actor,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      details: entry.details ?? null,
    }));
  }
}
