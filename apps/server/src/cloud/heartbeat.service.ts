import { statfs } from 'node:fs/promises';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { HeartbeatRequest, ReleaseInfo } from '@rp/contracts/control-plane';
import { AuditService } from '../audit/audit.service.js';
import { SECRET_STORE, type SecretStore } from '../auth/secret-store.js';
import { newId } from '../common/ids.js';
import { SERVER_PACKAGE } from '../common/package-version.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { ControlPlaneClient, ControlPlaneError } from './control-plane-client.js';
import { readEnrolment, readOfferedUpdate, saveOfferedUpdate } from './control-plane-state.js';
import { installationKey } from './installation-key.js';

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

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(CONTROL_PLANE_OPTIONS) private readonly options: ControlPlaneOptions,
  ) {
    this.intervalMs = options.defaultIntervalMs;
  }

  onApplicationBootstrap(): void {
    if (this.config.controlPlaneUrl === undefined) return;
    this.schedule(this.options.firstHeartbeatDelayMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
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
      const answer = await this.client.heartbeat(enrolment.installationId, await this.collect());
      this.intervalMs = answer.nextHeartbeatSeconds * 1_000;
      await this.offer(answer.update);
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

  private async collect(): Promise<HeartbeatRequest> {
    const [head, devices, disk, postgres] = await Promise.all([
      this.audit.chainHead(),
      this.deviceCounts(),
      this.disk(),
      this.postgresVersion(),
    ]);
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
      devices,
    };
  }

  private async deviceCounts(): Promise<Record<string, number>> {
    const groups = await this.prisma.device.groupBy({
      by: ['type'],
      where: { status: 'ACTIVE' },
      _count: { _all: true },
    });
    return Object.fromEntries(groups.map((group) => [group.type, group._count._all]));
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
