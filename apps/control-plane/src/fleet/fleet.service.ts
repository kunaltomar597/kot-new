import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  type AuditHeadView,
  type FleetAlertKind,
  type FleetAlertQuery,
  type FleetAlertView,
  type FleetInstallationView,
  type FleetResponse,
  HeartbeatRequest,
} from '@rp/contracts/control-plane';
import {
  type ChainHead,
  type ChainVerdict,
  checkChainHead,
  checkCheckpoint,
  diskUsedPercent,
  type FleetHealthInput,
  fleetAlertsDue,
  offlineMinutesDuringHours,
  SELF_RESOLVING_ALERTS,
} from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import { CP_CONFIG, type CpConfig } from '../config/cp-config.js';
import type { TransactionClient } from '../database/prisma.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { CpError } from '../errors/cp-error.js';
import type { FleetAlert, Installation, Prisma, Tenant } from '../generated/prisma/client.js';
import { newId } from '../ids.js';
import { ALERT_NOTIFIER, type AlertNotifier } from './alert-notifier.js';
import { alertText } from './fleet-text.js';

/** Who closes alerts the Control Plane closes by itself, in the audit log and on the alert. */
export const FLEET_ACTOR = 'system:fleet';
const HEADS_LISTED = 100;

type AlertRow = FleetAlert & { installation: Installation & { tenant: Tenant } };
type Client = TransactionClient | PrismaService;

function alertView(row: AlertRow): FleetAlertView {
  return {
    id: row.id,
    installationId: row.installationId,
    installationName: row.installation.name,
    tenantId: row.installation.tenantId,
    tenantName: row.installation.tenant.name,
    kind: row.kind,
    openedAt: row.openedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    details:
      row.details !== null && typeof row.details === 'object' && !Array.isArray(row.details)
        ? row.details
        : null,
    resolvedBy: row.resolvedBy,
    resolution: row.resolution,
  };
}

