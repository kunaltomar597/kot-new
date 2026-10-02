import { Inject, Injectable } from '@nestjs/common';
import type { HeartbeatRequest, HeartbeatResponse } from '@rp/contracts/control-plane';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedInstallation } from '../auth/installation.guard.js';
import { CP_CONFIG, type CpConfig } from '../config/cp-config.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { LicencesService } from '../licences/licences.service.js';
import { ReleasesService } from '../releases/releases.service.js';

/** The component whose version releases are compared with. */
const INSTALLER_COMPONENT = 'RESTAURANT_PC';

/** Heartbeat ingest (VCP-005, NFR-O03): store, summarise, answer with time and update. */
@Injectable()
export class HeartbeatsService {
  constructor(
    @Inject(CP_CONFIG) private readonly config: CpConfig,
    private readonly prisma: PrismaService,
    private readonly releases: ReleasesService,
    private readonly licences: LicencesService,
    private readonly audit: AuditService,
  ) {}

  async record(
    installation: AuthenticatedInstallation,
    heartbeat: HeartbeatRequest,
  ): Promise<HeartbeatResponse> {
    const receivedAt = new Date();
    const payload = heartbeat as Prisma.InputJsonObject;
    await this.prisma.transaction(async (tx) => {
      // The installation chooses the id: a retried heartbeat is stored once.
      const { count } = await tx.heartbeat.createMany({
        data: [
          {
            installationId: installation.id,
            id: heartbeat.heartbeatId,
            sentAt: new Date(heartbeat.sentAt),
            receivedAt,
            payload,
          },
        ],
        skipDuplicates: true,
      });
      await tx.installation.update({
        where: { id: installation.id },
        data: { lastSeenAt: receivedAt, ...(count === 1 && { lastHeartbeat: payload }) },
      });
      // LIC-007: what looked like tampering on the PC, once per heartbeat delivered.
      if (count === 1) {
        for (const event of heartbeat.tamper ?? []) {
          await this.audit.record(tx, {
            actor: `installation:${installation.id}`,
            action: 'licence.tamper',
            targetType: 'installation',
            targetId: installation.id,
            details: { kind: event.kind, at: event.at },
          });
        }
      }
    });
    const installed = heartbeat.components.find(
      (component) => component.name === INSTALLER_COMPONENT,
    );
    const update =
      installed === undefined
        ? null
        : await this.releases.updateFor(
            INSTALLER_COMPONENT,
            installation.channel,
            installed.version,
          );
    // A new licence when one is due (LIC-002), and every minute while it is not active (LIC-006).
    const licence = await this.licences.forHeartbeat(installation, heartbeat.licence, receivedAt);
    return {
      receivedAt: receivedAt.toISOString(),
      serverTime: new Date().toISOString(),
      nextHeartbeatSeconds: licence.heartbeatSeconds ?? this.config.heartbeatSeconds,
      update,
      licence: licence.licence,
      reactivationSecret: licence.reactivationSecret,
    };
  }
}
