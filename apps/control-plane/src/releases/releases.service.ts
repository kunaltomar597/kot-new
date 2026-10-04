import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  type HeartbeatRequest,
  type ReleaseChannel,
  type ReleaseComponent,
  ReleaseInfo,
  type RolloutState,
  type UpdateReport,
  UpdateRolloutRequest,
  type VendorReleaseView,
} from '@rp/contracts/control-plane';
import { compareVersionText, haltReason, releaseToOffer } from '@rp/domain';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { CP_CONFIG, type CpConfig } from '../config/cp-config.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { CpError } from '../errors/cp-error.js';
import { FleetService } from '../fleet/fleet.service.js';
import type { Prisma, Release } from '../generated/prisma/client.js';
import { newId } from '../ids.js';
import { parseVersion } from './semver.js';

/** What the vendor publishes (the admin CLI, the web app or the release pipeline). */
export const PublishRelease = ReleaseInfo.omit({ publishedAt: true, notes: true }).extend({
  notes: z.string().max(2_000).optional(),
  /** UPD-003: the share of the channel's PCs offered it at once. */
  rolloutPercent: z.int().min(0).max(100).default(100),
  /** UPD-002: a hotfix for one PC. */
  targetInstallationId: z.uuid().nullable().default(null),
});
export type PublishRelease = z.input<typeof PublishRelease>;

const ROLLOUT_ACTOR = 'system:rollout';
const DAY_MS = 86_400_000;
const FAILED = ['ROLLED_BACK', 'FAILED', 'SILENT'] as const;
const STATES: readonly RolloutState[] = ['ACTIVE', 'PAUSED', 'HALTED'];

type ReleaseRow = Release & {
  readonly targetInstallation: { readonly id: string; readonly name: string } | null;
};

function stateOf(release: Release): RolloutState {
  return STATES.find((state) => state === release.rolloutState) ?? 'PAUSED';
}

function toInfo(release: Release): ReleaseInfo {
  return {
    component: release.component,
    channel: release.channel,
    version: release.version,
    url: release.url,
    sha256: release.sha256,
    sizeBytes: Number(release.sizeBytes),
    notes: release.notes,
    publishedAt: release.publishedAt.toISOString(),
    securityCritical: release.securityCritical,
  };
}

/**
 * Release channels and staged rollouts (UPD-002, UPD-003, P7-04a): what each PC is offered, by the
 * rules in `@rp/domain` (`releaseToOffer`); how installing it went, from the PCs' heartbeats; and
 * the rollout halted by itself when too many fail. A failed install opens an `UPDATE_FAILED`
 * fleet alert for its PC, which closes when the PC runs that version or a newer one.
 */
