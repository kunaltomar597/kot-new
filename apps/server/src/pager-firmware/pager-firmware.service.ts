import { randomBytes } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type {
  PagerFirmwareOffer,
  PagerFirmwarePagerView,
  PagerFirmwareProblem,
  PagerFirmwareResponse,
  PagerHeartbeat,
} from '@rp/contracts';
import type { ReleaseInfo, UpdateReport } from '@rp/contracts/control-plane';
import {
  DEFAULT_TIME_ZONE,
  inTimeWindow,
  isNewerVersion,
  PAGER_FIRMWARE_MAX_BYTES,
  type PagerFirmwareAttempt,
  type PagerFirmwareState,
  pagerFirmwareTimedOut,
  type PagerFirmwareVerdict,
  pagerFirmwareVerdict,
  reachesPagerAndApp,
  timeOfDayOf,
  updateDownloadRetryMs,
} from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { HeartbeatService } from '../cloud/heartbeat.service.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import type { Device, PagerFirmwareUpdate } from '../generated/prisma/client.js';
import { type ConnectedPager, PagerBroker } from '../pagers/pager-broker.js';
import { SettingsService } from '../settings/settings.service.js';
import { TlsService } from '../tls/tls.service.js';
import { downloadInstaller, UpdateDownloadError } from '../updates/update-download.js';
import { checkFirmwareImage, FirmwareImageError } from './firmware-image.js';
import { PAGER_FIRMWARE_KEY_DIGESTS } from './firmware-keys.js';
import {
  firmwareDir,
  firmwareFileName,
  type FirmwareProblem,
  isHalted,
  readFirmwareProblem,
  readOfferedFirmware,
  readServedFirmware,
  saveFirmwareProblem,
  saveFirmwareReport,
  saveServedFirmware,
  type ServedFirmware,
} from './firmware-state.js';

export const PAGER_FIRMWARE_OPTIONS = Symbol('PAGER_FIRMWARE_OPTIONS');

export interface PagerFirmwareOptions {
  /** Wait after start-up before the first look. */
  readonly firstDelayMs: number;
  /** How often it looks; 0 never schedules (tests call `runOnce`). */
  readonly tickMs: number;
  /** How long a download token in an offer is valid. */
  readonly tokenTtlMs: number;
  readonly fetch?: typeof fetch;
  readonly now: () => Date;
}

export const DEFAULT_PAGER_FIRMWARE_OPTIONS: PagerFirmwareOptions = {
  firstDelayMs: 30_000,
  tickMs: 60_000,
  tokenTtlMs: 15 * 60_000,
  now: () => new Date(),
};

interface DownloadGrant {
  readonly deviceId: string;
  readonly version: string;
  readonly attempt: number;
  readonly expiresAt: number;
}

/** Download problems worth trying again; anything else means the release is not what it says. */
const RETRIED: ReadonlySet<PagerFirmwareProblem> = new Set(['NOT_HTTPS', 'HTTP_STATUS', 'NETWORK']);

const IN_PROGRESS: readonly PagerFirmwareState[] = ['OFFERED', 'DOWNLOADING'];
/** A pager reports a rollback after booting an offered image; the server may have timed it out. */
const ROLLBACK_FROM: readonly PagerFirmwareState[] = ['OFFERED', 'DOWNLOADING', 'FAILED'];