/** The latest heartbeat as the PC sent it, or undefined when it does not parse. */
function reportOf(payload: Prisma.JsonValue | null): HeartbeatRequest | undefined {
  if (payload === null) return undefined;
  const parsed = HeartbeatRequest.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Fleet monitoring (VCP-005, AUD-003, DATA-005, P7-03): every heartbeat records the PC's audit
 * chain head and answers to audit checks, and opens or closes the alerts its report calls for;
 * a sweep every minute finds PCs silent through business hours and sends alerts to the webhook.
 * At most one alert of each kind is open per PC.
 */
@Injectable()
export class FleetService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(FleetService.name);
  private timer: NodeJS.Timeout | undefined;
  /** Deliveries run one after another, so an alert is never sent twice by this instance. */
  private delivering: Promise<void> = Promise.resolve();

  constructor(
    @Inject(CP_CONFIG) private readonly config: CpConfig,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(ALERT_NOTIFIER) private readonly notifier: AlertNotifier,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.fleetSweepSeconds === 0) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.logger.error({ err: error }, 'The fleet sweep failed');
      });
    }, this.config.fleetSweepSeconds * 1_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  // ------------------------------------------------------------- heartbeats

  /**
   * In the heartbeat's transaction: the audit chain (AUD-003), then the alerts the report calls
   * for. Answers the audit check for the PC's next heartbeat.
   */
  async onHeartbeat(
    tx: TransactionClient,
    installationId: string,
    heartbeat: HeartbeatRequest,
    now: Date,
  ): Promise<{ auditCheck: { sequence: number } | null }> {
    const known = await tx.auditChainHead.findMany({
      where: { installationId, supersededAt: null },
      select: { id: true, sequence: true, hash: true },
    });
    const heads: (ChainHead & { id: string })[] = known.map((row) => ({
      id: row.id,
      sequence: Number(row.sequence),
      hash: row.hash,
    }));
    const mismatch = async (verdict: Exclude<ChainVerdict, { ok: true }>, check: boolean) => {
      await this.open(tx, installationId, 'AUDIT_CHAIN_MISMATCH', now, {
        reason: verdict.reason,
        sequence: verdict.sequence,
        reported: heartbeat.auditChainHead?.sequence ?? null,
        ...(check && { byAuditCheck: true }),
      });
    };

    const reported = heartbeat.auditChainHead;
    const verdict = checkChainHead(heads, reported);
    if (!verdict.ok) {
      await mismatch(verdict, false);
    } else if (reported !== null && !heads.some((head) => head.sequence === reported.sequence)) {
      await tx.auditChainHead.create({
        data: {
          id: newId(),
          installationId,
          sequence: BigInt(reported.sequence),
          hash: reported.hash,
          firstSeenAt: now,
        },
      });
    }

    const answer = heartbeat.auditCheckpoint;
    const asked =
      answer === undefined ? undefined : heads.find((head) => head.sequence === answer.sequence);
    if (answer !== undefined && asked !== undefined) {
      const result = checkCheckpoint(asked, answer);
      if (result === 'PURGED') {
        // Archived and purged on the PC (P7-06): nothing left to check there.
        await tx.auditChainHead.update({ where: { id: asked.id }, data: { supersededAt: now } });
      } else if (result.ok) {
        await tx.auditChainHead.update({ where: { id: asked.id }, data: { verifiedAt: now } });
      } else {
        await mismatch(result, true);
      }
    }

    // State alerts from this report; a heartbeat also means the PC is not offline.
    const due = fleetAlertsDue(this.healthInput(heartbeat, now, now));
    for (const kind of SELF_RESOLVING_ALERTS) {
      if (due.has(kind))
        await this.open(tx, installationId, kind, now, this.detailsOf(kind, heartbeat));
      else await this.close(tx, installationId, kind, now, FLEET_ACTOR, null);
    }

    // Ask about an earlier head, chosen at random, unless the chain is already in question.
    const chainAlert = await tx.fleetAlert.count({
      where: { installationId, kind: 'AUDIT_CHAIN_MISMATCH', resolvedAt: null },
    });
    const earlier = heads.filter((head) => reported !== null && head.sequence < reported.sequence);
    const pick = earlier[Math.floor(Math.random() * earlier.length)];
    return {
      auditCheck: chainAlert > 0 || pick === undefined ? null : { sequence: pick.sequence },
    };
  }

  private healthInput(
    report: HeartbeatRequest | undefined,
    lastSeenAt: Date | null,
    now: Date,
  ): FleetHealthInput {
    return {
      now,
      lastSeenAt,
      offlineAfterMinutes: this.config.offlineAlertMinutes,
      businessHours: report?.businessHours ?? null,
      disk: report?.disk ?? null,
      diskAlertPercent: this.config.diskAlertPercent,
      backup: report?.backup ?? null,
    };
  }

  private detailsOf(kind: FleetAlertKind, report: HeartbeatRequest): Prisma.InputJsonObject {
    if (kind === 'DISK_FULL' && report.disk !== null) {
      return { usedPercent: diskUsedPercent(report.disk), freeBytes: report.disk.freeBytes };
    }
    const backup = report.backup ?? null;
    if (kind === 'BACKUP_FAILED' && backup !== null) {
      return { error: backup.lastError, failedAt: backup.lastFailureAt };
    }
    return {};
  }

  // ----------------------------------------------------------------- alerts

  /** Opens an alert unless one of its kind is open for the PC; audited. */
  private async open(
    tx: TransactionClient,
    installationId: string,
    kind: FleetAlertKind,
    now: Date,
    details: Prisma.InputJsonObject,
  ): Promise<void> {
    const id = newId();
    // The partial unique index keeps one open alert per kind: a second is skipped.
    const { count } = await tx.fleetAlert.createMany({
      data: [
        {
          id,
          installationId,
          kind,
          openedAt: now,
          details,
          notifiedAt: this.notifier.configured ? null : now,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 0) return;
    await this.audit.record(tx, {
      actor: FLEET_ACTOR,
      action: 'fleet.alert_opened',
      targetType: 'installation',
      targetId: installationId,
      details: { alertId: id, kind, ...details },
    });
  }

  private async close(
    tx: TransactionClient,
    installationId: string,
    kind: FleetAlertKind,
    now: Date,
    by: string,
    resolution: string | null,
  ): Promise<void> {
    const open = await tx.fleetAlert.findFirst({
      where: { installationId, kind, resolvedAt: null },
      select: { id: true },
    });
    if (open === null) return;
    await tx.fleetAlert.update({
      where: { id: open.id },
      data: {
        resolvedAt: now,
        resolvedBy: by,
        resolution,
        resolutionNotifiedAt: this.notifier.configured ? null : now,
      },
    });
    await this.audit.record(tx, {
      actor: by,
      action: 'fleet.alert_resolved',
      targetType: 'installation',
      targetId: installationId,
      details: { alertId: open.id, kind, ...(resolution !== null && { reason: resolution }) },
    });
  }

  /**
   * PCs silent for longer than the threshold during their business hours (VCP-005), then the
   * alerts not yet sent to the webhook. Runs every minute; returns the alerts opened.
   */
  async sweep(now = new Date()): Promise<number> {
    const installations = await this.prisma.installation.findMany({
      where: { status: 'ACTIVE', lastSeenAt: { not: null } },
      select: { id: true, lastSeenAt: true, lastHeartbeat: true },
    });
    let opened = 0;
    for (const installation of installations) {
      const input = this.healthInput(
        reportOf(installation.lastHeartbeat),
        installation.lastSeenAt,
        now,
      );
      if (!fleetAlertsDue(input).has('OFFLINE')) continue;
      const before = await this.prisma.fleetAlert.count({
        where: { installationId: installation.id, kind: 'OFFLINE', resolvedAt: null },
      });
      if (before > 0) continue;
      await this.prisma.transaction((tx) =>
        this.open(tx, installation.id, 'OFFLINE', now, {
          minutes: offlineMinutesDuringHours(input),
          lastSeenAt: installation.lastSeenAt?.toISOString() ?? null,
        }),
      );
      opened += 1;
    }
    await this.deliver();
    return opened;
  }

  /** Sends opened and closed alerts to the webhook; what fails is tried on the next sweep. */
  deliver(): Promise<void> {
    this.delivering = this.delivering.then(() => this.deliverPending());
    return this.delivering;
  }

  private async deliverPending(): Promise<void> {
    if (!this.notifier.configured) return;
    const pending = await this.prisma.fleetAlert.findMany({
      where: {
        OR: [{ notifiedAt: null }, { resolvedAt: { not: null }, resolutionNotifiedAt: null }],
      },
      include: { installation: { include: { tenant: true } } },
      orderBy: { openedAt: 'asc' },
      take: 50,
    });
    for (const row of pending) {
      const view = alertView(row);
      try {
        if (row.notifiedAt === null) {
          // Opened (and maybe closed since): say it opened first.
          await this.notifier.send(alertText({ ...view, resolvedAt: null }), {
            ...view,
            resolvedAt: null,
          });
          await this.prisma.fleetAlert.update({
            where: { id: row.id },
            data: { notifiedAt: new Date() },
          });
        }
        if (row.resolvedAt !== null) {
          await this.notifier.send(alertText(view), view);
          await this.prisma.fleetAlert.update({
            where: { id: row.id },
            data: { resolutionNotifiedAt: new Date() },
          });
        }
      } catch (error) {
        this.logger.warn({ err: error, alertId: row.id }, 'A fleet alert could not be sent');
        return;
      }
    }
  }

  // ------------------------------------------------------------ vendor API

  async alerts(query: FleetAlertQuery): Promise<FleetAlertView[]> {
    const rows = await this.prisma.fleetAlert.findMany({
      where: {
        ...(query.state !== 'ALL' && { resolvedAt: null }),
        ...(query.installationId !== undefined && { installationId: query.installationId }),
      },
      include: { installation: { include: { tenant: true } } },
      orderBy: { openedAt: 'desc' },
      take: 500,
    });
    return rows.map(alertView);
  }

  /**
   * Closes an audit chain alert once someone looked into it (AUD-003, SEC-018): the heads seen so
   * far are set aside, so the chain counts from the head the PC reports next (a restore from
   * backup, say). The other kinds close by themselves.
   */
  async resolve(
    id: string,
    reason: string,
    actor: string,
    now = new Date(),
  ): Promise<FleetAlertView> {
    return this.prisma.transaction(async (tx) => {
      const alert = await tx.fleetAlert.findUnique({ where: { id } });
      if (alert === null) throw new CpError(404, 'NOT_FOUND', 'The alert was not found.');
      if (alert.resolvedAt !== null) {
        throw new CpError(409, 'ALERT_CLOSED', 'This alert is already closed.');
      }
      if (alert.kind !== 'AUDIT_CHAIN_MISMATCH') {
        throw new CpError(
          409,
          'ALERT_CLOSES_ITSELF',
          'This alert closes by itself once the PC reports the problem fixed.',
        );
      }
      await this.close(tx, alert.installationId, alert.kind, now, actor, reason);
      await tx.auditChainHead.updateMany({
        where: { installationId: alert.installationId, supersededAt: null },
        data: { supersededAt: now },
      });
      const row = await tx.fleetAlert.findUniqueOrThrow({
        where: { id },
        include: { installation: { include: { tenant: true } } },
      });
      return alertView(row);
    });
  }

  async auditHeads(installationId: string): Promise<AuditHeadView[]> {
    await this.installation(this.prisma, installationId);
    const rows = await this.prisma.auditChainHead.findMany({
      where: { installationId },
      orderBy: [{ firstSeenAt: 'desc' }, { sequence: 'desc' }],
      take: HEADS_LISTED,
    });
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      hash: row.hash,
      firstSeenAt: row.firstSeenAt.toISOString(),
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      superseded: row.supersededAt !== null,
    }));
  }

  /** Every PC's health from its latest heartbeat (VCP-005, NFR-O03). */
  async fleet(now = new Date()): Promise<FleetResponse> {
    const [installations, open, heads, verified, cloud, escrows] = await Promise.all([
      this.prisma.installation.findMany({
        include: { tenant: true, licence: { select: { state: true } } },
        orderBy: [{ tenant: { name: 'asc' } }, { name: 'asc' }],
      }),
      this.prisma.fleetAlert.findMany({
        where: { resolvedAt: null },
        select: { installationId: true, kind: true },
      }),
      this.prisma.auditChainHead.findMany({
        where: { supersededAt: null },
        orderBy: { sequence: 'desc' },
        distinct: ['installationId'],
        select: { installationId: true, sequence: true, hash: true },
      }),
      this.prisma.auditChainHead.groupBy({
        by: ['installationId'],
        where: { supersededAt: null },
        _max: { verifiedAt: true },
      }),
      // DATA-003: the newest backup each PC stored in the cloud (P7-05d).
      this.prisma.cloudBackup.groupBy({
        by: ['installationId'],
        where: { status: 'COMPLETE', kind: 'BACKUP' },
        _max: { backupCreatedAt: true },
      }),
      // P7-05e: the escrowed backup keys, to match each PC's current one.
      this.prisma.backupKeyEscrow.findMany({
        select: { installationId: true, keyId: true, createdAt: true },
      }),
    ]);
    // Online: heard from within two heartbeats and a minute.
    const onlineWithinMs = (2 * this.config.heartbeatSeconds + 60) * 1_000;
    const views = installations.map((installation): FleetInstallationView => {
      const report = reportOf(installation.lastHeartbeat);
      const head = heads.find((row) => row.installationId === installation.id);
      const verifiedAt = verified.find((row) => row.installationId === installation.id)?._max
        .verifiedAt;
      return {
        installationId: installation.id,
        installationName: installation.name,
        tenantId: installation.tenantId,
        tenantName: installation.tenant.name,
        status: installation.status,
        channel: installation.channel,
        online:
          installation.lastSeenAt !== null &&
          now.getTime() - installation.lastSeenAt.getTime() <= onlineWithinMs,
        lastSeenAt: installation.lastSeenAt?.toISOString() ?? null,
        components: report?.components ?? [],
        disk: report?.disk ? { ...report.disk, usedPercent: diskUsedPercent(report.disk) } : null,
        backup: report?.backup ?? null,
        cloudBackupAt:
          cloud
            .find((row) => row.installationId === installation.id)
            ?._max.backupCreatedAt?.toISOString() ?? null,
        backupKeyEscrowedAt:
          escrows
            .find(
              (row) =>
                row.installationId === installation.id &&
                row.keyId === (report?.backupKeyId ?? undefined),
            )
            ?.createdAt.toISOString() ?? null,
        // By type, as JSONB keeps no key order.
        devices: Object.entries(report?.devices ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([type, paired]) => ({
            type,
            paired,
            connected:
              report?.devicesConnected?.[type] ??
              (report?.devicesConnected === undefined ? null : 0),
          })),
        errorCount: report?.errorCount ?? null,
        licenceState: installation.licence?.state ?? null,
        auditHead:
          head === undefined
            ? null
            : {
                sequence: Number(head.sequence),
                hash: head.hash,
                verifiedAt: verifiedAt?.toISOString() ?? null,
              },
        openAlerts: open
          .filter((alert) => alert.installationId === installation.id)
          .map((alert) => alert.kind),
      };
    });
    return { installations: views, generatedAt: now.toISOString() };
  }

  private async installation(client: Client, id: string): Promise<Installation> {
    const installation = await client.installation.findUnique({ where: { id } });
    if (installation === null)
      throw new CpError(404, 'NOT_FOUND', 'The installation was not found.');
    return installation;
  }
}
