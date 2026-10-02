import { arch, cpus, platform, release, totalmem, uptime } from 'node:os';
import { join } from 'node:path';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { SendDiagnosticsResponse } from '@rp/contracts';
import type { PendingDiagnosticsRequest } from '@rp/contracts/control-plane';
import { DiagnosticsBundle } from '@rp/contracts/control-plane';
import { scrubValue } from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { ControlPlaneError } from '../cloud/control-plane-client.js';
import { readDiagnosticsRequests, saveDiagnosticsRequests } from '../cloud/control-plane-state.js';
import { HeartbeatService } from '../cloud/heartbeat.service.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { readLogTail } from './log-tail.js';
import { SystemService } from './system.service.js';

/** The vendor could not be reached (or refused): what the manager is told. */
function unreachable(error: unknown): unknown {
  if (!(error instanceof ControlPlaneError)) return error;
  return new AppError(
    503,
    'CONTROL_PLANE_UNREACHABLE',
    'The vendor could not be reached. Check the internet connection and try again.',
    { code: error.code },
  );
}

/** Only the origin of a configured address: never a path, query or credentials. */
function originOf(url: string | undefined): string | null {
  if (url === undefined) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * "Send diagnostics to support" (UPD-008, P7-08a): versions, configuration without secrets, the
 * device list, the System page's status and the tail of the logs, all scrubbed of secrets and
 * personal data. The manager can see the bundle before sending it; sending is audited.
 */
@Injectable()
export class DiagnosticsService implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly system: SystemService,
    private readonly heartbeat: HeartbeatService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.heartbeat.onAnswer((answer) => this.received(answer.diagnosticsRequests));
  }

  // ------------------------------------------------- support's requests (P7-08b)

  /**
   * Support's open requests from a heartbeat answer: kept for the System page; a new one alerts
   * the Owner and the managers on duty, and one no longer open clears its alert.
   */
  async received(requests: readonly PendingDiagnosticsRequest[]): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      const before = await readDiagnosticsRequests(tx);
      await saveDiagnosticsRequests(tx, requests);
      const restaurant = await tx.restaurant.findFirst({ select: { id: true } });
      if (restaurant === null) return;
      for (const request of requests) {
        if (before.some((known) => known.id === request.id)) continue;
        await this.notifications.raise(tx, {
          restaurantId: restaurant.id,
          type: 'SUPPORT_REQUEST',
          dedupeKey: `support-request:${request.id}`,
          payload: {
            requestId: request.id,
            requestedBy: request.requestedBy,
            reason: request.reason,
          },
        });
      }
      for (const gone of before.filter(
        (known) => !requests.some((request) => request.id === known.id),
      )) {
        await this.notifications.clear(tx, {
          restaurantId: restaurant.id,
          dedupeKey: `support-request:${gone.id}`,
        });
      }
    });
  }

  /** The open requests, without any that lapsed since the last heartbeat. */
  async requests(now = new Date()): Promise<PendingDiagnosticsRequest[]> {
    return (await readDiagnosticsRequests(this.prisma)).filter(
      (request) => Date.parse(request.expiresAt) > now.getTime(),
    );
  }

  private async answered(restaurantId: string, requestId: string): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      const left = (await readDiagnosticsRequests(tx)).filter(
        (request) => request.id !== requestId,
      );
      await saveDiagnosticsRequests(tx, left);
      await this.notifications.clear(tx, {
        restaurantId,
        dedupeKey: `support-request:${requestId}`,
      });
    });
  }

  private async openRequest(id: string): Promise<PendingDiagnosticsRequest> {
    const request = (await this.requests()).find((candidate) => candidate.id === id);
    if (request === undefined) {
      throw new AppError(404, 'NOT_FOUND', 'Support’s request is no longer open.');
    }
    return request;
  }

  /** Allows support's request: the bundle is sent for it (audited with the request). */
  async allow(principal: Principal, id: string): Promise<SendDiagnosticsResponse> {
    const request = await this.openRequest(id);
    try {
      return await this.send(principal, null, request.id);
    } catch (error) {
      // Closed at the vendor: stop showing it. Any other failure keeps it for another try.
      if (error instanceof AppError && error.code === 'DIAGNOSTICS_REQUEST_CLOSED') {
        await this.answered(principal.restaurantId, id);
      }
      throw error;
    }
  }

  /** Declines support's request: nothing is sent; the vendor sees who declined. Audited. */
  async decline(principal: Principal, id: string): Promise<void> {
    const request = await this.openRequest(id);
    const connection = await this.heartbeat.connection();
    if ('unavailable' in connection) {
      throw new AppError(
        409,
        'CONTROL_PLANE_NOT_CONNECTED',
        'This PC is not connected to the vendor.',
      );
    }
    const name = await this.staffName(principal);
    try {
      await connection.client.declineDiagnosticsRequest(connection.installationId, request.id, {
        by: { name, role: principal.role },
      });
    } catch (error) {
      // Already answered or lapsed at the vendor: it is closed either way.
      if (!(error instanceof ControlPlaneError && error.status === 409)) {
        throw unreachable(error);
      }
    }
    await this.answered(principal.restaurantId, request.id);
    await this.prisma.transaction((tx) =>
      this.audit.record(tx, {
        action: 'DIAGNOSTICS_REQUEST_DECLINED',
        entityType: 'diagnostics',
        entityId: request.id,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        after: { requestedBy: request.requestedBy, reason: request.reason },
      }),
    );
  }

  private async staffName(principal: Principal): Promise<string> {
    const staff = await this.prisma.staff.findUnique({
      where: { id: principal.staffId },
      select: { displayName: true },
    });
    return staff?.displayName ?? 'Unknown';
  }

  async bundle(principal: Principal): Promise<DiagnosticsBundle> {
    const [status, devices, settings, logs] = await Promise.all([
      this.system.status(principal),
      this.prisma.device.findMany({
        where: { restaurantId: principal.restaurantId },
        select: {
          type: true,
          name: true,
          status: true,
          online: true,
          lastSeenAt: true,
          appVersion: true,
        },
        orderBy: [{ type: 'asc' }, { name: 'asc' }],
        take: 500,
      }),
      this.prisma.setting.findMany({
        where: { restaurantId: principal.restaurantId },
        select: { key: true, value: true },
      }),
      readLogTail(join(this.config.dataDir, 'logs')),
    ]);
    const { versions, ...rest } = status;
    return DiagnosticsBundle.parse({
      format: 1,
      generatedAt: new Date().toISOString(),
      installationId: this.heartbeat.status().installationId,
      versions,
      platform: {
        os: platform(),
        release: release(),
        arch: arch(),
        cpus: cpus().length,
        memoryMb: Math.round(totalmem() / 1_048_576),
        uptimeSeconds: Math.floor(uptime()),
        serverUptimeSeconds: Math.floor(process.uptime()),
      },
      // An allow-list: secrets, keys and the database address are never read here.
      configuration: {
        nodeEnv: this.config.nodeEnv,
        port: this.config.port,
        logLevel: this.config.logLevel,
        dataDir: this.config.dataDir,
        consoleServed: this.config.consoleDir !== undefined,
        controlPlane: originOf(this.config.controlPlaneUrl),
        qrRelay: originOf(this.config.relayUrl),
        qrSite: originOf(this.config.qrSiteUrl),
        productVersion: this.config.productVersion ?? null,
        buildId: this.config.buildId ?? null,
        mqtt: this.config.mqtt,
        mqttPort: this.config.mqttPort,
        tls: this.config.tls,
        licenceEnforced: this.config.licenceEnforce,
      },
      settings: scrubValue(Object.fromEntries(settings.map((row) => [row.key, row.value]))),
      status: scrubValue(rest),
      devices: devices.map((device) => ({
        ...device,
        name: String(scrubValue(device.name)),
        lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
      })),
      logs,
    });
  }

  /**
   * Makes the bundle and sends it to the Control Plane, with the manager's note and, when it
   * answers support's request, that request; audited.
   */
  async send(
    principal: Principal,
    note: string | null,
    requestId: string | null = null,
  ): Promise<SendDiagnosticsResponse> {
    const connection = await this.heartbeat.connection();
    if ('unavailable' in connection) {
      throw new AppError(
        409,
        'CONTROL_PLANE_NOT_CONNECTED',
        'This PC is not connected to the vendor yet, so diagnostics cannot be sent. Download the preview and email it to support instead.',
      );
    }
    const [bundle, name] = await Promise.all([this.bundle(principal), this.staffName(principal)]);
    let sent: { id: string; receivedAt: string };
    try {
      sent = await connection.client.uploadDiagnostics(connection.installationId, {
        bundle,
        note: note === null || note.trim() === '' ? null : note.trim(),
        sentBy: { name, role: principal.role },
        requestId,
      });
    } catch (error) {
      if (error instanceof ControlPlaneError && error.status === 409) {
        throw new AppError(
          409,
          'DIAGNOSTICS_REQUEST_CLOSED',
          'Support’s request was already answered or has lapsed. Send diagnostics yourself if support still needs them.',
        );
      }
      throw unreachable(error);
    }
    if (requestId !== null) await this.answered(principal.restaurantId, requestId);
    await this.prisma.transaction((tx) =>
      this.audit.record(tx, {
        action: 'DIAGNOSTICS_SENT',
        entityType: 'diagnostics',
        entityId: sent.id,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        after: { bundleId: sent.id, logFiles: bundle.logs.files.length, requestId },
        reason: note,
      }),
    );
    return { id: sent.id, sentAt: sent.receivedAt };
  }
}
