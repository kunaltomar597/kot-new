import { Injectable } from '@nestjs/common';
import type { ReleaseChannel, ReleaseInfo } from '@rp/contracts/control-plane';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { CpError } from '../errors/cp-error.js';
import { newId } from '../ids.js';
import {
  ENROLMENT_CODE_DAYS,
  generateEnrolmentCode,
  hashEnrolmentCode,
} from '../installations/enrolment-code.js';
import { type PublishRelease, ReleasesService } from '../releases/releases.service.js';

const DAY_MS = 86_400_000;

export interface IssuedCode {
  readonly installationId: string;
  /** Shown once; the database keeps only its hash. */
  readonly code: string;
  readonly expiresAt: Date;
}

export interface InstallationSummary {
  readonly id: string;
  readonly tenant: string;
  readonly name: string;
  readonly status: string;
  readonly channel: ReleaseChannel;
  readonly lastSeenAt: Date | null;
  readonly version: string | null;
}

function notFound(what: string): CpError {
  return new CpError(404, 'NOT_FOUND', `${what} was not found.`);
}

/**
 * What vendor staff do until the web app (VCP-001, P7-02): the admin CLI calls these. Every
 * action is audited with its actor (`cli:<user>` or `ci:<pipeline>`).
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly releases: ReleasesService,
  ) {}

  async createTenant(name: string, actor: string): Promise<{ id: string; name: string }> {
    const trimmed = name.trim();
    if (trimmed === '' || trimmed.length > 120) {
      throw new CpError(400, 'VALIDATION_FAILED', 'A tenant needs a name of 1 to 120 characters.');
    }
    return this.prisma.transaction(async (tx) => {
      const tenant = await tx.tenant.create({ data: { id: newId(), name: trimmed } });
      await this.audit.record(tx, {
        actor,
        action: 'tenant.created',
        targetType: 'tenant',
        targetId: tenant.id,
        details: { name: tenant.name },
      });
      return { id: tenant.id, name: tenant.name };
    });
  }

  /** A new installation of a tenant, waiting for its PC to enrol with the returned code. */
  async createInstallation(
    input: { tenantId: string; name: string; channel?: ReleaseChannel },
    actor: string,
  ): Promise<IssuedCode> {
    const name = input.name.trim();
    if (name === '' || name.length > 120) {
      throw new CpError(
        400,
        'VALIDATION_FAILED',
        'An installation needs a name of 1 to 120 characters.',
      );
    }
    const code = generateEnrolmentCode();
    const expiresAt = new Date(Date.now() + ENROLMENT_CODE_DAYS * DAY_MS);
    return this.prisma.transaction(async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: input.tenantId } });
      if (tenant === null) throw notFound('The tenant');
      const installation = await tx.installation.create({
        data: {
          id: newId(),
          tenantId: tenant.id,
          name,
          channel: input.channel ?? 'STABLE',
          enrolmentCodeHash: hashEnrolmentCode(code),
          enrolmentCodeExpiresAt: expiresAt,
        },
      });
      await this.audit.record(tx, {
        actor,
        action: 'installation.created',
        targetType: 'installation',
        targetId: installation.id,
        details: { tenantId: tenant.id, name, channel: installation.channel },
      });
      return { installationId: installation.id, code, expiresAt };
    });
  }

  /** A fresh code for an installation that has not enrolled yet (the old one stops working). */
  async issueEnrolmentCode(installationId: string, actor: string): Promise<IssuedCode> {
    const code = generateEnrolmentCode();
    const expiresAt = new Date(Date.now() + ENROLMENT_CODE_DAYS * DAY_MS);
    return this.prisma.transaction(async (tx) => {
      const installation = await tx.installation.findUnique({ where: { id: installationId } });
      if (installation === null) throw notFound('The installation');
      if (installation.status !== 'PENDING') {
        throw new CpError(
          409,
          'ALREADY_ENROLLED',
          'This installation already enrolled; moving it to another PC comes with P7-02.',
        );
      }
      await tx.installation.update({
        where: { id: installationId },
        data: { enrolmentCodeHash: hashEnrolmentCode(code), enrolmentCodeExpiresAt: expiresAt },
      });
      await this.audit.record(tx, {
        actor,
        action: 'installation.code_issued',
        targetType: 'installation',
        targetId: installationId,
      });
      return { installationId, code, expiresAt };
    });
  }

  /** Disconnects an installation: its signed requests are refused from now on. */
  async revokeInstallation(installationId: string, reason: string, actor: string): Promise<void> {
    const why = reason.trim();
    if (why === '') throw new CpError(400, 'VALIDATION_FAILED', 'Revoking needs a reason.');
    await this.prisma.transaction(async (tx) => {
      const installation = await tx.installation.findUnique({ where: { id: installationId } });
      if (installation === null) throw notFound('The installation');
      await tx.installation.update({
        where: { id: installationId },
        data: {
          status: 'REVOKED',
          revokedAt: new Date(),
          enrolmentCodeHash: null,
          enrolmentCodeExpiresAt: null,
        },
      });
      await this.audit.record(tx, {
        actor,
        action: 'installation.revoked',
        targetType: 'installation',
        targetId: installationId,
        details: { reason: why, previousStatus: installation.status },
      });
    });
  }

  publishRelease(input: PublishRelease, actor: string): Promise<ReleaseInfo> {
    return this.releases.publish(input, actor);
  }

  async listInstallations(): Promise<InstallationSummary[]> {
    const installations = await this.prisma.installation.findMany({
      include: { tenant: { select: { name: true } } },
      orderBy: [{ tenantId: 'asc' }, { createdAt: 'asc' }],
    });
    return installations.map((installation) => ({
      id: installation.id,
      tenant: installation.tenant.name,
      name: installation.name,
      status: installation.status,
      channel: installation.channel,
      lastSeenAt: installation.lastSeenAt,
      version: installedVersion(installation.lastHeartbeat),
    }));
  }
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