function plain(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function attemptOf(row: PagerFirmwareUpdate | null): PagerFirmwareAttempt | null {
  return row === null
    ? null
    : {
        state: row.state as PagerFirmwareState,
        attempts: row.attempts,
        changedAt: row.changedAt,
        requestedAt: row.requestedAt,
      };
}

/** An offer under way that has not timed out. */
function underWay(row: PagerFirmwareUpdate | null, now: Date): boolean {
  const attempt = attemptOf(row);
  return (
    attempt !== null && IN_PROGRESS.includes(attempt.state) && !pagerFirmwareTimedOut(attempt, now)
  );
}

/**
 * Pager firmware through the restaurant PC (PGR-011, UPD-001, UPD-003, UPD-007, P2-04b):
 *
 * 1. the firmware release the Control Plane offers (heartbeat answer) is downloaded over HTTPS,
 *    its size and SHA-256 checked, and the image checked: the pager project for the ESP32-S3, the
 *    release's version, and a secure boot signature by a key built into the software. A release
 *    that fails a check is refused for good and reported; a failed download is tried again;
 * 2. each connected pager that is free (`pagerFirmwareVerdict`) is offered it on its own `ota`
 *    topic with a short-lived download token; a few pagers at a time;
 * 3. the pager's heartbeats say how it went: downloading, failed (tried again later), rolled back
 *    (never offered that version again; reported, so the vendor's rollout halts when it spreads),
 *    or running the new version;
 * 4. a halted rollout stops the offers; a manager's "Update now" offers it outside the window.
 */
@Injectable()
export class PagerFirmwareService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PagerFirmwareService.name);
  private readonly grants = new Map<string, DownloadGrant>();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private running: Promise<void> | undefined;
  /** Offers are decided one pager at a time, so no more than the limit update at once. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Heartbeats being acted on. */
  private readonly hearing = new Set<Promise<void>>();
  private readonly aborter = new AbortController();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly broker: PagerBroker,
    private readonly heartbeat: HeartbeatService,
    private readonly tls: TlsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PAGER_FIRMWARE_OPTIONS) private readonly options: PagerFirmwareOptions,
  ) {}

  onApplicationBootstrap(): void {
    this.broker.onHeartbeat((pager, beat) => {
      const work = this.heard(pager, beat).finally(() => {
        this.hearing.delete(work);
      });
      this.hearing.add(work);
      return work;
    });
    if (this.options.tickMs <= 0) return;
    // A new release arrives with a heartbeat's answer: look at once.
    this.heartbeat.onAnswer(() => {
      this.schedule(0);
      return Promise.resolve();
    });
    this.schedule(this.options.firstDelayMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.aborter.abort();
    await this.running?.catch(() => undefined);
    await this.settled();
  }

  /** Once every heartbeat heard so far has been acted on (shutdown, and tests). */
  async settled(): Promise<void> {
    while (this.hearing.size > 0) await Promise.allSettled([...this.hearing]);
    await this.queue.catch(() => undefined);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.runOnce()
        .catch((error: unknown) => {
          this.logger.error({ err: error }, 'The pager firmware pass failed');
        })
        .finally(() => {
          this.schedule(this.options.tickMs);
        });
    }, delayMs);
    this.timer.unref();
  }

  /** Fetches and checks the release on offer, then offers the firmware to free pagers. */
  runOnce(): Promise<void> {
    this.running ??= (async () => {
      const restaurant = await this.prisma.restaurant.findFirst({ select: { id: true } });
      if (restaurant === null) return;
      await this.fetchOffered(restaurant.id);
      for (const pager of this.broker.connectedPagers()) await this.consider(pager);
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** The keys the PC trusts: those built in, plus development and test keys. */
  private trustedKeys(): string[] {
    return [...PAGER_FIRMWARE_KEY_DIGESTS, ...this.config.pagerFirmwareKeys];
  }

  // ------------------------------------------------------------ the release from the vendor

  private async fetchOffered(restaurantId: string): Promise<void> {
    const [offer, served, problem] = await Promise.all([
      readOfferedFirmware(this.prisma),
      readServedFirmware(this.prisma),
      readFirmwareProblem(this.prisma),
    ]);
    const release = offer.update;
    if (release?.component !== 'PAGER_FIRMWARE') return;
    if (served !== null && !isNewerVersion(release.version, served.version)) return;
    const now = this.options.now();
    const same = problem?.version === release.version && problem.sha256 === release.sha256;
    if (same && problem.refused) return;
    if (same && problem.retryAt !== null && Date.parse(problem.retryAt) > now.getTime()) return;
    const keys = this.trustedKeys();
    if (keys.length === 0) {
      if (!same || problem.code !== 'NO_TRUSTED_KEY') {
        await this.failed(
          restaurantId,
          release,
          'NO_TRUSTED_KEY',
          'This software trusts no pager firmware key yet, so it passes no firmware on.',
          false,
          0,
        );
        this.logger.warn(
          { version: release.version },
          'Pager firmware is offered, but this software trusts no firmware key: not passed on',
        );
      }
      return;
    }
    if (release.sizeBytes > PAGER_FIRMWARE_MAX_BYTES) {
      await this.failed(
        restaurantId,
        release,
        'TOO_LARGE',
        `The release is ${String(release.sizeBytes)} bytes; pager firmware is at most ${String(PAGER_FIRMWARE_MAX_BYTES)}.`,
        true,
        0,
      );
      return;
    }
    const fileName = firmwareFileName(release.version);
    const target = join(firmwareDir(this.config.dataDir), fileName);
    try {
      await downloadInstaller({
        url: release.url,
        sha256: release.sha256,
        sizeBytes: release.sizeBytes,
        target,
        timeoutMs: 10 * 60_000,
        signal: this.aborter.signal,
        ...(this.options.fetch !== undefined && { fetch: this.options.fetch }),
      });
    } catch (error) {
      if (!(error instanceof UpdateDownloadError)) throw error;
      const retried = RETRIED.has(error.problem);
      const failures = same && !problem.refused ? problem.failures + 1 : 1;
      await this.failed(restaurantId, release, error.problem, error.message, !retried, failures);
      return;
    }
    let checked;
    try {
      checked = checkFirmwareImage(await readFile(target), release, keys);
    } catch (error) {
      await rm(target, { force: true });
      if (!(error instanceof FirmwareImageError)) throw error;
      await this.failed(
        restaurantId,
        release,
        error.problem,
        error.message,
        error.problem !== 'NO_TRUSTED_KEY',
        0,
      );
      return;
    }
    const accepted: ServedFirmware = {
      version: release.version,
      sha256: release.sha256,
      sizeBytes: release.sizeBytes,
      fileName,
      keyDigest: checked.keyDigest,
      acceptedAt: now.toISOString(),
    };
    await this.prisma.transaction(async (tx) => {
      await saveServedFirmware(tx, accepted);
      await saveFirmwareProblem(tx, null);
      await saveFirmwareReport(tx, this.report(release.version, 'INSTALLED', null));
      await this.audit.record(tx, {
        action: 'PAGER_FIRMWARE_ACCEPTED',
        entityType: 'pager_firmware',
        entityId: null,
        restaurantId,
        before: served === null ? null : { version: served.version },
        after: {
          version: release.version,
          channel: release.channel,
          sha256: release.sha256,
          keyDigest: checked.keyDigest,
          secureVersion: checked.info.secureVersion,
        },
        reason: null,
      });
    });
    this.logger.log({ version: release.version }, 'New pager firmware is checked and served');
    await this.removeOtherImages(fileName);
  }

  /** The release is not served: refused for good, or a download to try again later. */
  private async failed(
    restaurantId: string,
    release: ReleaseInfo,
    code: PagerFirmwareProblem,
    message: string,
    refused: boolean,
    failures: number,
  ): Promise<void> {
    const now = this.options.now();
    const problem: FirmwareProblem = {
      version: release.version,
      sha256: release.sha256,
      code,
      message: plain(message),
      at: now.toISOString(),
      refused,
      failures,
      retryAt:
        refused || code === 'NO_TRUSTED_KEY'
          ? null
          : new Date(now.getTime() + updateDownloadRetryMs(failures)).toISOString(),
    };
    await this.prisma.transaction(async (tx) => {
      await saveFirmwareProblem(tx, problem);
      if (!refused) return;
      // UPD-003: a release this PC refuses counts against its rollout.
      await saveFirmwareReport(
        tx,
        this.report(release.version, 'FAILED', `${code}: ${problem.message}`),
      );
      await this.audit.record(tx, {
        action: 'PAGER_FIRMWARE_REFUSED',
        entityType: 'pager_firmware',
        entityId: null,
        restaurantId,
        after: { version: release.version, sha256: release.sha256, problem: code },
        reason: problem.message,
      });
    });
    if (refused) {
      this.logger.error({ version: release.version, code }, `Pager firmware refused: ${message}`);
    } else {
      this.logger.warn(
        { version: release.version, code },
        `Pager firmware not fetched: ${message}`,
      );
    }
  }

  private report(version: string, outcome: UpdateReport['outcome'], error: string | null) {
    return {
      version,
      outcome,
      at: this.options.now().toISOString(),
      error: error === null ? null : error.slice(0, 300),
    } satisfies UpdateReport;
  }

  private async removeOtherImages(keep: string): Promise<void> {
    const dir = firmwareDir(this.config.dataDir);
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (name !== keep && /^rp-pager-.+\.bin(\.partial)?$/.test(name)) {
        await rm(join(dir, name), { force: true });
      }
    }
  }

  // ------------------------------------------------------------ the pagers

  /** A pager's heartbeat: how its offer went, then whether to offer it the firmware now. */
  private async heard(pager: Readonly<ConnectedPager>, beat: PagerHeartbeat): Promise<void> {
    if (beat.ota !== undefined) await this.otaReport(pager, beat.ota);
    await this.consider(pager);
  }

  private async otaReport(
    pager: Readonly<ConnectedPager>,
    ota: NonNullable<PagerHeartbeat['ota']>,
  ): Promise<void> {
    const key = { deviceId_version: { deviceId: pager.deviceId, version: ota.version } };
    const row = await this.prisma.pagerFirmwareUpdate.findUnique({ where: key });
    const now = this.options.now();
    const error = ota.error ?? null;
    // Only about an offer this PC made, and the latest one: a report that crossed a newer offer,
    // or about a version never offered, changes nothing (and cannot fill the audit log).
    if (row === null || (ota.attempt !== undefined && ota.attempt !== row.offers)) return;
    if (ota.state === 'ROLLED_BACK') {
      // From an offer under way or one that seemed to fail; once. After "Update now" (WAITING)
      // the old rollback the pager still reports is not news.
      if (!ROLLBACK_FROM.includes(row.state as PagerFirmwareState)) return;
      await this.prisma.transaction(async (tx) => {
        await this.setState(row, 'ROLLED_BACK', error, now, tx);
        // UPD-003: the vendor's rollout halts when rollbacks spread across PCs.
        await saveFirmwareReport(tx, this.report(ota.version, 'ROLLED_BACK', error));
        await this.audit.record(tx, {
          action: 'PAGER_FIRMWARE_ROLLED_BACK',
          entityType: 'device',
          entityId: pager.deviceId,
          restaurantId: pager.restaurantId,
          after: { version: ota.version },
          reason: error,
        });
      });
      this.logger.warn(
        { deviceId: pager.deviceId, version: ota.version },
        'A pager rolled back from new firmware',
      );
      return;
    }
    if (!IN_PROGRESS.includes(row.state as PagerFirmwareState)) return;
    if (ota.state === 'DOWNLOADING') {
      if (row.state === 'OFFERED') await this.setState(row, 'DOWNLOADING', null, now);
      return;
    }
    await this.setState(row, 'FAILED', error ?? 'The pager could not update.', now);
  }

  private setState(
    row: PagerFirmwareUpdate,
    state: PagerFirmwareState,
    lastError: string | null,
    now: Date,
    client: PrismaService | TransactionClient = this.prisma,
  ) {
    return client.pagerFirmwareUpdate.update({
      where: { id: row.id },
      data: { state, lastError, changedAt: now },
    });
  }

  /** Decides one pager at a time, in turn. */
  private consider(pager: Readonly<ConnectedPager>): Promise<void> {
    const next = this.queue.then(() => this.decide(pager));
    this.queue = next.catch((error: unknown) => {
      this.logger.error({ err: error, deviceId: pager.deviceId }, 'A pager firmware offer failed');
    });
    return this.queue.then(() => undefined);
  }

  private async decide(pager: Readonly<ConnectedPager>): Promise<void> {
    const served = await readServedFirmware(this.prisma);
    if (served === null || this.stopped) return;
    const now = this.options.now();
    // Most heartbeats come from pagers that run it: settle those without reading the rest.
    const runs = await this.prisma.device.findUnique({
      where: { id: pager.deviceId },
      select: { firmwareVersion: true },
    });
    if (
      runs?.firmwareVersion !== null &&
      runs?.firmwareVersion !== undefined &&
      !isNewerVersion(served.version, runs.firmwareVersion)
    ) {
      await this.prisma.pagerFirmwareUpdate.updateMany({
        where: { deviceId: pager.deviceId, version: served.version, state: { not: 'UPDATED' } },
        data: { state: 'UPDATED', lastError: null, changedAt: now },
      });
      return;
    }
    const offer = await readOfferedFirmware(this.prisma);
    const facts = await this.factsOf(pager.restaurantId, served);
    const device = facts.devices.get(pager.deviceId);
    if (device === undefined) return;
    const row = facts.rows.get(pager.deviceId) ?? null;
    if (
      row !== null &&
      IN_PROGRESS.includes(row.state as PagerFirmwareState) &&
      !underWay(row, now)
    ) {
      await this.setState(row, 'FAILED', 'The pager did not finish the update in time.', now);
      return;
    }
    const verdict = this.verdictOf(device, row, facts, served, now);
    if (verdict.kind === 'UP_TO_DATE') {
      if (row !== null && row.state !== 'UPDATED') await this.setState(row, 'UPDATED', null, now);
      return;
    }
    // UPD-003: the vendor halted the rollout of this version: no pager is offered it any more.
    if (verdict.kind !== 'OFFER' || isHalted(offer, served)) return;
    await this.offer(pager, served, row, now);
  }

  private async offer(
    pager: Readonly<ConnectedPager>,
    served: ServedFirmware,
    row: PagerFirmwareUpdate | null,
    now: Date,
  ): Promise<void> {
    // `attempt` numbers every offer of this version to this pager, also across "Update now", so a
    // report about an earlier offer is never taken for this one.
    const attempt = (row?.offers ?? 0) + 1;
    const attempts = (row?.attempts ?? 0) + 1;
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now.getTime() + this.options.tokenTtlMs;
    this.forgetExpired(now.getTime());
    this.grants.set(token, {
      deviceId: pager.deviceId,
      version: served.version,
      attempt,
      expiresAt,
    });
    const message: PagerFirmwareOffer = {
      version: served.version,
      attempt,
      port: this.tls.listeningPort(),
      path: `/api/v1/pager-firmware/${token}`,
      sha256: served.sha256,
      sizeBytes: served.sizeBytes,
      expiresAt: new Date(expiresAt).toISOString(),
    };
    if (!(await this.broker.offerFirmware(pager.deviceId, message))) {
      this.grants.delete(token);
      return;
    }
    await this.prisma.pagerFirmwareUpdate.upsert({
      where: { deviceId_version: { deviceId: pager.deviceId, version: served.version } },
      create: {
        restaurantId: pager.restaurantId,
        deviceId: pager.deviceId,
        version: served.version,
        state: 'OFFERED',
        attempts,
        offers: attempt,
        changedAt: now,
      },
      update: { state: 'OFFERED', attempts, offers: attempt, lastError: null, changedAt: now },
    });
    this.logger.log(
      { deviceId: pager.deviceId, version: served.version, attempt },
      'Pager firmware offered',
    );
  }

  private forgetExpired(now: number): void {
    for (const [token, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(token);
    }
  }

  /** What the verdict needs about the restaurant's pagers, read once. */
  private async factsOf(restaurantId: string, served: ServedFirmware) {
    const [restaurant, settings, pagers, rows, alerts] = await Promise.all([
      this.prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { timeZone: true },
      }),
      this.settings.snapshot(restaurantId),
      this.prisma.device.findMany({
        where: { restaurantId, type: 'PAGER', status: 'ACTIVE' },
        orderBy: { name: 'asc' },
      }),
      this.prisma.pagerFirmwareUpdate.findMany({
        where: { restaurantId, version: served.version },
      }),
      this.prisma.alert.findMany({
        where: { restaurantId, status: 'OPEN' },
        select: { recipientIds: true, channels: true, escalatedTo: true },
      }),
    ]);
    const now = this.options.now();
    return {
      devices: new Map(pagers.map((pager) => [pager.id, pager])),
      rows: new Map(rows.map((row) => [row.deviceId, row])),
      alerts,
      inWindow: inTimeWindow(
        timeOfDayOf(now, restaurant?.timeZone ?? DEFAULT_TIME_ZONE),
        settings.get('updates.maintenanceWindow'),
      ),
      connected: new Set(this.broker.connectedPagers().map((pager) => pager.deviceId)),
    };
  }

  private verdictOf(
    device: Device,
    row: PagerFirmwareUpdate | null,
    facts: Awaited<ReturnType<PagerFirmwareService['factsOf']>>,
    served: ServedFirmware,
    now: Date,
  ): PagerFirmwareVerdict {
    const staffId = device.staffId;
    const updatingNow = [...facts.rows.values()].filter(
      (other) => other.deviceId !== device.id && underWay(other, now),
    ).length;
    return pagerFirmwareVerdict({
      pager: {
        connected: facts.connected.has(device.id),
        firmware: device.firmwareVersion,
        batteryPercent: device.batteryPercent,
        charging: device.charging ?? false,
        worn: staffId !== null,
        openAlerts:
          staffId === null
            ? 0
            : facts.alerts.filter((alert) => reachesPagerAndApp(alert, staffId)).length,
      },
      served: served.version,
      attempt: attemptOf(row),
      now,
      inMaintenanceWindow: facts.inWindow,
      updatingNow,
    });
  }

  // ------------------------------------------------------------ the manager and the pager's download

  /** The Pagers page's firmware (PGR-011). */
  async status(restaurantId: string): Promise<PagerFirmwareResponse> {
    const [served, offer, problem] = await Promise.all([
      readServedFirmware(this.prisma),
      readOfferedFirmware(this.prisma),
      readFirmwareProblem(this.prisma),
    ]);
    const release = offer.update;
    const incoming =
      release?.component === 'PAGER_FIRMWARE' &&
      (served === null || isNewerVersion(release.version, served.version))
        ? {
            version: release.version,
            problem:
              problem !== null &&
              problem.version === release.version &&
              problem.sha256 === release.sha256
                ? {
                    code: problem.code,
                    message: problem.message,
                    at: problem.at,
                    refused: problem.refused,
                  }
                : null,
          }
        : null;
    if (served === null) return { firmware: null, incoming, pagers: [] };
    const facts = await this.factsOf(restaurantId, served);
    const now = this.options.now();
    return {
      firmware: {
        version: served.version,
        sha256: served.sha256,
        sizeBytes: served.sizeBytes,
        acceptedAt: served.acceptedAt,
        halted: isHalted(offer, served),
      },
      incoming,
      pagers: [...facts.devices.values()].map((device) =>
        this.viewOf(device, facts.rows.get(device.id) ?? null, facts, served, now),
      ),
    };
  }

  private viewOf(
    device: Device,
    row: PagerFirmwareUpdate | null,
    facts: Awaited<ReturnType<PagerFirmwareService['factsOf']>>,
    served: ServedFirmware,
    now: Date,
  ): PagerFirmwarePagerView {
    const verdict = this.verdictOf(device, row, facts, served, now);
    const status =
      verdict.kind === 'UP_TO_DATE'
        ? 'UP_TO_DATE'
        : verdict.kind === 'IN_PROGRESS'
          ? 'UPDATING'
          : verdict.kind === 'GAVE_UP'
            ? 'GAVE_UP'
            : 'WAITING';
    return {
      deviceId: device.id,
      status,
      waitFor: verdict.kind === 'WAIT' ? verdict.waitFor : null,
      attempts: row?.attempts ?? 0,
      rolledBack: row?.state === 'ROLLED_BACK',
      error: status === 'UP_TO_DATE' ? null : (row?.lastError ?? null),
      requested: row?.requestedAt !== null && row?.requestedAt !== undefined,
    };
  }

  /**
   * UPD-004: "Update now" for one pager. It is offered the firmware outside the maintenance
   * window as soon as it is free; a pager given up on is tried again from the start. Audited.
   */
  async requestNow(principal: Principal, deviceId: string): Promise<PagerFirmwarePagerView> {
    const [served, offer] = await Promise.all([
      readServedFirmware(this.prisma),
      readOfferedFirmware(this.prisma),
    ]);
    if (served === null) {
      throw new AppError(409, 'NO_PAGER_FIRMWARE', 'This PC has no pager firmware to update to.');
    }
    if (isHalted(offer, served)) {
      throw new AppError(
        409,
        'PAGER_FIRMWARE_HALTED',
        `The vendor halted the rollout of pager firmware ${served.version}.`,
      );
    }
    const device = await this.prisma.device.findFirst({
      where: {
        id: deviceId,
        restaurantId: principal.restaurantId,
        type: 'PAGER',
        status: 'ACTIVE',
      },
    });
    if (device === null) throw new AppError(404, 'PAGER_NOT_FOUND', 'There is no such pager.');
    if (
      device.firmwareVersion !== null &&
      !isNewerVersion(served.version, device.firmwareVersion)
    ) {
      throw new AppError(
        409,
        'PAGER_FIRMWARE_CURRENT',
        `This pager already runs firmware ${device.firmwareVersion}.`,
      );
    }
    const now = this.options.now();
    await this.prisma.transaction(async (tx) => {
      const key = { deviceId_version: { deviceId, version: served.version } };
      const row = await tx.pagerFirmwareUpdate.findUnique({ where: key });
      const busy = underWay(row, now);
      const requested = { requestedAt: now, requestedById: principal.staffId };
      await tx.pagerFirmwareUpdate.upsert({
        where: key,
        create: {
          restaurantId: principal.restaurantId,
          deviceId,
          version: served.version,
          state: 'WAITING',
          attempts: 0,
          changedAt: now,
          ...requested,
        },
        // An offer under way keeps going; anything else starts again.
        update: busy
          ? requested
          : { ...requested, state: 'WAITING', attempts: 0, lastError: null, changedAt: now },
      });
      await this.audit.record(tx, {
        action: 'PAGER_FIRMWARE_UPDATE_REQUESTED',
        entityType: 'device',
        entityId: deviceId,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        before: { firmware: device.firmwareVersion, state: row?.state ?? null },
        after: { version: served.version },
        reason: 'Update now',
      });
    });
    const connected = this.broker.connectedPagers().find((pager) => pager.deviceId === deviceId);
    if (connected !== undefined) await this.consider(connected);
    const facts = await this.factsOf(principal.restaurantId, served);
    const fresh = facts.devices.get(deviceId) ?? device;
    return this.viewOf(fresh, facts.rows.get(deviceId) ?? null, facts, served, this.options.now());
  }

  /**
   * The image for a pager's download token (PGR-011), or undefined when the token is unknown,
   * expired or for firmware this PC no longer serves. Marks the pager's update as downloading.
   */
  async download(token: string): Promise<{ path: string; version: string } | undefined> {
    const grant = this.grants.get(token);
    const now = this.options.now();
    if (grant === undefined || grant.expiresAt <= now.getTime()) return undefined;
    const served = await readServedFirmware(this.prisma);
    if (served?.version !== grant.version) return undefined;
    const row = await this.prisma.pagerFirmwareUpdate.findUnique({
      where: { deviceId_version: { deviceId: grant.deviceId, version: grant.version } },
    });
    if (row?.state === 'OFFERED' && row.offers === grant.attempt) {
      await this.setState(row, 'DOWNLOADING', null, now);
    }
    this.logger.log(
      { deviceId: grant.deviceId, version: grant.version },
      'A pager downloads its firmware',
    );
    return {
      path: join(firmwareDir(this.config.dataDir), served.fileName),
      version: served.version,
    };
  }
}
