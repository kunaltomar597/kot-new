import { createHash } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { BusinessHours } from '@rp/contracts';
import type { HeartbeatRequest, HeartbeatResponse, ReleaseInfo } from '@rp/contracts/control-plane';
import { updateSigningOf } from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import { SECRET_STORE, type SecretStore } from '../auth/secret-store.js';
import { newId } from '../common/ids.js';
import { backupKeyId } from '../backups/backup-file.js';
import { backupSummary, cloudBackupSummary } from '../backups/backup-state.js';
import { readRestoreCodesSeen } from '../backups/escrow-state.js';
import { SERVER_PACKAGE } from '../common/package-version.js';
import { SettingsService } from '../settings/settings.service.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { ControlPlaneClient, ControlPlaneError } from './control-plane-client.js';
import {
  readEnrolment,
  readOfferedUpdate,
  readVendorSettingsDigest,
  saveOfferedUpdate,
} from './control-plane-state.js';
import { LicenceAgentService } from '../licensing/licence-agent.service.js';
import { ErrorCounter } from '../observability/error-reporter.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import { readRelayCredential, saveRelayCredential } from '../relay/relay-credential.js';
import { installationKey } from './installation-key.js';
import { markUpdateReportDelivered, readUpdateReport } from '../updates/update-state.js';
import {
  firmwareHeartbeat,
  markFirmwareReportDelivered,
  saveOfferedFirmware,
} from '../pager-firmware/firmware-state.js';

export const CONTROL_PLANE_OPTIONS = Symbol('CONTROL_PLANE_OPTIONS');

export interface ControlPlaneOptions {
  /** Wait after start-up before the first heartbeat (let the server settle). */
  readonly firstHeartbeatDelayMs: number;
  /** Interval until the Control Plane sets one, and after failures (VCP-005: 5 minutes). */
  readonly defaultIntervalMs: number;
  readonly requestTimeoutMs: number;
  /** Replaces `fetch` (tests). */
  readonly fetch?: typeof fetch;
}

export const DEFAULT_CONTROL_PLANE_OPTIONS: ControlPlaneOptions = {
  firstHeartbeatDelayMs: 15_000,
  defaultIntervalMs: 300_000,
  requestTimeoutMs: 15_000,
};

/** What the server knows about its connection to the Control Plane (support screen, P7-08). */
export interface ControlPlaneStatus {
  readonly configured: boolean;
  readonly installationId: string | null;
  readonly lastSuccessAt: Date | null;
  /** `NOT_ENROLLED`, `UNREACHABLE`, an `ApiError.code` such as `INSTALLATION_REVOKED`, or null. */
  readonly lastError: string | null;
  /** The release the Control Plane offers (UPD-002), or null when up to date. */
  readonly offeredUpdate: ReleaseInfo | null;
  /** The Control Plane's clock minus this PC's, from the last answer (LIC-007). */
  readonly clockOffsetMs: number | null;
}

/**
 * Reports to the Vendor Control Plane every few minutes (VCP-005, NFR-O03): versions, disk, the
 * audit chain head and device counts, signed with the installation key (ADR-0012). It learns the
 * next interval and any update to install from each answer. Failures are logged and retried; the
 * restaurant never waits on the cloud (NFR-A01).
 */
