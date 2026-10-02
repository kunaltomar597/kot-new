import { arch, cpus, platform, release, totalmem, uptime } from 'node:os';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import type { SendDiagnosticsResponse } from '@rp/contracts';
import { DiagnosticsBundle } from '@rp/contracts/control-plane';
import { scrubValue } from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { ControlPlaneError } from '../cloud/control-plane-client.js';
import { HeartbeatService } from '../cloud/heartbeat.service.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { readLogTail } from './log-tail.js';
import { SystemService } from './system.service.js';

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
export class DiagnosticsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly system: SystemService,
    private readonly heartbeat: HeartbeatService,
    private readonly audit: AuditService,
  ) {}

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

  /** Makes the bundle and sends it to the Control Plane, with the manager's note; audited. */
  async send(principal: Principal, note: string | null): Promise<SendDiagnosticsResponse> {
    const connection = await this.heartbeat.connection();
    if ('unavailable' in connection) {
      throw new AppError(
        409,
        'CONTROL_PLANE_NOT_CONNECTED',
        'This PC is not connected to the vendor yet, so diagnostics cannot be sent. Download the preview and email it to support instead.',
      );
    }
    const [bundle, staff] = await Promise.all([
      this.bundle(principal),
      this.prisma.staff.findUnique({
        where: { id: principal.staffId },
        select: { displayName: true },
      }),
    ]);
    let sent: { id: string; receivedAt: string };
    try {
      sent = await connection.client.uploadDiagnostics(connection.installationId, {
        bundle,
        note: note === null || note.trim() === '' ? null : note.trim(),
        sentBy: { name: staff?.displayName ?? 'Unknown', role: principal.role },
        requestId: null,
      });
    } catch (error) {
      if (error instanceof ControlPlaneError) {
        throw new AppError(
          503,
          'CONTROL_PLANE_UNREACHABLE',
          'The vendor could not be reached. Check the internet connection and try again.',
          { code: error.code },
        );
      }
      throw error;
    }
    await this.prisma.transaction((tx) =>
      this.audit.record(tx, {
        action: 'DIAGNOSTICS_SENT',
        entityType: 'diagnostics',
        entityId: sent.id,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        after: { bundleId: sent.id, logFiles: bundle.logs.files.length },
        reason: note,
      }),
    );
    return { id: sent.id, sentAt: sent.receivedAt };
  }
}