@Injectable()
export class ReleasesService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReleasesService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly fleet: FleetService,
    @Inject(CP_CONFIG) private readonly config: CpConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.fleetSweepSeconds === 0) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.logger.error({ err: error }, 'The rollout sweep failed');
      });
    }, this.config.fleetSweepSeconds * 1_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  // ------------------------------------------------------------ the vendor's view

  private async views(where: Prisma.ReleaseWhereInput): Promise<VendorReleaseView[]> {
    const releases: ReleaseRow[] = await this.prisma.release.findMany({
      where,
      include: { targetInstallation: { select: { id: true, name: true } } },
      orderBy: { publishedAt: 'desc' },
    });
    if (releases.length === 0) return [];
    const ids = releases.map((release) => release.id);
    const [installs, cohort] = await Promise.all([
      this.prisma.releaseInstall.groupBy({
        by: ['releaseId', 'outcome', 'errorSpike'],
        where: { releaseId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.installation.findMany({
        where: { id: { in: [...new Set(releases.flatMap((release) => release.rolloutCohort))] } },
        select: { id: true, name: true },
      }),
    ]);
    const names = new Map(cohort.map((installation) => [installation.id, installation.name]));
    return releases.map((release) => {
      const counts = { attempts: 0, installed: 0, failures: 0, errorSpikes: 0 };
      for (const row of installs) {
        if (row.releaseId !== release.id) continue;
        const count = row._count._all;
        counts.attempts += count;
        if (row.outcome === 'INSTALLED') counts.installed += count;
        if ((FAILED as readonly string[]).includes(row.outcome)) counts.failures += count;
        if (row.errorSpike && row.outcome === 'INSTALLED') counts.errorSpikes += count;
      }
      return {
        ...toInfo(release),
        id: release.id,
        rollout: {
          percent: release.rolloutPercent,
          state: stateOf(release),
          cohort: release.rolloutCohort.map((id) => ({ id, name: names.get(id) ?? id })),
          haltReason: release.haltReason,
          changedAt: release.rolloutChangedAt.toISOString(),
        },
        target: release.targetInstallation,
        installs: counts,
      };
    });
  }

  /** Every release with its rollout, newest first (VCP-006). */
  list(): Promise<VendorReleaseView[]> {
    return this.views({});
  }

  private async view(id: string): Promise<VendorReleaseView> {
    const [view] = await this.views({ id });
    if (view === undefined) throw new CpError(404, 'NOT_FOUND', 'There is no such release.');
    return view;
  }

  async publish(input: PublishRelease, actor: string): Promise<VendorReleaseView> {
    const release = PublishRelease.parse(input);
    const existing = await this.prisma.release.findUnique({
      where: {
        component_channel_version: {
          component: release.component,
          channel: release.channel,
          version: release.version,
        },
      },
    });
    if (existing !== null) {
      throw new CpError(
        409,
        'RELEASE_EXISTS',
        `${release.component} ${release.version} is already on the ${release.channel} channel.`,
      );
    }
    if (
      release.targetInstallationId !== null &&
      (await this.prisma.installation.count({ where: { id: release.targetInstallationId } })) === 0
    ) {
      throw new CpError(422, 'INSTALLATION_UNKNOWN', 'There is no such PC for the hotfix.');
    }
    const id = newId();
    await this.prisma.transaction(async (tx) => {
      await tx.release.create({
        data: {
          id,
          component: release.component,
          channel: release.channel,
          version: release.version,
          url: release.url,
          sha256: release.sha256,
          sizeBytes: BigInt(release.sizeBytes),
          notes: release.notes ?? null,
          publishedBy: actor,
          securityCritical: release.securityCritical,
          rolloutPercent: release.rolloutPercent,
          targetInstallationId: release.targetInstallationId,
        },
      });
      await this.audit.record(tx, {
        actor,
        action: 'release.published',
        targetType: 'release',
        targetId: id,
        details: {
          component: release.component,
          channel: release.channel,
          version: release.version,
          sha256: release.sha256,
          securityCritical: release.securityCritical,
          rolloutPercent: release.rolloutPercent,
          targetInstallationId: release.targetInstallationId,
        },
      });
    });
    return this.view(id);
  }

  /** Widen, narrow, pause, resume or halt a rollout (UPD-003); audited with the reason. */
  async updateRollout(
    id: string,
    request: z.output<typeof UpdateRolloutRequest>,
    actor: string,
  ): Promise<VendorReleaseView> {
    const cohort = [...new Set(request.cohort)];
    if (
      cohort.length > 0 &&
      (await this.prisma.installation.count({ where: { id: { in: cohort } } })) !== cohort.length
    ) {
      throw new CpError(422, 'INSTALLATION_UNKNOWN', 'A PC in the cohort does not exist.');
    }
    await this.prisma.transaction(async (tx) => {
      const before = await tx.release.findUnique({ where: { id } });
      if (before === null) throw new CpError(404, 'NOT_FOUND', 'There is no such release.');
      await tx.release.update({
        where: { id },
        data: {
          rolloutPercent: request.percent,
          rolloutState: request.state,
          rolloutCohort: cohort,
          haltReason: request.state === 'HALTED' ? request.reason : null,
          rolloutChangedAt: new Date(),
        },
      });
      await this.audit.record(tx, {
        actor,
        action: 'release.rollout_changed',
        targetType: 'release',
        targetId: id,
        details: {
          version: before.version,
          reason: request.reason,
          before: {
            percent: before.rolloutPercent,
            state: before.rolloutState,
            cohort: before.rolloutCohort,
          },
          after: { percent: request.percent, state: request.state, cohort },
        },
      });
    });
    return this.view(id);
  }

  /** Hold a PC at a version, or let it follow its channel again (UPD-002); audited. */
  async pin(
    installationId: string,
    version: string | null,
    reason: string,
    actor: string,
  ): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      const before = await tx.installation.findUnique({
        where: { id: installationId },
        select: { pinnedVersion: true },
      });
      if (before === null) throw new CpError(404, 'NOT_FOUND', 'The installation was not found.');
      await tx.installation.update({
        where: { id: installationId },
        data: { pinnedVersion: version },
      });
      await this.audit.record(tx, {
        actor,
        action: 'installation.pinned',
        targetType: 'installation',
        targetId: installationId,
        details: { reason, before: before.pinnedVersion, after: version },
      });
    });
  }

  // ------------------------------------------------------------ what a PC is offered

  /** The releases a PC may be offered: its channel's, and the hotfixes for it. */
  private candidates(
    installation: { readonly id: string; readonly channel: ReleaseChannel },
    component: ReleaseComponent,
  ): Promise<Release[]> {
    return this.prisma.release.findMany({
      where: {
        component,
        OR: [
          { channel: installation.channel, targetInstallationId: null },
          { targetInstallationId: installation.id },
        ],
      },
    });
  }

  /** The release this PC should move to, or null (UPD-002, UPD-003). */
  async offerFor(
    installationId: string,
    component: ReleaseComponent,
    currentVersion: string,
  ): Promise<ReleaseInfo | null> {
    const installation = await this.prisma.installation.findUnique({
      where: { id: installationId },
      select: { id: true, channel: true, pinnedVersion: true },
    });
    if (installation === null || parseVersion(currentVersion) === undefined) return null;
    const releases = await this.candidates(installation, component);
    const offer = releaseToOffer(
      { id: installation.id, version: currentVersion, pinnedVersion: installation.pinnedVersion },
      releases.map((release) => ({
        release,
        id: release.id,
        version: release.version,
        percent: release.rolloutPercent,
        state: stateOf(release),
        cohort: release.rolloutCohort,
        targetInstallationId: release.targetInstallationId,
      })),
    );
    return offer === undefined ? null : toInfo(offer.release);
  }

  // ------------------------------------------------------------ how installs go

  /** The release a PC means by a version: its channel's, or a hotfix for it. */
  private async releaseOf(
    tx: TransactionClient,
    installation: { readonly id: string; readonly channel: ReleaseChannel },
    component: ReleaseComponent,
    version: string,
  ): Promise<Release | null> {
    const releases = await tx.release.findMany({
      where: {
        component,
        version,
        OR: [{ channel: installation.channel }, { targetInstallationId: installation.id }],
      },
    });
    return (
      releases.find((release) => release.targetInstallationId === installation.id) ??
      releases[0] ??
      null
    );
  }

  /**
   * From a heartbeat: the PC's update report, the version it runs and its server errors, for the
   * rollouts' health. Returns the releases whose health changed.
   */
  async recordHeartbeat(
    tx: TransactionClient,
    installation: { readonly id: string; readonly channel: ReleaseChannel },
    component: ReleaseComponent,
    heartbeat: HeartbeatRequest,
    now: Date,
  ): Promise<string[]> {
    const changed = new Set<string>();
    const report = heartbeat.updateReport ?? null;
    if (report !== null) {
      const release = await this.releaseOf(tx, installation, component, report.version);
      if (release !== null) {
        await this.recordReport(tx, release, installation.id, report, now);
        changed.add(release.id);
      }
    }
    const running = heartbeat.components.find((entry) => entry.name === component)?.version;
    if (running !== undefined) {
      const release = await this.releaseOf(tx, installation, component, running);
      if (release !== null) {
        const install = await tx.releaseInstall.findUnique({
          where: {
            releaseId_installationId: { releaseId: release.id, installationId: installation.id },
          },
        });
        // Running it: installed, unless the PC itself said the install failed after this.
        if (install === null || install.outcome === 'INSTALLING' || install.outcome === 'SILENT') {
          await tx.releaseInstall.upsert({
            where: {
              releaseId_installationId: { releaseId: release.id, installationId: installation.id },
            },
            create: {
              releaseId: release.id,
              installationId: installation.id,
              outcome: 'INSTALLED',
              installedAt: now,
            },
            update: { outcome: 'INSTALLED', installedAt: now },
          });
          changed.add(release.id);
        }
      }
      await this.closeFailures(tx, installation.id, running, now);
    }
    // Server errors in the day after an install (UPD-003: an error spike).
    const errors = heartbeat.errorCount ?? 0;
    if (errors > 0) {
      const recent = await tx.releaseInstall.findMany({
        where: {
          installationId: installation.id,
          outcome: 'INSTALLED',
          installedAt: { gt: new Date(now.getTime() - DAY_MS) },
        },
      });
      for (const install of recent) {
        const total = install.errorsAfter + errors;
        await tx.releaseInstall.update({
          where: {
            releaseId_installationId: {
              releaseId: install.releaseId,
              installationId: installation.id,
            },
          },
          data: { errorsAfter: total, errorSpike: total >= this.config.rolloutErrorSpike },
        });
        if (!install.errorSpike && total >= this.config.rolloutErrorSpike)
          changed.add(install.releaseId);
      }
    }
    for (const releaseId of changed) await this.haltIfUnhealthy(tx, releaseId);
    return [...changed];
  }

  private async recordReport(
    tx: TransactionClient,
    release: Release,
    installationId: string,
    report: UpdateReport,
    now: Date,
  ): Promise<void> {
    const at = new Date(report.at);
    const key = { releaseId_installationId: { releaseId: release.id, installationId } };
    const data: Prisma.ReleaseInstallUncheckedUpdateInput = {
      outcome: report.outcome,
      error: report.error,
    };
    if (report.outcome === 'INSTALLING') data.startedAt = at;
    if (report.outcome === 'INSTALLED') data.installedAt = at;
    if (report.outcome === 'ROLLED_BACK' || report.outcome === 'FAILED') data.failedAt = at;
    const before = await tx.releaseInstall.findUnique({ where: key });
    // A report seen again (it rides on every heartbeat until acknowledged) changes nothing.
    if (before?.outcome === report.outcome) return;
    await tx.releaseInstall.upsert({
      where: key,
      create: {
        releaseId: release.id,
        installationId,
        outcome: report.outcome,
        error: report.error,
        startedAt: report.outcome === 'INSTALLING' ? at : null,
        installedAt: report.outcome === 'INSTALLED' ? at : null,
        failedAt: report.outcome === 'ROLLED_BACK' || report.outcome === 'FAILED' ? at : null,
      },
      update: data,
    });
    if (report.outcome === 'ROLLED_BACK' || report.outcome === 'FAILED') {
      await this.fleet.updateFailed(tx, installationId, now, {
        version: release.version,
        outcome: report.outcome,
        error: report.error,
      });
    }
  }

  /** The PC runs a version: failed updates to it, or to an older one, are behind it. */
  private async closeFailures(
    tx: TransactionClient,
    installationId: string,
    running: string,
    now: Date,
  ): Promise<void> {
    const open = await tx.fleetAlert.findFirst({
      where: { installationId, kind: 'UPDATE_FAILED', resolvedAt: null },
      select: { details: true },
    });
    if (open === null) return;
    const failed = (open.details as { version?: unknown } | null)?.version;
    if (typeof failed === 'string' && compareVersionText(running, failed) >= 0) {
      await this.fleet.updateSucceeded(tx, installationId, now);
    }
  }

  /** PCs that started installing and went silent count as failed installs (UPD-003). */
  async sweep(now = new Date()): Promise<number> {
    const before = new Date(now.getTime() - this.config.rolloutSilentMinutes * 60_000);
    const silent = await this.prisma.releaseInstall.findMany({
      where: { outcome: 'INSTALLING', startedAt: { lt: before } },
      include: { release: { select: { version: true } } },
    });
    for (const install of silent) {
      await this.prisma.transaction(async (tx) => {
        const { count } = await tx.releaseInstall.updateMany({
          where: {
            releaseId: install.releaseId,
            installationId: install.installationId,
            outcome: 'INSTALLING',
          },
          data: {
            outcome: 'SILENT',
            failedAt: now,
            error: 'No heartbeat after it started installing.',
          },
        });
        if (count === 0) return;
        await this.fleet.updateFailed(tx, install.installationId, now, {
          version: install.release.version,
          outcome: 'SILENT',
          error: null,
        });
        await this.haltIfUnhealthy(tx, install.releaseId);
      });
    }
    if (silent.length > 0) void this.fleet.deliver().catch(() => undefined);
    return silent.length;
  }

  /** Halts an active rollout when too many of its installs failed or spiked (UPD-003). */
  private async haltIfUnhealthy(tx: TransactionClient, releaseId: string): Promise<void> {
    const release = await tx.release.findUnique({ where: { id: releaseId } });
    if (release?.rolloutState !== 'ACTIVE') return;
    const installs = await tx.releaseInstall.findMany({ where: { releaseId } });
    const reason = haltReason(
      {
        attempts: installs.length,
        failures: installs.filter((install) =>
          (FAILED as readonly string[]).includes(install.outcome),
        ).length,
        errorSpikes: installs.filter(
          (install) => install.outcome === 'INSTALLED' && install.errorSpike,
        ).length,
      },
      {
        minFailures: this.config.rolloutMinFailures,
        maxFailureShare: this.config.rolloutMaxFailurePercent / 100,
      },
    );
    if (reason === undefined) return;
    await tx.release.update({
      where: { id: releaseId },
      data: { rolloutState: 'HALTED', haltReason: reason, rolloutChangedAt: new Date() },
    });
    await this.audit.record(tx, {
      actor: ROLLOUT_ACTOR,
      action: 'release.rollout_halted',
      targetType: 'release',
      targetId: releaseId,
      details: { version: release.version, reason },
    });
    this.logger.warn({ releaseId, version: release.version }, reason);
  }
}