@Injectable()
export class HeartbeatService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(HeartbeatService.name);
  private client: ControlPlaneClient | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<ControlPlaneStatus> | undefined;
  private stopped = false;
  private intervalMs: number;
  private state: Omit<ControlPlaneStatus, 'configured'> = {
    installationId: null,
    lastSuccessAt: null,
    lastError: null,
    offeredUpdate: null,
    clockOffsetMs: null,
  };
  /** The Control Plane's last audit check, answered with the next heartbeat (AUD-003). */
  private auditCheck: { sequence: number } | null = null;
  /** The error count at the last heartbeat delivered: the next one reports those since. */
  private errorsDelivered = 0;
  /** Services that act on each answer (support's diagnostics requests, P7-08b). */
  private readonly answerListeners: ((answer: HeartbeatResponse) => Promise<void>)[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(CONTROL_PLANE_OPTIONS) private readonly options: ControlPlaneOptions,
    private readonly licence: LicenceAgentService,
    private readonly errors: ErrorCounter,
    private readonly realtime: RealtimeGateway,
    private readonly settings: SettingsService,
  ) {
    this.intervalMs = options.defaultIntervalMs;
  }

  onApplicationBootstrap(): void {
    if (this.config.controlPlaneUrl === undefined) return;
    // "Check now" on the Owner's licence page sends a heartbeat at once (LIC-006).
    this.licence.onCheckRequested(() => this.beat());
    this.schedule(this.options.firstHeartbeatDelayMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** Calls `listener` with every answer received; its failures are logged, never thrown. */
  onAnswer(listener: (answer: HeartbeatResponse) => Promise<void>): void {
    this.answerListeners.push(listener);
  }

  status(): ControlPlaneStatus {
    return { configured: this.config.controlPlaneUrl !== undefined, ...this.state };
  }

  /** Sends one heartbeat now (the schedule calls it; so can support tools). Never throws. */
  beat(): Promise<ControlPlaneStatus> {
    this.running ??= this.send().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.beat().finally(() => {
        this.schedule(this.intervalMs);
      });
    }, delayMs);
    this.timer.unref();
  }

  private async send(): Promise<ControlPlaneStatus> {
    const baseUrl = this.config.controlPlaneUrl;
    if (baseUrl === undefined) return this.status();
    try {
      const enrolment = await readEnrolment(this.prisma);
      if (enrolment === undefined) {
        this.fail('NOT_ENROLLED', 'This PC is not enrolled with the Control Plane yet');
        return this.status();
      }
      this.state = { ...this.state, installationId: enrolment.installationId };
      this.client ??= new ControlPlaneClient({
        baseUrl,
        key: await installationKey(this.secrets),
        timeoutMs: this.options.requestTimeoutMs,
        ...(this.options.fetch !== undefined && { fetch: this.options.fetch }),
      });
      const errorsNow = this.errors.total;
      const heartbeat = await this.collect(errorsNow);
      const answer = await this.client.heartbeat(enrolment.installationId, heartbeat);
      // The install outcome rode on this heartbeat: it is not sent again (P7-04c).
      const report = heartbeat.updateReport ?? null;
      if (report !== null) await markUpdateReportDelivered(this.prisma, report);
      // So did the pager firmware's (P2-04b); and the firmware on offer is kept for the service.
      const firmwareReport = heartbeat.pagerFirmware?.report ?? null;
      if (firmwareReport !== null) await markFirmwareReportDelivered(this.prisma, firmwareReport);
      if (answer.pagerFirmware !== null) {
        await saveOfferedFirmware(this.prisma, {
          ...answer.pagerFirmware,
          forVersion: heartbeat.pagerFirmware?.version ?? null,
        });
      }
      this.intervalMs = answer.nextHeartbeatSeconds * 1_000;
      this.errorsDelivered = errorsNow;
      this.auditCheck = answer.auditCheck;
      await this.offer(answer.update);
      // A renewed licence, the reactivation secret and the clock check (LIC-002, LIC-007); the
      // tamper events and the reactivation code this heartbeat carried are delivered.
      await this.licence.accept(answer, heartbeat);
      // The QR relay credential the vendor provisioned (VCP-002), kept sealed.
      if (answer.relayCredential !== null) {
        await saveRelayCredential(this.prisma, this.secrets, answer.relayCredential);
        this.logger.log('The QR relay credential arrived from the Control Plane');
      }
      for (const listener of this.answerListeners) {
        await listener(answer).catch((error: unknown) => {
          this.logger.warn({ err: error }, 'Acting on the Control Plane’s answer failed');
        });
      }
      if (this.state.lastError !== null) {
        this.logger.log('Reporting to the Control Plane again');
      }
      this.state = {
        ...this.state,
        lastSuccessAt: new Date(),
        lastError: null,
        offeredUpdate: answer.update,
        clockOffsetMs: Date.parse(answer.serverTime) - Date.now(),
      };
    } catch (error) {
      // After a failure, try again at the default interval (the answer set none).
      this.intervalMs = this.options.defaultIntervalMs;
      const code = error instanceof ControlPlaneError ? error.code : 'INTERNAL';
      this.fail(code, error instanceof Error ? error.message : String(error), error);
    }
    return this.status();
  }

  /**
   * A signed connection to the Control Plane for other services (AI menu import, P6-04), or the
   * reason there is none: not configured, or this PC not enrolled.
   */
  async connection(): Promise<
    | { readonly client: ControlPlaneClient; readonly installationId: string }
    | { readonly unavailable: 'NOT_CONFIGURED' | 'NOT_ENROLLED' }
  > {
    const baseUrl = this.config.controlPlaneUrl;
    if (baseUrl === undefined) return { unavailable: 'NOT_CONFIGURED' };
    const enrolment = await readEnrolment(this.prisma);
    if (enrolment === undefined) return { unavailable: 'NOT_ENROLLED' };
    this.client ??= new ControlPlaneClient({
      baseUrl,
      key: await installationKey(this.secrets),
      timeoutMs: this.options.requestTimeoutMs,
      ...(this.options.fetch !== undefined && { fetch: this.options.fetch }),
    });
    return { client: this.client, installationId: enrolment.installationId };
  }

  /** The Owner's `backups.cloudEnabled` (on by default, DATA-003). */
  private async cloudBackupEnabled(): Promise<boolean> {
    const restaurant = await this.prisma.restaurant.findFirst({ select: { id: true } });
    if (restaurant === null) return true;
    return (await this.settings.snapshot(restaurant.id)).get('backups.cloudEnabled');
  }

  /** Logs only when the failure changes, so an offline site does not flood the log. */
  private fail(code: string, message: string, error?: unknown): void {
    if (this.state.lastError !== code) {
      this.logger.warn({ code, err: error }, `Heartbeat not delivered: ${message}`);
    }
    this.state = { ...this.state, lastError: code };
  }

  /** Remembers the offered release (across restarts) and says so once when it changes. */
  private async offer(update: ReleaseInfo | null): Promise<void> {
    const previous = await readOfferedUpdate(this.prisma);
    if (previous?.version === update?.version && previous?.channel === update?.channel) return;
    await saveOfferedUpdate(this.prisma, update);
    if (update !== null) {
      this.logger.log(
        { version: update.version, channel: update.channel },
        'The Control Plane offers an update',
      );
    }
  }

  private async collect(errorsNow: number): Promise<HeartbeatRequest> {
    const check = this.auditCheck;
    const [
      head,
      devices,
      disk,
      postgres,
      licence,
      relayCredential,
      restaurant,
      checkpoint,
      settingsDigest,
      backup,
      cloud,
      cloudEnabled,
      restoreCodesSeen,
      updateReport,
      pagerFirmware,
    ] = await Promise.all([
      this.audit.chainHead(),
      this.deviceHealth(),
      this.disk(),
      this.postgresVersion(),
      this.licence.heartbeatReport(),
      readRelayCredential(this.prisma, this.secrets).catch(() => undefined),
      this.prisma.restaurant.findFirst({ select: { businessHours: true, timeZone: true } }),
      check === null ? undefined : this.audit.checkpoint(check.sequence),
      readVendorSettingsDigest(this.prisma),
      backupSummary(this.prisma),
      cloudBackupSummary(this.prisma),
      this.cloudBackupEnabled(),
      readRestoreCodesSeen(this.prisma),
      readUpdateReport(this.prisma),
      firmwareHeartbeat(this.prisma),
    ]);
    const hours = BusinessHours.safeParse(restaurant?.businessHours);
    return {
      heartbeatId: newId(),
      sentAt: new Date().toISOString(),
      components: [
        { name: 'RESTAURANT_PC', version: this.config.productVersion ?? SERVER_PACKAGE.version },
        { name: 'server', version: SERVER_PACKAGE.version },
        { name: 'node', version: process.versions.node },
        ...(postgres === null ? [] : [{ name: 'postgres', version: postgres }]),
      ],
      disk,
      auditChainHead: head === null ? null : { sequence: head.seq, hash: head.hash },
      devices: devices.paired,
      // Fleet health (VCP-005, NFR-O03, P7-03), with the backups (DATA-005, P7-05a).
      devicesConnected: devices.connected,
      errorCount: Math.max(0, errorsNow - this.errorsDelivered),
      backup: {
        lastSuccessAt: backup.lastSuccessAt?.toISOString() ?? null,
        lastFailureAt: backup.lastFailureAt?.toISOString() ?? null,
        lastError: backup.lastError,
        // DATA-003: the cloud copy, and whether the Owner opted out (P7-05d).
        cloud: {
          enabled: cloudEnabled,
          lastSuccessAt: cloud.lastSuccessAt?.toISOString() ?? null,
          lastFailureAt: cloud.lastFailureAt?.toISOString() ?? null,
          lastError: cloud.lastError,
        },
      },
      ...(restaurant !== null &&
        hours.success && {
          businessHours: { timeZone: restaurant.timeZone, hours: hours.data },
        }),
      ...(checkpoint !== undefined && { auditCheckpoint: checkpoint }),
      // The vendor settings this PC holds; new ones come until it does (UPD-010).
      vendorSettings: { digest: settingsDigest },
      // The backup key to escrow (P7-05e): none while the Owner opted out of the cloud backup.
      backupKeyId: cloudEnabled ? backupKeyId(await this.secrets.get('backup-key')) : null,
      restoreCodesSeen,
      // How the last update went (UPD-003, P7-04c), until a heartbeat carrying it is answered.
      ...(updateReport !== null && { updateReport }),
      // Whether this PC takes unsigned updates, a test build the vendor is alerted to (UPD-007).
      updateSigning: updateSigningOf({
        publisher: this.config.updatePublisher ?? null,
        allowUnsigned: this.config.updateAllowUnsigned,
      }),
      // The pager firmware this PC passes on, and how its last release went (PGR-011, P2-04b).
      pagerFirmware,
      ...licence,
      relay: {
        credentialDigest:
          relayCredential === undefined
            ? null
            : createHash('sha256').update(relayCredential, 'utf8').digest('hex').slice(0, 16),
      },
    };
  }

  /**
   * Paired devices by type, and how many are connected now: a pager by its heartbeats, an app by
   * its socket (as on the Devices page).
   */
  private async deviceHealth(): Promise<{
    paired: Record<string, number>;
    connected: Record<string, number>;
  }> {
    const rows = await this.prisma.device.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, type: true, online: true, restaurantId: true },
    });
    const paired: Record<string, number> = {};
    const connected: Record<string, number> = {};
    const sockets = new Map<string, ReadonlySet<string>>();
    for (const row of rows) {
      let ids = sockets.get(row.restaurantId);
      if (ids === undefined) {
        ids = this.realtime.connectedDeviceIds(row.restaurantId);
        sockets.set(row.restaurantId, ids);
      }
      paired[row.type] = (paired[row.type] ?? 0) + 1;
      const isConnected = row.type === 'PAGER' ? row.online : ids.has(row.id);
      connected[row.type] = (connected[row.type] ?? 0) + (isConnected ? 1 : 0);
    }
    return { paired, connected };
  }

  /** Size and free space of the data drive (ONB-002); null when it cannot be read. */
  private async disk(): Promise<HeartbeatRequest['disk']> {
    try {
      const stats = await statfs(this.config.dataDir);
      return {
        totalBytes: stats.blocks * stats.bsize,
        freeBytes: stats.bavail * stats.bsize,
      };
    } catch {
      return null;
    }
  }

  private async postgresVersion(): Promise<string | null> {
    try {
      const [row] = await this.prisma.$queryRaw<{ server_version: string }[]>`SHOW server_version`;
      return row?.server_version.split(' ')[0]?.slice(0, 64) ?? null;
    } catch {
      return null;
    }
  }
}
