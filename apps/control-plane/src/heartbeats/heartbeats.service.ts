import { Inject, Injectable } from '@nestjs/common';
import type { HeartbeatRequest, HeartbeatResponse } from '@rp/contracts/control-plane';
import { AuditService } from '../audit/audit.service.js';
import { BackupEscrowService } from '../cloud-backups/backup-escrow.service.js';
import type { AuthenticatedInstallation } from '../auth/installation.guard.js';
import { CP_CONFIG, type CpConfig } from '../config/cp-config.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { LicencesService } from '../licences/licences.service.js';
import { DiagnosticsService } from '../diagnostics/diagnostics.service.js';
import { FleetService } from '../fleet/fleet.service.js';
import { ReleasesService } from '../releases/releases.service.js';
import { RemoteSettingsService } from '../remote-settings/remote-settings.service.js';
import { SupportService } from '../support/support.service.js';

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
    private readonly support: SupportService,
    private readonly fleet: FleetService,
    private readonly diagnostics: DiagnosticsService,
    private readonly remoteSettings: RemoteSettingsService,
    private readonly escrow: BackupEscrowService,
  ) {}

  async record(
    installation: AuthenticatedInstallation,
    heartbeat: HeartbeatRequest,
  ): Promise<HeartbeatResponse> {
    const receivedAt = new Date();
    const payload = heartbeat as Prisma.InputJsonObject;
    const { auditCheck } = await this.prisma.transaction(async (tx) => {
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
      // UPD-003: how installing releases went, for the rollouts' health (P7-04a), and the pager
      // firmware the PC took or its pagers rolled back from (P2-04b).
      await this.releases.recordHeartbeat(
        tx,
        installation,
        INSTALLER_COMPONENT,
        heartbeat,
        receivedAt,
      );
      if (heartbeat.pagerFirmware !== undefined) {
        await this.releases.recordHeartbeat(
          tx,
          installation,
          'PAGER_FIRMWARE',
          heartbeat,
          receivedAt,
        );
      }
      // VCP-005, AUD-003: the chain head and audit check, and the alerts the report calls for.
      return this.fleet.onHeartbeat(tx, installation.id, heartbeat, receivedAt);
    });
    // Alerts opened or closed just now go out at once, not at the next sweep.
    void this.fleet.deliver().catch(() => undefined);
    const installed = heartbeat.components.find(
      (component) => component.name === INSTALLER_COMPONENT,
    );
    const update =
      installed === undefined
        ? null
        : await this.releases.offerFor(installation.id, INSTALLER_COMPONENT, installed.version);
    // Pager firmware for a PC that passes it on (PGR-011, P2-04b).
    const pagerFirmware =
      heartbeat.pagerFirmware === undefined
        ? null
        : await this.releases.pagerFirmwareFor(installation, heartbeat.pagerFirmware.version);
    // A new licence when one is due (LIC-002), and every minute while it is not active (LIC-006).
    const licence = await this.licences.forHeartbeat(installation, heartbeat.licence, receivedAt);
    // The QR relay credential, until the PC holds it (VCP-002).
    const relayCredential = await this.support.relayCredentialFor(
      installation.tenantId,
      heartbeat.relay?.credentialDigest,
    );
    return {
      receivedAt: receivedAt.toISOString(),
      serverTime: new Date().toISOString(),
      nextHeartbeatSeconds: licence.heartbeatSeconds ?? this.config.heartbeatSeconds,
      update,
      licence: licence.licence,
      reactivationSecret: licence.reactivationSecret,
      relayCredential,
      auditCheck,
      // Support's open requests for diagnostics, for a manager to answer (UPD-008).
      diagnosticsRequests: await this.diagnostics.pendingFor(installation.id, receivedAt),
      // Vendor settings and feature flags, until the PC holds them (UPD-010).
      vendorSettings: await this.remoteSettings.forHeartbeat(
        installation.id,
        heartbeat.vendorSettings,
      ),
      // The escrow key, until the PC's backup key is escrowed (DATA-003, P7-05e).
      backupKeyEscrow: await this.escrow.offerFor(installation.id, heartbeat.backupKeyId),
      // Restore codes issued for this restaurant: its Owner is told (OI-10).
      restoreCodes: await this.escrow.noticesFor(
        installation.id,
        heartbeat.restoreCodesSeen,
        receivedAt,
      ),
      pagerFirmware,
    };
  }
}
